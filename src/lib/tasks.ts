import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  RELATED_TASK_META_KEY,
} from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  CreateTaskOptions,
  CreateTaskResult,
  GetTaskResult,
  Request as McpRequest,
  McpServer,
  QueuedNotification,
  RequestId,
  RequestTaskStore,
  Result,
  ServerContext,
  Task,
  TaskMessageQueue,
  TaskStatus,
  TaskStore,
} from '@modelcontextprotocol/server';

import { EventEmitter } from 'node:events';

import { getStatelessTransportFlag } from '../config.js';
import { AppError } from './errors.js';
import { logger, maybeSummarizePayload } from './logger.js';
import { hasTerminalProgress, reportCompletion, reportFailure } from './progress.js';
import { extractTextContent, validateStructuredToolResult } from './response.js';
import { executor } from './tool-executor.js';

// ── Shared infrastructure ──

const storeToQueue = new WeakMap<ObservableTaskStore, TaskMessageQueue>();

export interface SharedTaskInfra {
  taskStore: ObservableTaskStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
  close: () => void;
}

/**
 * Shared task store/queue across per-request `ServerInstance`s for HTTP and
 * Web-Standard transports so task results created by one request can be
 * polled in a later request. Stdio servers create their own infra.
 */
export function createSharedTaskInfra(): SharedTaskInfra {
  const taskStore = new ObservableTaskStore(new InMemoryTaskStore());
  const taskMessageQueue = new InMemoryTaskMessageQueue();
  storeToQueue.set(taskStore, taskMessageQueue);
  return {
    taskStore,
    taskMessageQueue,
    close: () => {
      taskStore.cleanup();
      (taskMessageQueue as { cleanup?: () => void }).cleanup?.();
    },
  };
}

const MAX_PHASES = 16;
const MAX_FINDINGS = 64;
const emitterLog = logger.child('task-emitter');

