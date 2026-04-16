import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  McpServer,
  QueuedMessage,
  RequestTaskStore,
  ServerContext,
  Task,
} from '@modelcontextprotocol/server';
import { InMemoryTaskMessageQueue } from '@modelcontextprotocol/server';

import { withErrorLogging } from './errors.js';

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

export const globalTaskMessageQueue = new InMemoryTaskMessageQueue();

const TASK_EXECUTION = { taskSupport: 'optional' } as const;

type TaskContext = NonNullable<ServerContext['task']>;
export type ExtendedTaskContext = TaskContext & { queue: InMemoryTaskMessageQueue };
export type ExtendedServerContext = ServerContext & { task?: ExtendedTaskContext };

export type TaskWork<TArgs> = (args: TArgs, ctx: ExtendedServerContext) => Promise<CallToolResult>;

interface ToolTaskHandlers<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<CreateTaskResult>;
  getTask: (_args: TArgs, ctx: ServerContext) => Promise<GetTaskResult>;
  getTaskResult: (_args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

type RegisterToolTask = McpServer['experimental']['tasks']['registerToolTask'];
type TaskToolConfig = Omit<Parameters<RegisterToolTask>[1], 'execution'>;
type TaskToolHandler = Parameters<RegisterToolTask>[2];

export async function elicitTaskInput(
  ctx: ExtendedServerContext,
  prompt: string,
  statusMessage = 'Waiting for user input',
): Promise<string | undefined> {
  const taskContext = ctx.task;
  if (!taskContext?.id) throw new Error('Task context or ID is unavailable.');

  await taskContext.store.updateTaskStatus(taskContext.id, 'input_required', statusMessage);

  // Enqueue an elicitation request to the side-channel message queue
  const messageId = `elicit_${Date.now()}`;
  void taskContext.queue.enqueue(taskContext.id, {
    method: 'elicitation/create',
    params: { prompt },
    id: messageId,
  } as unknown as QueuedMessage);

  while (!ctx.mcpReq.signal.aborted) {
    const msgs = await taskContext.queue.dequeueAll(taskContext.id);
    for (const msg of msgs) {
      if ('id' in msg && msg.id === messageId && 'result' in msg) {
        await taskContext.store.updateTaskStatus(taskContext.id, 'working');
        const resultPayload = (msg as unknown as { result?: { text?: string } | string }).result;
        return typeof resultPayload === 'string'
          ? resultPayload
          : (resultPayload?.text ?? JSON.stringify(resultPayload));
      }
    }
    // Briefly sleep to avoid hot-looping
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Task aborted during elicitation');
}

export function requireTaskContext(
  ctx: ServerContext | ExtendedServerContext,
): ExtendedTaskContext {
  const taskContext = ctx.task;
  if (!taskContext) {
    throw new Error('Task context is unavailable for this tool execution.');
  }
  return taskContext as ExtendedTaskContext;
}

function requireTaskId(ctx: ServerContext | ExtendedServerContext): string {
  const taskId = requireTaskContext(ctx).id;
  if (!taskId) {
    throw new Error('Task ID is unavailable for this tool execution.');
  }
  return taskId;
}

async function isTaskCancelled(store: RequestTaskStore, taskId: string): Promise<boolean> {
  try {
    const current = await store.getTask(taskId);
    return current.status === 'cancelled';
  } catch {
    return false;
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

      if (result.isError) {
        const errorText = result.content.find((c) => c.type === 'text');
        if (errorText && 'text' in errorText) {
          try {
            await store.updateTaskStatus(task.taskId, 'working', errorText.text);
          } catch {
            // Ignore if status update fails
          }
        }
      }

      await store.storeTaskResult(task.taskId, status, result);
    })
    .catch(async (err: unknown) => {
      if (await isTaskCancelled(store, task.taskId)) return;

      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        await store.updateTaskStatus(task.taskId, 'working', errorMessage);
      } catch {
        // Ignore
      }
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

export function createToolTaskHandlers<TArgs>(work: TaskWork<TArgs>): ToolTaskHandlers<TArgs> {
  return {
    createTask: async (args, ctx) => {
      const taskContext = ctx.task;
      if (!taskContext) throw new Error('Task context is unavailable.');
      const task = await taskContext.store.createTask({ ttl: taskTtl(taskContext.requestedTtl) });
      const taskExecutionContext: ExtendedServerContext = {
        ...ctx,
        task: {
          ...taskContext,
          id: task.taskId,
          queue: globalTaskMessageQueue,
        },
      };
      runToolAsTask(taskContext.store, task, work(args, taskExecutionContext), (taskId, err) => {
        void ctx.mcpReq.log(
          'error',
          `Failed to store error result for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return { task };
    },
    getTask: async (_args, ctx) => {
      const taskContext = requireTaskContext(ctx);
      return (await taskContext.store.getTask(requireTaskId(ctx))) as GetTaskResult;
    },
    getTaskResult: async (_args, ctx) => {
      const taskContext = requireTaskContext(ctx);
      return (await taskContext.store.getTaskResult(requireTaskId(ctx))) as CallToolResult;
    },
  };
}

export function registerTaskTool<TArgs>(
  server: McpServer,
  name: string,
  config: TaskToolConfig,
  work: TaskWork<TArgs>,
): void {
  const toolLabel = config.title ?? name;
  const handler = createToolTaskHandlers(
    withErrorLogging<TArgs>(
      name,
      toolLabel,
      work as unknown as (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
    ),
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
