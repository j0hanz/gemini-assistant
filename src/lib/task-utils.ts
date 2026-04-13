import type { CallToolResult, RequestTaskStore, Task } from '@modelcontextprotocol/server';
import type { CreateTaskResult, GetTaskResult, ServerContext } from '@modelcontextprotocol/server';

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

export const TASK_EXECUTION = { taskSupport: 'optional' } as const;

type TaskWork<TArgs> = (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;

interface ToolTaskHandlers<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<CreateTaskResult>;
  getTask: (_args: TArgs, ctx: ServerContext) => Promise<GetTaskResult>;
  getTaskResult: (_args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

function requireTaskContext(ctx: ServerContext) {
  const taskContext = ctx.task;
  if (!taskContext) {
    throw new Error('Task context is unavailable for this tool execution.');
  }
  return taskContext;
}

function requireTaskId(ctx: ServerContext): string {
  const taskId = requireTaskContext(ctx).id;
  if (!taskId) {
    throw new Error('Task ID is unavailable for this tool execution.');
  }
  return taskId;
}

/**
 * Runs tool work in the background and stores the result in the task store.
 * Maps `isError: true` results to `'failed'` task status.
 */
export function runToolAsTask(
  store: RequestTaskStore,
  task: Task,
  work: Promise<CallToolResult>,
): void {
  work
    .then(async (result) => {
      const status = result.isError ? 'failed' : 'completed';
      await store.storeTaskResult(task.taskId, status, result);
    })
    .catch(async (err: unknown) => {
      try {
        await store.storeTaskResult(task.taskId, 'failed', {
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
          isError: true,
        });
      } catch {
        console.error(`Failed to store error result for task ${task.taskId}`);
      }
    });
}

export function taskTtl(requestedTtl: number | undefined): number {
  return requestedTtl ?? DEFAULT_TTL;
}

export function createToolTaskHandlers<TArgs>(work: TaskWork<TArgs>): ToolTaskHandlers<TArgs> {
  return {
    createTask: async (args, ctx) => {
      const taskContext = requireTaskContext(ctx);
      const task = await taskContext.store.createTask({ ttl: taskTtl(taskContext.requestedTtl) });
      runToolAsTask(taskContext.store, task, work(args, ctx));
      return { task } as CreateTaskResult;
    },
    getTask: async (_args, ctx) => {
      const taskContext = requireTaskContext(ctx);
      return {
        task: await taskContext.store.getTask(requireTaskId(ctx)),
      } as unknown as GetTaskResult;
    },
    getTaskResult: async (_args, ctx) => {
      const taskContext = requireTaskContext(ctx);
      return (await taskContext.store.getTaskResult(requireTaskId(ctx))) as CallToolResult;
    },
  };
}
