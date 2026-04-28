import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  McpServer,
  RequestTaskStore,
  ServerContext,
  Task,
} from '@modelcontextprotocol/server';

import { getStatelessTransportFlag } from '../config.js';
import { AppError } from './errors.js';
import { logger, maybeSummarizePayload } from './logger.js';
import { hasTerminalProgress, reportCompletion, reportFailure } from './progress.js';
import { extractTextContent, validateStructuredToolResult } from './response.js';
import { executor } from './tool-executor.js';
import { getWorkSignal } from './work-signal.js';

const DEFAULT_TTL = 600_000;

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
type ExtendedTaskContext = TaskContext & {
  cancellationSignal?: AbortSignal;
};
type ExtendedServerContext = ServerContext & { task?: ExtendedTaskContext };

export { getWorkSignal };

function isTerminalStatusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('terminal status');
}

function isTaskNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

export type TaskWork<TArgs> = (args: TArgs, ctx: ExtendedServerContext) => Promise<CallToolResult>;
export type { TaskToolConfig };

export interface TaskToolOverrides {
  defaultTtlMs?: number;
}

interface ToolTaskHandlers<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<CreateTaskResult>;
  getTask: (_args: TArgs, ctx: ServerContext) => Promise<GetTaskResult>;
  getTaskResult: (_args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

type RegisterToolTask = McpServer['experimental']['tasks']['registerToolTask'];
type TaskRegistrationConfig = Parameters<RegisterToolTask>[1];
type TaskToolConfig = Omit<TaskRegistrationConfig, 'execution'>;
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
    vendor: string;
    version: number;
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

// Bypass SDK input-schema validation so schema-invalid args still record a
// `failed` task result rather than rejecting at the `tools/call` boundary.
function createSdkPassthroughInputSchema(
  schema: TaskToolConfig['inputSchema'],
): TaskRegistrationConfig['inputSchema'] {
  if (!hasStandardSchema(schema)) {
    return schema;
  }

  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      validate: (value: unknown) => ({ value }),
    },
  } satisfies StandardSchemaLike;
}