export function getTaskEmitter(ctx: ServerContext): {
  phase(name: string, detail?: string): Promise<void>;
  finding(payload: { kind: string; data?: unknown }): Promise<void>;
} {
  const taskId = ctx.task?.id;
  const store = ctx.task?.store;
  const queue = store instanceof ObservableTaskStore ? storeToQueue.get(store) : undefined;

  const noop = (): Promise<void> => Promise.resolve();

  if (!taskId || !queue) {
    return { phase: noop, finding: noop };
  }

  let phaseCount = 0;
  let phaseTruncated = false;
  let findingCount = 0;
  let findingTruncated = false;

  return {
    async phase(name: string, detail?: string): Promise<void> {
      if (phaseTruncated) return;

      if (phaseCount >= MAX_PHASES) {
        phaseTruncated = true;
        const truncation: QueuedNotification = {
          type: 'notification',
          timestamp: Date.now(),
          message: {
            jsonrpc: '2.0',
            method: 'notifications/gemini-assistant/phase',
            params: {
              phase: 'truncated',
              detail: '1 dropped',
              _meta: { [RELATED_TASK_META_KEY]: { taskId } },
            },
          },
        };
        try {
          await queue.enqueue(taskId, truncation);
        } catch (err) {
          emitterLog.warn('failed to enqueue truncation phase', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      phaseCount++;
      const notification: QueuedNotification = {
        type: 'notification',
        timestamp: Date.now(),
        message: {
          jsonrpc: '2.0',
          method: 'notifications/gemini-assistant/phase',
          params: {
            phase: name,
            ...(detail !== undefined ? { detail } : {}),
            _meta: { [RELATED_TASK_META_KEY]: { taskId } },
          },
        },
      };
      try {
        await queue.enqueue(taskId, notification);
      } catch (err) {
        emitterLog.warn('failed to enqueue phase', {
          taskId,
          phase: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async finding(payload: { kind: string; data?: unknown }): Promise<void> {
      if (findingTruncated) return;

      if (findingCount >= MAX_FINDINGS) {
        findingTruncated = true;
        const truncation: QueuedNotification = {
          type: 'notification',
          timestamp: Date.now(),
          message: {
            jsonrpc: '2.0',
            method: 'notifications/gemini-assistant/finding',
            params: {
              kind: 'truncated',
              detail: '1 dropped',
              _meta: { [RELATED_TASK_META_KEY]: { taskId } },
            },
          },
        };
        try {
          await queue.enqueue(taskId, truncation);
        } catch (err) {
          emitterLog.warn('failed to enqueue truncation finding', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      findingCount++;
      const notification: QueuedNotification = {
        type: 'notification',
        timestamp: Date.now(),
        message: {
          jsonrpc: '2.0',
          method: 'notifications/gemini-assistant/finding',
          params: {
            ...payload,
            _meta: { [RELATED_TASK_META_KEY]: { taskId } },
          },
        },
      };
      try {
        await queue.enqueue(taskId, notification);
      } catch (err) {
        emitterLog.warn('failed to enqueue finding', {
          taskId,
          kind: payload.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

type TaskEvent =
  | { type: 'status'; taskId: string; status: TaskStatus; statusMessage?: string }
  | { type: 'result'; taskId: string; status: 'completed' | 'failed' };

/**
 * Wraps `InMemoryTaskStore` and emits typed `'task'` events on status/result
 * changes. Used by `bridgeTaskCancellationToSignal` to subscribe to
 * cancellation without polling.
 */
class ObservableTaskStore implements TaskStore {
  readonly emitter: EventEmitter<{ task: [TaskEvent] }>;
  readonly #inner: InMemoryTaskStore;

  constructor(inner: InMemoryTaskStore) {
    this.#inner = inner;
    this.emitter = new EventEmitter<{ task: [TaskEvent] }>();
    this.emitter.setMaxListeners(0);
  }

  createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: McpRequest,
    sessionId?: string,
  ): Promise<Task> {
    return this.#inner.createTask(taskParams, requestId, request, sessionId);
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return this.#inner.getTask(taskId, sessionId);
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.#inner.getTaskResult(taskId, sessionId);
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.#inner.listTasks(cursor, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.#inner.updateTaskStatus(taskId, status, statusMessage, sessionId);
    const event: TaskEvent =
      statusMessage !== undefined
        ? { type: 'status', taskId, status, statusMessage }
        : { type: 'status', taskId, status };
    this.emitter.emit('task', event);
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    await this.#inner.storeTaskResult(taskId, status, result, sessionId);
    const event: TaskEvent = { type: 'result', taskId, status };
    this.emitter.emit('task', event);
  }

  cleanup(): void {
    this.emitter.removeAllListeners();
    this.#inner.cleanup();
  }
}

// ── Task lifecycle helpers ──

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

export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const TASK_EXECUTION = { taskSupport: 'optional' } as const;
const taskLog = logger.child('tasks');

type TaskContext = NonNullable<ServerContext['task']>;
type ExtendedTaskContext = TaskContext & {
  cancellationSignal?: AbortSignal;
};
type ExtendedServerContext = ServerContext & { task?: ExtendedTaskContext };

function isTerminalStatusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('terminal status');
}

type TaskWork<TArgs> = (args: TArgs, ctx: ExtendedServerContext) => Promise<CallToolResult>;

interface TaskToolOverrides {
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

function createTaskRegistrationConfig(config: TaskToolConfig): TaskRegistrationConfig {
  return { ...config, execution: TASK_EXECUTION };
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

function runToolAsTask(
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

function taskTtl(requestedTtl: number | undefined, defaultTtlMs?: number): number {
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

// ── Cancellation ──

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

function bridgeTaskCancellationToSignal(
  baseSignal: AbortSignal,
  taskId: string,
  store: ObservableTaskStore,
): AbortSignal {
  const controller = new AbortController();

  if (baseSignal.aborted) {
    controller.abort(baseSignal.reason);
    return controller.signal;
  }

  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    store.emitter.removeListener('task', onTaskEvent);
    baseSignal.removeEventListener('abort', onBaseAbort);
  };

  const onBaseAbort = (): void => {
    cleanup();
    if (!controller.signal.aborted) controller.abort(baseSignal.reason);
  };
  baseSignal.addEventListener('abort', onBaseAbort, { once: true });

  const onTaskEvent = (event: TaskEvent): void => {
    if (event.taskId !== taskId) return;

    if (event.type === 'status') {
      if (event.status === 'cancelled' && !controller.signal.aborted) {
        controller.abort(new Error(`Task ${taskId} cancelled`));
      }
      if (TERMINAL_STATUSES.has(event.status)) {
        cleanup();
      }
    } else {
      // type === 'result'
      cleanup();
    }
  };

  store.emitter.on('task', onTaskEvent);

  // Close the window between task creation and listener registration.
  void store
    .getTask(taskId)
    .then((task) => {
      if (task !== null && TERMINAL_STATUSES.has(task.status)) {
        onTaskEvent({ type: 'status', taskId, status: task.status });
      }
    })
    .catch(() => {
      cleanup();
    });

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

// ── Elicitation ──

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

// ── Tool registration ──

function createToolTaskHandlers<TArgs>(
  toolName: string,
  work: TaskWork<TArgs>,
  toolLabel = toolName,
  inputSchema?: unknown,
  overrides?: TaskToolOverrides,
): ToolTaskHandlers<TArgs> {
  return {
    createTask: async (rawArgs, ctx) => {
      const { task, taskContext } = await createTaskOrFail(ctx, overrides?.defaultTtlMs);

      // Cast to ObservableTaskStore: createSharedTaskInfra always wraps with
      // ObservableTaskStore; stateless mode falls back to base signal only.
      const cancellationSignal =
        taskContext.store instanceof ObservableTaskStore
          ? bridgeTaskCancellationToSignal(ctx.mcpReq.signal, task.taskId, taskContext.store)
          : ctx.mcpReq.signal;

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

function registerTaskTool<TArgs>(
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

export function getWorkSignal(ctx: ServerContext): AbortSignal {
  const task = ctx.task as ExtendedTaskContext | undefined;
  return task?.cancellationSignal ?? ctx.mcpReq.signal;
}
