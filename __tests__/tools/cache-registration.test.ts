import type {
  CallToolResult,
  RequestTaskStore,
  ServerContext,
  Task,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import { registerCacheTools } from '../../src/tools/cache.js';

process.env.API_KEY ??= 'test-key-for-cache-tools';

interface DeleteCacheTaskHandler {
  createTask: (
    args: { cacheName: string; confirm?: boolean },
    ctx: ServerContext,
  ) => Promise<{ task: Task }>;
}

function makeMockStore(overrides?: {
  createTask?: RequestTaskStore['createTask'];
  getTask?: RequestTaskStore['getTask'];
  storeTaskResult?: RequestTaskStore['storeTaskResult'];
  updateTaskStatus?: RequestTaskStore['updateTaskStatus'];
}): RequestTaskStore & { stored: { taskId: string; status: string; result: CallToolResult }[] } {
  const stored: { taskId: string; status: string; result: CallToolResult }[] = [];
  return {
    stored,
    createTask: overrides?.createTask ?? (async () => ({ taskId: 'task-1' }) as Task),
    getTask:
      overrides?.getTask ?? (async (taskId: string) => ({ taskId, status: 'completed' }) as Task),
    getTaskResult: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    storeTaskResult:
      overrides?.storeTaskResult ??
      (async (taskId: string, status: string, result: CallToolResult) => {
        stored.push({ taskId, status, result });
      }),
    updateTaskStatus: overrides?.updateTaskStatus ?? (async () => {}),
    listTasks: async () => ({ tasks: [] }),
  };
}

function makeMockContext(
  store: RequestTaskStore,
  overrides?: {
    elicitInput?: ServerContext['mcpReq']['elicitInput'];
    log?: ServerContext['mcpReq']['log'];
  },
): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      signal: new AbortController().signal,
      log:
        overrides?.log ??
        Object.assign(async () => {}, {
          debug: async () => {},
          info: async () => {},
          warning: async () => {},
          error: async () => {},
        }),
      notify: async () => {},
      elicitInput:
        overrides?.elicitInput ??
        (async () => ({
          action: 'accept',
          content: { confirm: true },
        })),
    },
    task: {
      store,
      requestedTtl: undefined,
      id: undefined,
    },
  } as unknown as ServerContext;
}

function getDeleteCacheHandler(): DeleteCacheTaskHandler {
  let deleteHandler: DeleteCacheTaskHandler | undefined;

  registerCacheTools({
    server: {
      getClientCapabilities: () => undefined,
      listRoots: async () => ({ roots: [] }),
    },
    registerTool: () => {},
    experimental: {
      tasks: {
        registerToolTask: (name: string, _config: unknown, handler: DeleteCacheTaskHandler) => {
          if (name === 'delete_cache') {
            deleteHandler = handler;
          }
        },
      },
    },
  } as never);

  assert.ok(deleteHandler);
  return deleteHandler;
}

async function flushTaskWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('cache tool registration contract', () => {
  it('keeps list_caches as the non-tasked read-only outlier', () => {
    const registeredTools: string[] = [];
    const registeredTaskTools: string[] = [];

    registerCacheTools({
      registerTool: (name: string) => {
        registeredTools.push(name);
      },
      experimental: {
        tasks: {
          registerToolTask: (name: string) => {
            registeredTaskTools.push(name);
          },
        },
      },
    } as never);

    assert.deepStrictEqual(registeredTools, ['list_caches']);
    assert.deepStrictEqual(registeredTaskTools, ['create_cache', 'delete_cache', 'update_cache']);
  });

  it('skips interactive confirmation when confirm=true', async () => {
    const handler = getDeleteCacheHandler();
    const store = makeMockStore();
    let elicitationCalls = 0;
    const deleted: string[] = [];
    const client = getAI();
    const originalDelete = client.caches.delete.bind(client.caches);

    // @ts-expect-error test override
    client.caches.delete = async (opts: { name: string }) => {
      deleted.push(opts.name);
    };

    try {
      await handler.createTask(
        { cacheName: 'cachedContents/abc123', confirm: true },
        makeMockContext(store, {
          elicitInput: async () => {
            elicitationCalls += 1;
            return { action: 'accept', content: { confirm: true } };
          },
        }),
      );

      await flushTaskWork();

      assert.strictEqual(elicitationCalls, 0);
      assert.deepStrictEqual(deleted, ['cachedContents/abc123']);
      assert.strictEqual(store.stored.length, 1);
      assert.strictEqual(store.stored[0]?.status, 'completed');
      assert.deepStrictEqual(store.stored[0]?.result.structuredContent, {
        cacheName: 'cachedContents/abc123',
        deleted: true,
      });
    } finally {
      client.caches.delete = originalDelete;
    }
  });

  it('returns a clear non-error result when elicitation is unavailable and confirm is not true', async () => {
    const handler = getDeleteCacheHandler();
    const store = makeMockStore();
    let deleteCalls = 0;
    const client = getAI();
    const originalDelete = client.caches.delete.bind(client.caches);

    // @ts-expect-error test override
    client.caches.delete = async () => {
      deleteCalls += 1;
    };

    try {
      await handler.createTask(
        { cacheName: 'cachedContents/abc123' },
        makeMockContext(store, {
          elicitInput: async () => {
            throw new Error('elicitation unsupported');
          },
        }),
      );

      await flushTaskWork();

      assert.strictEqual(deleteCalls, 0);
      assert.strictEqual(store.stored.length, 1);
      assert.strictEqual(store.stored[0]?.status, 'completed');
      assert.strictEqual(store.stored[0]?.result.isError, undefined);
      assert.deepStrictEqual(store.stored[0]?.result.structuredContent, {
        cacheName: 'cachedContents/abc123',
        deleted: false,
        confirmationRequired: true,
      });
      const firstContent = store.stored[0]?.result.content[0];
      assert.ok(firstContent);
      assert.strictEqual(firstContent.type, 'text');
      assert.match(
        'text' in firstContent ? firstContent.text : '',
        /Interactive confirmation is unavailable\. Re-run delete_cache with confirm=true/i,
      );
    } finally {
      client.caches.delete = originalDelete;
    }
  });

  it('returns deleted=false without confirmationRequired when the user declines deletion', async () => {
    const handler = getDeleteCacheHandler();
    const store = makeMockStore();
    let deleteCalls = 0;
    const client = getAI();
    const originalDelete = client.caches.delete.bind(client.caches);

    // @ts-expect-error test override
    client.caches.delete = async () => {
      deleteCalls += 1;
    };

    try {
      await handler.createTask(
        { cacheName: 'cachedContents/abc123' },
        makeMockContext(store, {
          elicitInput: async () => ({
            action: 'decline',
          }),
        }),
      );

      await flushTaskWork();

      assert.strictEqual(deleteCalls, 0);
      assert.strictEqual(store.stored[0]?.status, 'completed');
      assert.deepStrictEqual(store.stored[0]?.result.structuredContent, {
        cacheName: 'cachedContents/abc123',
        deleted: false,
      });
    } finally {
      client.caches.delete = originalDelete;
    }
  });
});
