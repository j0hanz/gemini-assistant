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
import {
  ProtocolError,
  ProtocolErrorCode,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/server';

import { AppError } from './errors.js';
import { logger, maybeSummarizePayload } from './logger.js';
import { validateStructuredToolResult } from './response.js';
import { executor } from './tool-executor.js';

const DEFAULT_TTL = 300_000;

export const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
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

interface TaskCallRequest {
  params: {
    arguments?: unknown;
    name: string;
    task?: Record<string, unknown>;
  };
}

interface RegisteredTaskTool {
  enabled: boolean;
  execution?: { taskSupport?: string };
  executor: (args: unknown, ctx: ServerContext) => Promise<CallToolResult | CreateTaskResult>;
  handler: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

interface InternalMcpServer {
  _registeredTools: Record<string, RegisteredTaskTool>;
  __taskSafeToolCallHandlerInstalled?: boolean;
  createToolError: (errorMessage: string) => CallToolResult;
  executeToolHandler: (
    tool: RegisteredTaskTool,
    args: unknown,
    ctx: ServerContext,
  ) => Promise<CallToolResult | CreateTaskResult>;
  handleAutomaticTaskPolling: (
    tool: RegisteredTaskTool,
    request: TaskCallRequest,
    ctx: ServerContext,
  ) => Promise<CallToolResult>;
  server: {
    setRequestHandler: (
      method: 'tools/call',
      handler: (
        request: TaskCallRequest,
        ctx: ServerContext,
      ) => Promise<CallToolResult | CreateTaskResult>,
    ) => void;
  };
  validateToolInput: (
    tool: RegisteredTaskTool,
    args: unknown,
    toolName: string,
  ) => Promise<unknown>;
  validateToolOutput: (
    tool: RegisteredTaskTool,
    result: CallToolResult,
    toolName: string,
  ) => Promise<void>;
}

type TaskWork<TArgs> = (args: TArgs, ctx: ExtendedServerContext) => Promise<CallToolResult>;

interface ToolTaskHandlers<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<CreateTaskResult>;
  getTask: (_args: TArgs, ctx: ServerContext) => Promise<GetTaskResult>;
  getTaskResult: (_args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

type RegisterToolTask = McpServer['experimental']['tasks']['registerToolTask'];
type TaskToolConfig = Omit<Parameters<RegisterToolTask>[1], 'execution'>;
type TaskToolHandler = Parameters<RegisterToolTask>[2];

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
  work
    .then(async (result) => {
      if (await isTaskCancelled(store, task.taskId)) return;

      const status = result.isError ? 'failed' : 'completed';
      await store.storeTaskResult(task.taskId, status, result);
    })
    .catch(async (err: unknown) => {
      if (await isTaskCancelled(store, task.taskId)) return;

      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        await store.storeTaskResult(task.taskId, 'failed', {
          content: [{ type: 'text' as const, text: errorMessage }],
          isError: true,
        });
      } catch (storeErr) {
        onStoreError?.(task.taskId, storeErr);
      }
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

function isTaskHandler(handler: unknown): handler is TaskToolHandler {
  return typeof handler === 'object' && handler !== null && 'createTask' in handler;
}

export function wrapTaskSafeWork<TArgs>(toolName: string, work: TaskWork<TArgs>): TaskWork<TArgs> {
  return async (args, ctx) => {
    try {
      return await work(args, ctx);
    } catch (err) {
      return taskFailureResult(toolName, err);
    }
  };
}

async function handleStandardToolCall(
  server: InternalMcpServer,
  tool: RegisteredTaskTool,
  request: TaskCallRequest,
  ctx: ServerContext,
): Promise<CallToolResult> {
  try {
    const args = await server.validateToolInput(
      tool,
      request.params.arguments,
      request.params.name,
    );
    const result = (await server.executeToolHandler(tool, args, ctx)) as CallToolResult;
    await server.validateToolOutput(tool, result, request.params.name);
    return result;
  } catch (error) {
    if (error instanceof UrlElicitationRequiredError) {
      throw error;
    }

    return server.createToolError(error instanceof Error ? error.message : String(error));
  }
}

async function handleTaskAugmentedToolCall(
  server: InternalMcpServer,
  tool: RegisteredTaskTool,
  request: TaskCallRequest,
  ctx: ServerContext,
): Promise<CreateTaskResult> {
  try {
    const args = await server.validateToolInput(
      tool,
      request.params.arguments,
      request.params.name,
    );
    return (await server.executeToolHandler(tool, args, ctx)) as CreateTaskResult;
  } catch (error) {
    if (error instanceof UrlElicitationRequiredError) {
      throw error;
    }

    const { task, taskContext } = await createTaskOrFail(ctx);
    await materializeTaskFailure(
      request.params.name,
      taskContext.store,
      task,
      error,
      request.params.arguments,
    );
    return { task };
  }
}

export function installTaskSafeToolCallHandler(server: McpServer): void {
  const internalServer = server as unknown as InternalMcpServer;
  if (internalServer.__taskSafeToolCallHandlerInstalled) {
    return;
  }
  internalServer.__taskSafeToolCallHandlerInstalled = true;

  internalServer.server.setRequestHandler(
    'tools/call',
    async (request: TaskCallRequest, ctx: ServerContext) => {
      const tool = internalServer._registeredTools[request.params.name];
      if (!tool) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${request.params.name} not found`,
        );
      }
      if (!tool.enabled) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${request.params.name} disabled`,
        );
      }

      const taskSupport = tool.execution?.taskSupport;
      const taskRequest = !!request.params.task;
      const taskHandler = isTaskHandler(tool.handler);

      if (taskRequest && !taskHandler) {
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          `Tool ${request.params.name} does not support task augmentation`,
        );
      }
      if ((taskSupport === 'required' || taskSupport === 'optional') && !taskHandler) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Tool ${request.params.name} has taskSupport '${taskSupport}' but was not registered with registerToolTask`,
        );
      }
      if (taskSupport === 'required' && !taskRequest) {
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          `Tool ${request.params.name} requires task augmentation (taskSupport: 'required')`,
        );
      }
      if (taskSupport === 'optional' && !taskRequest && taskHandler) {
        return await internalServer.handleAutomaticTaskPolling(tool, request, ctx);
      }

      // The SDK validates task-augmented results against CreateTaskResultSchema after this
      // handler returns. If input validation fails here and we return a normal tool error
      // result, the outer wrapper rewrites the real cause to the opaque -32602 "Invalid
      // task creation result". Convert failures into stored failed tasks and return { task }.
      if (taskRequest) {
        return await handleTaskAugmentedToolCall(internalServer, tool, request, ctx);
      }

      return await handleStandardToolCall(internalServer, tool, request, ctx);
    },
  );
}

export function createToolTaskHandlers<TArgs>(
  toolName: string,
  work: TaskWork<TArgs>,
  taskMessageQueue: TaskMessageQueue,
): ToolTaskHandlers<TArgs> {
  return {
    createTask: async (args, ctx) => {
      const { task, taskContext } = await createTaskOrFail(ctx);
      const taskExecutionContext: ExtendedServerContext = {
        ...ctx,
        task: {
          ...taskContext,
          id: task.taskId,
          queue: taskMessageQueue,
        },
      };
      try {
        runToolAsTask(taskContext.store, task, work(args, taskExecutionContext), (taskId, err) => {
          taskLog.error('Failed to store task error result', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          void ctx.mcpReq.log(
            'error',
            `Failed to store error result for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } catch (err) {
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
        await executor.run(
          ctx,
          name,
          toolLabel,
          args,
          work as unknown as (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
        ),
      ),
    ),
    taskMessageQueue,
  ) as TaskToolHandler;

  server.experimental.tasks.registerToolTask(
    name,
    {
      ...config,
      execution: TASK_EXECUTION,
    } as Parameters<RegisterToolTask>[1],
    handler,
  );
}
