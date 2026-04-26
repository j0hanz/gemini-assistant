import type {
  CallToolResult,
  RequestTaskStore,
  ServerContext,
  Task,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { z } from 'zod/v4';

import {
  createToolTaskHandlers,
  elicitTaskInput,
  registerTaskTool,
  runToolAsTask,
  taskTtl,
} from '../../src/lib/task-utils.js';

process.env.API_KEY ??= 'test-key-for-task-utils';

afterEach(async () => {
  // No-op placeholder to keep node:test happy if future cases add cleanup.
});

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
  elicitInput?: ServerContext['mcpReq']['elicitInput'];
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
      elicitInput:
        opts?.elicitInput ??
        (async () => ({
          action: 'accept',
          content: { text: 'answer' },
        })),
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
    assert.strictEqual(taskTtl(undefined), 600_000);
  });

  it('honors a per-tool default override when provided', () => {
    assert.strictEqual(taskTtl(undefined, 900_000), 900_000);
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

  it('stores completed status for non-error declined flows', async () => {
    const store = makeMockStore();
    const task = { taskId: 'task-soft-stop' } as Task;
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'Interactive confirmation is unavailable.' }],
      structuredContent: {
        cacheName: 'cachedContents/abc123',
        deleted: false,
        confirmationRequired: true,
      },
    };

    runToolAsTask(store, task, Promise.resolve(result));
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'completed');
    assert.strictEqual(entry.result.isError, undefined);
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

  it('marks task failed when storing a successful result fails', async () => {
    const errors: string[] = [];
    const statusUpdates: { message?: string; status: string; taskId: string }[] = [];
    let storeAttempts = 0;
    const store = makeMockStore({
      storeTaskResult: async () => {
        storeAttempts += 1;
        throw new Error(`store failed ${storeAttempts}`);
      },
      updateTaskStatus: async (taskId, status, message) => {
        statusUpdates.push({ taskId, status, ...(message ? { message } : {}) });
      },
    });
    const task = { taskId: 'task-store-fail' } as Task;

    runToolAsTask(
      store,
      task,
      Promise.resolve({ content: [{ type: 'text', text: 'done' }] }),
      (_taskId, err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    );
    await new Promise((r) => setTimeout(r, 10));

    assert.deepStrictEqual(errors, ['store failed 1', 'store failed 2']);
    assert.deepStrictEqual(statusUpdates, [
      {
        taskId: 'task-store-fail',
        status: 'failed',
        message: 'Failed to store task result: store failed 1',
      },
    ]);
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

    const handlers = createToolTaskHandlers('test-tool', work);
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

  it('createTask stores a failed result when work throws synchronously', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store });

    const handlers = createToolTaskHandlers('test-tool', () => {
      throw new Error('sync explode');
    });

    const result = await handlers.createTask({}, ctx);
    assert.ok(result.task);
    assert.strictEqual(result.task.taskId, 'task-1');

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'failed');
    assert.strictEqual(entry.result.isError, true);
    assert.match(entry.result.content[0]?.text ?? '', /sync explode/);
  });

  it('createTask reports terminal progress for non-stream task work', async () => {
    const store = makeMockStore();
    const progressCalls: { progress: number; total?: number; message?: string }[] = [];
    const ctx = makeMockContext({ taskStore: store });
    (ctx.mcpReq as { _meta: { progressToken?: string } })._meta = {
      progressToken: 'task-progress',
    };
    (ctx.mcpReq as { notify: (notification: unknown) => Promise<void> }).notify = async (
      notification,
    ) => {
      const n = notification as {
        params: { message?: string; progress: number; total?: number };
      };
      progressCalls.push({
        progress: n.params.progress,
        ...(n.params.total !== undefined ? { total: n.params.total } : {}),
        ...(n.params.message ? { message: n.params.message } : {}),
      });
    };

    const handlers = createToolTaskHandlers(
      'test-tool',
      async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
      'Test Tool',
    );

    await handlers.createTask({}, ctx);
    await new Promise((r) => setTimeout(r, 10));

    assert.deepStrictEqual(
      progressCalls.filter((call) => call.progress === 100 && call.total === 100),
      [{ progress: 100, total: 100, message: 'Test Tool: completed' }],
    );
  });

  it('createTask stores a failed result when work rejects after task creation', async () => {
    const store = makeMockStore();
    const progressCalls: { progress: number; total?: number; message?: string }[] = [];
    const ctx = makeMockContext({ taskStore: store });
    (ctx.mcpReq as { _meta: { progressToken?: string } })._meta = {
      progressToken: 'task-progress',
    };
    (ctx.mcpReq as { notify: (notification: unknown) => Promise<void> }).notify = async (
      notification,
    ) => {
      const n = notification as {
        params: { message?: string; progress: number; total?: number };
      };
      progressCalls.push({
        progress: n.params.progress,
        ...(n.params.total !== undefined ? { total: n.params.total } : {}),
        ...(n.params.message ? { message: n.params.message } : {}),
      });
    };

    const handlers = createToolTaskHandlers('test-tool', async () => {
      throw new Error('outputSchema mismatch');
    });

    const result = await handlers.createTask({}, ctx);
    assert.ok(result.task);
    assert.strictEqual(result.task.taskId, 'task-1');

    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'failed');
    assert.strictEqual(entry.result.isError, true);
    assert.match(entry.result.content[0]?.text ?? '', /outputSchema mismatch/);
    assert.deepStrictEqual(
      progressCalls.filter((call) => call.progress === 100 && call.total === 100),
      [{ progress: 100, total: 100, message: 'test-tool: failed — outputSchema mismatch' }],
    );
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

    const handlers = createToolTaskHandlers('test-tool', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await handlers.createTask({}, ctx);
    assert.strictEqual(capturedTtl, 120_000);
  });

  it('throws when task context is missing', async () => {
    const ctx = makeMockContext(); // no taskStore

    const handlers = createToolTaskHandlers('test-tool', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await assert.rejects(() => handlers.createTask({}, ctx), {
      message: /Task context is unavailable/,
    });
  });

  it('getTask retrieves task from store', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store, taskId: 'task-42' });

    const handlers = createToolTaskHandlers('test-tool', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const result = await handlers.getTask({}, ctx);
    assert.equal('task' in result, false);
    assert.strictEqual(result.taskId, 'task-42');
  });

  it('getTask throws when task ID is missing', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store }); // no taskId

    const handlers = createToolTaskHandlers('test-tool', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await assert.rejects(() => handlers.getTask({}, ctx), {
      message: /Task ID is unavailable/,
    });
  });

  it('getTaskResult retrieves result from store', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store, taskId: 'task-42' });

    const handlers = createToolTaskHandlers('test-tool', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const result = await handlers.getTaskResult({}, ctx);
    assert.deepStrictEqual(result.content, [{ type: 'text', text: 'ok' }]);
  });
});

