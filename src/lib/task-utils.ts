import type { CallToolResult, RequestTaskStore, Task } from '@modelcontextprotocol/server';

const DEFAULT_TTL = 300_000;

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
