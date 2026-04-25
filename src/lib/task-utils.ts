import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  McpServer,
  RequestTaskStore,
  ServerContext,
  Task,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { AppError } from './errors.js';
import { logger, maybeSummarizePayload } from './logger.js';
import { hasTerminalProgress, reportCompletion, reportFailure } from './progress.js';
import { extractTextContent, validateStructuredToolResult } from './response.js';
import { executor } from './tool-executor.js';

const DEFAULT_TTL = 300_000;

export const READONLY_NON_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const MUTABLE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const TASK_EXECUTION = { taskSupport: 'optional' } as const;
const taskLog = logger.child('task-utils');

type TaskContext = NonNullable<ServerContext['task']>;
type ExtendedTaskContext = TaskContext & { queue: TaskMessageQueue };
type ExtendedServerContext = ServerContext & { task?: ExtendedTaskContext };

export type TaskWork<TArgs> = (args: TArgs, ctx: ExtendedServerContext) => Promise<CallToolResult>;
export type { TaskToolConfig };

interface ToolTaskHandlers<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<CreateTaskResult>;
  getTask: (_args: TArgs, ctx: ServerContext) => Promise<GetTaskResult>;
  getTaskResult: (_args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

type RegisterToolTask = McpServer['experimental']['tasks']['registerToolTask'];
type TaskToolConfig = Omit<Parameters<RegisterToolTask>[1], 'execution'>;
type TaskToolHandler = Parameters<RegisterToolTask>[2];
interface SafeParseSchema {
  safeParse: (
    value: unknown,
  ) => { success: true; data: unknown } | { success: false; error: unknown };
}
interface ParseSchema {
  parse: (value: unknown) => unknown;
}
interface JsonSchemaProvider {
  input: (options: { target: string }) => unknown;
  output?: (options: { target: string }) => unknown;
}
interface StandardSchemaLike {
  '~standard': {
    jsonSchema: JsonSchemaProvider;
    validate: (value: unknown) => { value: unknown };
  };
}

function hasSafeParse(schema: unknown): schema is SafeParseSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    'safeParse' in schema &&
    typeof schema.safeParse === 'function'
  );
}

function hasParse(schema: unknown): schema is ParseSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    'parse' in schema &&
    typeof schema.parse === 'function'
  );
}

function hasStandardSchema(schema: unknown): schema is StandardSchemaLike {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '~standard' in schema &&
    typeof schema['~standard'] === 'object' &&
    schema['~standard'] !== null
  );
}

function createSdkPassthroughInputSchema(schema: unknown): unknown {
  if (!hasStandardSchema(schema)) {
    return schema;
  }

  return {
    '~standard': {
      jsonSchema: schema['~standard'].jsonSchema,
      validate: (value: unknown) => ({ value }),
    },
  } satisfies StandardSchemaLike;
}

function parseTaskInput(schema: unknown, args: unknown): unknown {
  if (hasSafeParse(schema)) {
    const parsed = schema.safeParse(args);
    if (parsed.success) return parsed.data;
    throw parsed.error;
  }
  if (hasParse(schema)) {
    return schema.parse(args);
  }
  return args;
}

export async function elicitTaskInput(
  ctx: ServerContext,
  prompt: string,
  statusMessage = 'Waiting for user input',
): Promise<string | undefined> {
  const taskContext = ctx.task;
  if (!taskContext?.id) throw new Error('Task context or ID is unavailable.');

  await taskContext.store.updateTaskStatus(taskContext.id, 'input_required', statusMessage);

  try {
    const result = await ctx.mcpReq.elicitInput({
      mode: 'form',
      message: prompt,
      requestedSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            title: 'Response',
          },
        },
        required: ['text'],
      },
    });

    await taskContext.store.updateTaskStatus(taskContext.id, 'working');

    if (result.action !== 'accept') {
      return undefined;
    }

    const text = typeof result.content?.text === 'string' ? result.content.text.trim() : '';
    return text ? text : undefined;
  } catch (error) {
    try {
      await taskContext.store.updateTaskStatus(taskContext.id, 'working');
    } catch {
      // Ignore if the task is already terminal or the transport is gone.
    }
    throw error;
  }
}