describe('elicitTaskInput', () => {
  it('returns accepted text and restores working status', async () => {
    const updates: { status: string; statusMessage?: string }[] = [];
    const store = makeMockStore({
      updateTaskStatus: async (_taskId, status, statusMessage) => {
        updates.push({ status, ...(statusMessage ? { statusMessage } : {}) });
      },
    });

    const result = await elicitTaskInput(
      makeMockContext({
        taskStore: store,
        taskId: 'task-elicit',
        elicitInput: async () => ({
          action: 'accept',
          content: { text: '  focus on pricing  ' },
        }),
      }),
      'Question?',
      'Waiting for input',
    );

    assert.strictEqual(result, 'focus on pricing');
    assert.deepStrictEqual(updates, [
      { status: 'input_required', statusMessage: 'Waiting for input' },
      { status: 'working' },
    ]);
  });

  it('returns undefined for declined elicitation and restores working status', async () => {
    const updates: { status: string; statusMessage?: string }[] = [];
    const store = makeMockStore({
      updateTaskStatus: async (_taskId, status, statusMessage) => {
        updates.push({ status, ...(statusMessage ? { statusMessage } : {}) });
      },
    });

    const result = await elicitTaskInput(
      makeMockContext({
        taskStore: store,
        taskId: 'task-elicit',
        elicitInput: async () => ({
          action: 'decline',
        }),
      }),
      'Question?',
    );

    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(updates, [
      { status: 'input_required', statusMessage: 'Waiting for user input' },
      { status: 'working' },
    ]);
  });

  it('surfaces elicitation errors after restoring working status', async () => {
    const updates: { status: string; statusMessage?: string }[] = [];
    const store = makeMockStore({
      updateTaskStatus: async (_taskId, status, statusMessage) => {
        updates.push({ status, ...(statusMessage ? { statusMessage } : {}) });
      },
    });

    await assert.rejects(
      () =>
        elicitTaskInput(
          makeMockContext({
            taskStore: store,
            taskId: 'task-elicit',
            elicitInput: async () => {
              throw new Error('elicitation failed');
            },
          }),
          'Question?',
        ),
      /elicitation failed/,
    );

    assert.deepStrictEqual(updates, [
      { status: 'input_required', statusMessage: 'Waiting for user input' },
      { status: 'working' },
    ]);
  });

  it('rewraps capability-missing errors as a typed AppError', async () => {
    const updates: { status: string; statusMessage?: string }[] = [];
    const store = makeMockStore({
      updateTaskStatus: async (_taskId, status, statusMessage) => {
        updates.push({ status, ...(statusMessage ? { statusMessage } : {}) });
      },
    });

    await assert.rejects(
      () =>
        elicitTaskInput(
          makeMockContext({
            taskStore: store,
            taskId: 'task-elicit',
            elicitInput: async () => {
              throw new Error(
                'Client does not support elicitation (required for elicitation/create)',
              );
            },
          }),
          'Question?',
        ),
      /Elicitation is not supported by the connected client/,
    );

    assert.deepStrictEqual(updates, [
      { status: 'input_required', statusMessage: 'Waiting for user input' },
      { status: 'working' },
    ]);
  });
});

