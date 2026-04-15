import type {
  CallToolResult,
  RequestTaskStore,
  ServerContext,
  Task,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createToolTaskHandlers, runToolAsTask, taskTtl } from '../../src/lib/task-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStore(overrides?: {
  createTask?: RequestTaskStore['createTask'];
  getTask?: RequestTaskStore['getTask'];
  getTaskResult?: RequestTaskStore['getTaskResult'];
  storeTaskResult?: RequestTaskStore['storeTaskResult'];
  updateTaskStatus?: RequestTaskStore['updateTaskStatus'];
}): RequestTaskStore & { stored: { taskId: string; status: string; result: CallToolResult }[] } {
  const stored: { taskId: string; status: string; result: CallToolResult }[] = [];
  return {
    stored,
    createTask: overrides?.createTask ?? (async () => ({ taskId: 'task-1' }) as Task),
    getTask:
      overrides?.getTask ?? (async (taskId: string) => ({ taskId, status: 'completed' }) as Task),
    getTaskResult:
      overrides?.getTaskResult ??
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    storeTaskResult:
      overrides?.storeTaskResult ??
      (async (taskId: string, status: string, result: CallToolResult) => {
        stored.push({ taskId, status, result });
      }),
    updateTaskStatus: overrides?.updateTaskStatus ?? (async () => {}),
    listTasks: async () => ({ tasks: [] }),
  };
}

function makeMockContext(opts?: {
  taskStore?: RequestTaskStore;
  requestedTtl?: number;
  taskId?: string;
}): ServerContext {
  const controller = new AbortController();
  return {
    mcpReq: {
      _meta: {},
      signal: controller.signal,
      log: Object.assign(async () => {}, {
        debug: async () => {},
        info: async () => {},
        warning: async () => {},
        error: async () => {},
      }),
      notify: async () => {},
    },
    ...(opts?.taskStore
      ? {
          task: {
            store: opts.taskStore,
            requestedTtl: opts.requestedTtl,
            id: opts.taskId,
          },
        }
      : {}),
  } as unknown as ServerContext;
}

// ---------------------------------------------------------------------------
// taskTtl
// ---------------------------------------------------------------------------

describe('taskTtl', () => {
  it('returns the default TTL when undefined', () => {
    assert.strictEqual(taskTtl(undefined), 300_000);
  });

  it('returns the requested TTL when provided', () => {
    assert.strictEqual(taskTtl(60_000), 60_000);
  });

  it('returns 0 when explicitly requested', () => {
    assert.strictEqual(taskTtl(0), 0);
  });
});

// ---------------------------------------------------------------------------
// runToolAsTask
// ---------------------------------------------------------------------------

describe('runToolAsTask', () => {
  it('stores completed result for successful work', async () => {
    const store = makeMockStore();
    const task = { taskId: 'task-ok' } as Task;
    const result: CallToolResult = { content: [{ type: 'text', text: 'done' }] };

    runToolAsTask(store, task, Promise.resolve(result));

    // Let the microtask flush
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.taskId, 'task-ok');
    assert.strictEqual(entry.status, 'completed');
  });

  it('stores failed status when result has isError: true', async () => {
    const store = makeMockStore();
    const task = { taskId: 'task-err' } as Task;
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'bad' }],
      isError: true,
    };

    runToolAsTask(store, task, Promise.resolve(result));
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'failed');
  });

  it('stores error result when work promise rejects', async () => {
    const store = makeMockStore();
    const task = { taskId: 'task-throw' } as Task;

    runToolAsTask(store, task, Promise.reject(new Error('boom')));
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.taskId, 'task-throw');
    assert.strictEqual(entry.status, 'failed');
    assert.strictEqual(entry.result.isError, true);
    const firstContent = entry.result.content[0];
    assert.ok(firstContent);
    assert.strictEqual(firstContent.type, 'text');
    assert.ok((firstContent as { text: string }).text.includes('boom'));
  });

  it('handles non-Error rejection values', async () => {
    const store = makeMockStore();
    const task = { taskId: 'task-str' } as Task;

    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    runToolAsTask(store, task, Promise.reject('string error'));
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'failed');
    const firstContent = entry.result.content[0];
    assert.ok(firstContent);
    assert.ok((firstContent as { text: string }).text.includes('string error'));
  });

  it('skips storing result when task is cancelled (success path)', async () => {
    const store = makeMockStore({
      getTask: async () => ({ taskId: 'task-cancel', status: 'cancelled' }) as Task,
    });
    const task = { taskId: 'task-cancel' } as Task;
    const result: CallToolResult = { content: [{ type: 'text', text: 'done' }] };

    runToolAsTask(store, task, Promise.resolve(result));
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 0);
  });

  it('skips storing result when task is cancelled (error path)', async () => {
    const store = makeMockStore({
      getTask: async () => ({ taskId: 'task-cancel', status: 'cancelled' }) as Task,
    });
    const task = { taskId: 'task-cancel' } as Task;

    runToolAsTask(store, task, Promise.reject(new Error('boom')));
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createToolTaskHandlers
// ---------------------------------------------------------------------------

describe('createToolTaskHandlers', () => {
  it('createTask creates a task and schedules work', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store });
    let observedTaskId: string | undefined;

    const work = async (args: { msg: string }, workCtx: ServerContext) => {
      observedTaskId = workCtx.task?.id;
      return {
        content: [{ type: 'text' as const, text: args.msg }],
      };
    };

    const handlers = createToolTaskHandlers(work);
    const result = await handlers.createTask({ msg: 'hello' }, ctx);

    assert.ok(result.task);
    assert.strictEqual(result.task.taskId, 'task-1');
    assert.strictEqual(observedTaskId, 'task-1');

    // Let work complete
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'completed');
  });

  it('createTask uses requested TTL', async () => {
    let capturedTtl: number | undefined;
    const store = makeMockStore({
      createTask: async (opts) => {
        capturedTtl = (opts as { ttl?: number }).ttl;
        return { taskId: 'task-ttl' } as Task;
      },
    });
    const ctx = makeMockContext({ taskStore: store, requestedTtl: 120_000 });

    const handlers = createToolTaskHandlers(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await handlers.createTask({}, ctx);
    assert.strictEqual(capturedTtl, 120_000);
  });

  it('throws when task context is missing', async () => {
    const ctx = makeMockContext(); // no taskStore

    const handlers = createToolTaskHandlers(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await assert.rejects(() => handlers.createTask({}, ctx), {
      message: /Task context is unavailable/,
    });
  });

  it('getTask retrieves task from store', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store, taskId: 'task-42' });

    const handlers = createToolTaskHandlers(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const result = await handlers.getTask({}, ctx);
    assert.equal('task' in result, false);
    assert.strictEqual(result.taskId, 'task-42');
  });

  it('getTask throws when task ID is missing', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store }); // no taskId

    const handlers = createToolTaskHandlers(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await assert.rejects(() => handlers.getTask({}, ctx), {
      message: /Task ID is unavailable/,
    });
  });

  it('getTaskResult retrieves result from store', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store, taskId: 'task-42' });

    const handlers = createToolTaskHandlers(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const result = await handlers.getTaskResult({}, ctx);
    assert.deepStrictEqual(result.content, [{ type: 'text', text: 'ok' }]);
  });
});