function requireTaskContext(ctx: ServerContext | ExtendedServerContext): TaskContext {
  const taskContext = ctx.task;
  if (!taskContext) {
    throw new Error('Task context is unavailable for this tool execution.');
  }
  return taskContext;
}

async function isTaskCancelled(store: RequestTaskStore, taskId: string): Promise<boolean> {
  try {
    const current = await store.getTask(taskId);
    return current.status === 'cancelled';
  } catch {
    return false;
  }
}

function assertCallToolResult(
  result: Awaited<ReturnType<RequestTaskStore['getTaskResult']>>,
): asserts result is CallToolResult {
  if (!('content' in result)) {
    throw new Error('Task result is unavailable');
  }
}

/**
 * Runs tool work in the background and stores the result in the task store.
 * Maps `isError: true` results to `'failed'` task status.
 * Skips storing if the task has been cancelled.
 */
export function runToolAsTask(
  store: RequestTaskStore,
  task: Task,
  work: Promise<CallToolResult>,
  onStoreError?: (taskId: string, err: unknown) => void,
): void {
  const storeFailedResult = async (err: unknown, prefix = ''): Promise<void> => {
    const errorMessage = `${prefix}${err instanceof Error ? err.message : String(err)}`;
    try {
      await store.storeTaskResult(task.taskId, 'failed', {
        content: [{ type: 'text' as const, text: errorMessage }],
        isError: true,
      });
    } catch (storeErr) {
      onStoreError?.(task.taskId, storeErr);
      try {
        await store.updateTaskStatus(task.taskId, 'failed', errorMessage);
      } catch (statusErr) {
        onStoreError?.(task.taskId, statusErr);
      }
    }
  };

  work
    .then(async (result) => {
      if (await isTaskCancelled(store, task.taskId)) return;

      const status = result.isError ? 'failed' : 'completed';
      try {
        await store.storeTaskResult(task.taskId, status, result);
      } catch (storeErr) {
        onStoreError?.(task.taskId, storeErr);
        if (await isTaskCancelled(store, task.taskId)) return;
        await storeFailedResult(storeErr, 'Failed to store task result: ');
      }
    })
    .catch(async (err: unknown) => {
      if (await isTaskCancelled(store, task.taskId)) return;

      await storeFailedResult(err);
    });
}

export function taskTtl(requestedTtl: number | undefined): number {
  return requestedTtl ?? DEFAULT_TTL;
}

async function createTaskOrFail(
  ctx: ServerContext | ExtendedServerContext,
): Promise<{ task: Task; taskContext: TaskContext }> {
  const taskContext = requireTaskContext(ctx);
  const task = await taskContext.store.createTask({ ttl: taskTtl(taskContext.requestedTtl) });
  return { task, taskContext };
}

function taskFailureResult(toolName: string, err: unknown): CallToolResult {
  return AppError.from(err, toolName).toToolResult();
}

async function materializeTaskFailure(
  toolName: string,
  store: RequestTaskStore,
  task: Task,
  err: unknown,
  args?: unknown,
): Promise<void> {
  const appError = AppError.from(err, toolName);
  taskLog.error('task-create error materialized', {
    toolName,
    taskId: task.taskId,
    error: appError.message,
    ...(args === undefined
      ? {}
      : { args: maybeSummarizePayload(args, taskLog.getVerbosePayloads()) }),
  });

  await store.storeTaskResult(task.taskId, 'failed', appError.toToolResult());
}

function wrapTaskSafeWork<TArgs>(toolName: string, work: TaskWork<TArgs>): TaskWork<TArgs> {
  return async (args, ctx) => {
    try {
      return await work(args, ctx);
    } catch (err) {
      return taskFailureResult(toolName, err);
    }
  };
}