function createTaskRegistrationConfig(config: TaskToolConfig): TaskRegistrationConfig {
  return {
    ...config,
    inputSchema: createSdkPassthroughInputSchema(config.inputSchema),
    execution: TASK_EXECUTION,
  };
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
    let result;
    try {
      result = await ctx.mcpReq.elicitInput({
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
    } catch (elicitError) {
      const message = elicitError instanceof Error ? elicitError.message : String(elicitError);
      if (/client does not support elicitation/i.test(message)) {
        throw new AppError('chat', 'Elicitation is not supported by the connected client.');
      }
      throw elicitError;
    }

    await taskContext.store.updateTaskStatus(taskContext.id, 'working');

    if (result.action !== 'accept') {
      return undefined;
    }

    const text = typeof result.content?.text === 'string' ? result.content.text.trim() : '';
    return text ? text : undefined;
  } catch (error) {
    if (!(await isTaskCancelled(taskContext.store, taskContext.id))) {
      try {
        await taskContext.store.updateTaskStatus(taskContext.id, 'working');
      } catch {
        // Task is already terminal or transport is gone.
      }
    }
    throw error;
  }
}

export function bridgeTaskCancellationToSignal(
  baseSignal: AbortSignal,
  taskId: string,
  store: RequestTaskStore,
  pollIntervalMs?: number,
): AbortSignal {
  const controller = new AbortController();

  if (baseSignal.aborted) {
    controller.abort(baseSignal.reason);
    return controller.signal;
  }

  const intervalMs = Math.min(Math.max(pollIntervalMs ?? 1000, 100), 2000);
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    baseSignal.removeEventListener('abort', onBaseAbort);
  };

  const onBaseAbort = (): void => {
    cleanup();
    if (!controller.signal.aborted) controller.abort(baseSignal.reason);
  };
  baseSignal.addEventListener('abort', onBaseAbort, { once: true });

  const timer = setInterval(() => {
    void (async () => {
      try {
        const current = await store.getTask(taskId);
        if (
          current.status === 'cancelled' ||
          current.status === 'completed' ||
          current.status === 'failed'
        ) {
          cleanup();
          if (current.status === 'cancelled' && !controller.signal.aborted) {
            controller.abort(new Error(`Task ${taskId} cancelled`));
          }
        }
      } catch (error) {
        if (isTaskNotFoundError(error)) {
          cleanup();
        }
        // baseSignal still controls abort on poll errors.
      }
    })();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
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
      if (isTerminalStatusError(storeErr)) return;
      onStoreError?.(task.taskId, storeErr);
      try {
        await store.updateTaskStatus(task.taskId, 'failed', errorMessage);
      } catch (statusErr) {
        if (isTerminalStatusError(statusErr)) return;
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
        // Terminal-status writes are no-ops: the result was already recorded.
        if (isTerminalStatusError(storeErr)) return;
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

export function taskTtl(requestedTtl: number | undefined, defaultTtlMs?: number): number {
  return requestedTtl ?? defaultTtlMs ?? DEFAULT_TTL;
}

async function createTaskOrFail(
  ctx: ServerContext | ExtendedServerContext,
  defaultTtlMs?: number,
): Promise<{ task: Task; taskContext: TaskContext }> {
  const taskContext = requireTaskContext(ctx);
  const task = await taskContext.store.createTask({
    ttl: taskTtl(taskContext.requestedTtl, defaultTtlMs),
  });
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

function wrapTaskSafeWork<TArgs>(
  toolName: string,
  toolLabel: string,
  work: TaskWork<TArgs>,
): TaskWork<TArgs> {
  return async (args, ctx) => {
    try {
      return await work(args, ctx);
    } catch (err) {
      if (!hasTerminalProgress(ctx)) {
        try {
          await reportFailure(ctx, toolLabel, err);
        } catch {
          // Progress emission errors are non-fatal during failure path.
        }
      }
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
  toolLabel = toolName,
  inputSchema?: unknown,
  overrides?: TaskToolOverrides,
): ToolTaskHandlers<TArgs> {
  return {
    createTask: async (rawArgs, ctx) => {
      const { task, taskContext } = await createTaskOrFail(ctx, overrides?.defaultTtlMs);

      const cancellationSignal = bridgeTaskCancellationToSignal(
        ctx.mcpReq.signal,
        task.taskId,
        taskContext.store,
        task.pollInterval,
      );

      const taskExecutionContext: ExtendedServerContext = {
        ...ctx,
        task: {
          ...taskContext,
          id: task.taskId,
          cancellationSignal,
        },
      };

      let args: TArgs;
      try {
        args = parseTaskInput(inputSchema, rawArgs) as TArgs;
      } catch (err) {
        if (!hasTerminalProgress(taskExecutionContext)) {
          try {
            await reportFailure(taskExecutionContext, toolLabel, err);
          } catch {
            // Progress emission errors are non-fatal during failure path.
          }
        }
        await materializeTaskFailure(toolName, taskContext.store, task, err, rawArgs);
        return { task };
      }

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
  work: TaskWork<TArgs>,
  overrides?: TaskToolOverrides,
): void {
  const toolLabel = config.title ?? name;
  const handler: TaskToolHandler = createToolTaskHandlers(
    name,
    wrapTaskSafeWork(name, toolLabel, async (args: TArgs, ctx: ExtendedServerContext) =>
      validateStructuredToolResult(
        name,
        config.outputSchema,
        await executor.runSilent(ctx, name, toolLabel, args, work),
      ),
    ),
    toolLabel,
    config.inputSchema,
    overrides,
  ) as TaskToolHandler;

  server.experimental.tasks.registerToolTask(name, createTaskRegistrationConfig(config), handler);
}

// Stateless transports register as plain tools since task results cannot
// be polled across request boundaries.
function registerWorkToolStateless<TArgs>(
  server: McpServer,
  name: string,
  config: TaskToolConfig,
  work: TaskWork<TArgs>,
): void {
  const toolLabel = config.title ?? name;
  server.registerTool(
    name,
    {
      ...(config.title ? { title: config.title } : {}),
      ...(config.description ? { description: config.description } : {}),
      inputSchema: config.inputSchema,
      ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      ...(config.annotations ? { annotations: config.annotations } : {}),
    },
    async (args, ctx) =>
      validateStructuredToolResult(
        name,
        config.outputSchema,
        await executor.run(ctx, name, toolLabel, args as TArgs, work),
      ),
  );
}

interface RegisterWorkToolParams<TArgs> {
  server: McpServer;
  tool: { name: string } & TaskToolConfig;
  work: TaskWork<TArgs>;
  overrides?: TaskToolOverrides;
}

export function registerWorkTool<TArgs>(params: RegisterWorkToolParams<TArgs>): void {
  const { server, tool, work, overrides } = params;
  const { name, ...config } = tool;
  if (getStatelessTransportFlag()) {
    registerWorkToolStateless<TArgs>(server, name, config, work);
    return;
  }
  registerTaskTool<TArgs>(server, name, config, work, overrides);
}
