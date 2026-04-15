import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  McpServer,
  RequestTaskStore,
  ServerContext,
  Task,
} from '@modelcontextprotocol/server';

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

const TASK_EXECUTION = { taskSupport: 'optional' } as const;

type TaskWork<TArgs> = (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;

interface ToolTaskHandlers<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<CreateTaskResult>;
  getTask: (_args: TArgs, ctx: ServerContext) => Promise<GetTaskResult>;
  getTaskResult: (_args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

type RegisterToolTask = McpServer['experimental']['tasks']['registerToolTask'];
type TaskToolConfig = Omit<Parameters<RegisterToolTask>[1], 'execution'>;
type TaskToolHandler = Parameters<RegisterToolTask>[2];
type TaskContext = NonNullable<ServerContext['task']>;

function requireTaskContext(ctx: ServerContext): TaskContext {
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
      const taskContext = requireTaskContext(ctx);
      const task = await taskContext.store.createTask({ ttl: taskTtl(taskContext.requestedTtl) });
      const taskExecutionContext: ServerContext = {
        ...ctx,
        task: {
          ...taskContext,
          id: task.taskId,
        },
      };
      runToolAsTask(taskContext.store, task, work(args, taskExecutionContext), (taskId, err) => {
        void ctx.mcpReq.log(
          'error',
          `Failed to store error result for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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

export function registerTaskTool<TArgs>(
  server: McpServer,
  name: string,
  config: TaskToolConfig,
  work: TaskWork<TArgs>,
): void {
  const toolLabel = config.title ?? name;
  const handler = createToolTaskHandlers(
    withErrorLogging(name, toolLabel, work),
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