async function ensureTerminalTaskProgress(
  ctx: ServerContext,
  toolLabel: string,
  result: CallToolResult,
): Promise<CallToolResult> {
  if (hasTerminalProgress(ctx)) {
    return result;
  }

  if (result.isError) {
    await reportFailure(ctx, toolLabel, extractTextContent(result.content) || 'failed');
    return result;
  }

  await reportCompletion(ctx, toolLabel, 'completed');
  return result;
}

export function createToolTaskHandlers<TArgs>(
  toolName: string,
  work: TaskWork<TArgs>,
  taskMessageQueue: TaskMessageQueue,
  toolLabel = toolName,
  inputSchema?: unknown,
): ToolTaskHandlers<TArgs> {
  return {
    createTask: async (rawArgs, ctx) => {
      const { task, taskContext } = await createTaskOrFail(ctx);
      let args: TArgs;
      try {
        args = parseTaskInput(inputSchema, rawArgs) as TArgs;
      } catch (err) {
        await materializeTaskFailure(toolName, taskContext.store, task, err, rawArgs);
        return { task };
      }

      const taskExecutionContext: ExtendedServerContext = {
        ...ctx,
        task: {
          ...taskContext,
          id: task.taskId,
          queue: taskMessageQueue,
        },
      };
      try {
        const taskWork = work(args, taskExecutionContext)
          .then((result) => ensureTerminalTaskProgress(taskExecutionContext, toolLabel, result))
          .catch(async (err: unknown) => {
            if (!hasTerminalProgress(taskExecutionContext)) {
              await reportFailure(taskExecutionContext, toolLabel, err);
            }
            throw err;
          });
        runToolAsTask(taskContext.store, task, taskWork, (taskId, err) => {
          taskLog.error('Failed to store task result', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          void ctx.mcpReq.log(
            'error',
            `Failed to store result for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } catch (err) {
        if (!hasTerminalProgress(taskExecutionContext)) {
          await reportFailure(taskExecutionContext, toolLabel, err);
        }
        await materializeTaskFailure(toolName, taskContext.store, task, err, args);
      }

      return { task };
    },
    getTask: async (_args, ctx) => {
      const { store, id } = requireTaskContext(ctx);
      if (!id) throw new Error('Task ID is unavailable');
      return await store.getTask(id);
    },
    getTaskResult: async (_args, ctx) => {
      const { store, id } = requireTaskContext(ctx);
      if (!id) throw new Error('Task ID is unavailable');
      const result = await store.getTaskResult(id);
      assertCallToolResult(result);
      return result;
    },
  };
}

export function registerTaskTool<TArgs>(
  server: McpServer,
  name: string,
  config: TaskToolConfig,
  taskMessageQueue: TaskMessageQueue,
  work: TaskWork<TArgs>,
): void {
  const toolLabel = config.title ?? name;
  const handler = createToolTaskHandlers(
    name,
    wrapTaskSafeWork(name, async (args: TArgs, ctx: ExtendedServerContext) =>
      validateStructuredToolResult(
        name,
        config.outputSchema,
        await executor.runSilent(
          ctx,
          name,
          toolLabel,
          args,
          work as (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
        ),
      ),
    ),
    taskMessageQueue,
    toolLabel,
    config.inputSchema,
  ) as TaskToolHandler;

  server.experimental.tasks.registerToolTask(
    name,
    {
      ...config,
      inputSchema: createSdkPassthroughInputSchema(config.inputSchema),
      execution: TASK_EXECUTION,
    } as Parameters<RegisterToolTask>[1],
    handler,
  );
}

interface RegisterWorkToolParams<TArgs> {
  server: McpServer;
  tool: { name: string } & TaskToolConfig;
  queue: TaskMessageQueue;
  work: TaskWork<TArgs>;
}

export function registerWorkTool<TArgs>({
  server,
  tool,
  queue,
  work,
}: RegisterWorkToolParams<TArgs>): void {
  const { name, ...config } = tool;
  registerTaskTool<TArgs>(server, name, config, queue, work);
}