describe('registerTaskTool', () => {
  function makeMockServer() {
    let capturedHandler:
      | {
          createTask: (args: { msg: string }, ctx: ServerContext) => Promise<{ task: Task }>;
        }
      | undefined;

    const server = {
      experimental: {
        tasks: {
          registerToolTask: (_name: string, _config: unknown, handler: typeof capturedHandler) => {
            capturedHandler = handler;
          },
        },
      },
    } as unknown as { experimental: { tasks: { registerToolTask: typeof Function } } };

    return {
      server: server as never,
      getHandler: () => {
        assert.ok(capturedHandler);
        return capturedHandler;
      },
    };
  }

  it('stores failed status when central validation rejects structured content', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store });
    const { server, getHandler } = makeMockServer();

    registerTaskTool(
      server,
      'test-tool',
      {
        title: 'Test Tool',
        description: 'test',
        inputSchema: z.strictObject({ msg: z.string() }),
        outputSchema: z.strictObject({
          status: z.literal('completed'),
          summary: z.string(),
        }),
        annotations: {},
      },
      async ({ msg }: { msg: string }) => ({
        content: [{ type: 'text', text: msg }],
        structuredContent: { status: 'completed', explanation: 'wrong field' },
      }),
    );

    await getHandler().createTask({ msg: 'hello' }, ctx);
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'failed');
    assert.strictEqual(entry.result.isError, true);
    assert.strictEqual(entry.result.structuredContent, undefined);
    assert.match(entry.result.content[1]?.text ?? '', /output validation failed/i);
  });

  it('stores completed status when central validation accepts structured content', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store });
    const { server, getHandler } = makeMockServer();

    registerTaskTool(
      server,
      'test-tool',
      {
        title: 'Test Tool',
        description: 'test',
        inputSchema: z.strictObject({ msg: z.string() }),
        outputSchema: z.strictObject({
          status: z.literal('completed'),
          summary: z.string(),
        }),
        annotations: {},
      },
      async ({ msg }: { msg: string }) => ({
        content: [{ type: 'text', text: msg }],
        structuredContent: { status: 'completed', summary: 'ok' },
      }),
    );

    await getHandler().createTask({ msg: 'hello' }, ctx);
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'completed');
    assert.strictEqual(entry.result.isError, undefined);
    assert.deepStrictEqual(entry.result.structuredContent, {
      status: 'completed',
      summary: 'ok',
    });
  });

  it('stores failed status when input validation rejects task args', async () => {
    const store = makeMockStore();
    const ctx = makeMockContext({ taskStore: store });
    const { server, getHandler } = makeMockServer();
    let workCalled = false;

    registerTaskTool(
      server,
      'test-tool',
      {
        title: 'Test Tool',
        description: 'test',
        inputSchema: z.strictObject({ msg: z.string() }),
        outputSchema: z.strictObject({ summary: z.string() }),
        annotations: {},
      },
      async () => {
        workCalled = true;
        return {
          content: [{ type: 'text', text: 'should not run' }],
          structuredContent: { summary: 'should not run' },
        };
      },
    );

    const result = await getHandler().createTask({ msg: 123 }, ctx);

    assert.strictEqual(result.task.taskId, 'task-1');
    assert.strictEqual(workCalled, false);
    assert.strictEqual(store.stored.length, 1);
    const entry = store.stored[0];
    assert.ok(entry);
    assert.strictEqual(entry.status, 'failed');
    assert.strictEqual(entry.result.isError, true);
    assert.match(entry.result.content[0]?.text ?? '', /test-tool failed/i);
  });
});
