import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import type { MemoryInput } from '../../src/schemas/inputs.js';
import { MemoryOutputSchema } from '../../src/schemas/outputs.js';
import { buildCreateCacheWork, memoryWork } from '../../src/tools/memory.js';

function createContext(elicitInput?: (request: unknown) => Promise<unknown>): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      log: async () => undefined,
      notify: async () => undefined,
      signal: new AbortController().signal,
      elicitInput: elicitInput ?? (async () => ({ action: 'decline' })),
    },
  } as unknown as ServerContext;
}

const emptyRootsFetcher = () => Promise.resolve([]);
const passthroughCreateCacheWork = () =>
  Promise.resolve({ content: [{ type: 'text' as const, text: 'unused' }] });

describe('memoryWork', () => {
  it('throws an invariant error for actions that bypass enum validation', async () => {
    await assert.rejects(
      async () =>
        memoryWork(
          {} as never,
          emptyRootsFetcher,
          passthroughCreateCacheWork,
          { action: 'unknown.action' } as unknown as MemoryInput,
          createContext(),
        ),
      /Unhandled action 'unknown\.action'/,
    );
  });

  it('caches.create surfaces a tool-level error when Gemini returns no cache name', async () => {
    const client = getAI();
    const originalCreate = client.caches.create.bind(client.caches);
    const originalList = client.caches.list.bind(client.caches);
    // @ts-expect-error test override — simulate malformed SDK response
    client.caches.create = async () => ({ name: undefined });
    // @ts-expect-error test override — avoid network during cleanupOldCaches
    client.caches.list = (async () => ({
      async *[Symbol.asyncIterator]() {
        // no caches
      },
    })) as typeof client.caches.list;

    const createCacheWork = buildCreateCacheWork(emptyRootsFetcher);

    try {
      await assert.rejects(
        async () =>
          memoryWork(
            {} as never,
            emptyRootsFetcher,
            createCacheWork,
            {
              action: 'caches.create',
              systemInstruction: 'You are a test cache.',
            },
            createContext(),
          ),
        /no resource name/,
      );
    } finally {
      client.caches.create = originalCreate;
      client.caches.list = originalList;
    }
  });

  it('caches.delete declined path returns confirmationRequired: false', async () => {
    const client = getAI();
    const originalDelete = client.caches.delete.bind(client.caches);
    // @ts-expect-error test override — should never be reached on a declined flow
    client.caches.delete = async () => {
      throw new Error('caches.delete must not be called on a declined flow');
    };

    try {
      const result = await memoryWork(
        {} as never,
        emptyRootsFetcher,
        passthroughCreateCacheWork,
        {
          action: 'caches.delete',
          cacheName: 'cachedContents/mock-declined',
        },
        createContext(async () => ({
          action: 'accept',
          content: { confirm: false },
        })),
      );

      assert.notStrictEqual(result.isError, true);
      const structured = result.structuredContent as {
        deleted?: boolean;
        confirmationRequired?: boolean;
      };
      assert.strictEqual(structured.deleted, false);
      assert.strictEqual(structured.confirmationRequired, false);
    } finally {
      client.caches.delete = originalDelete;
    }
  });

  it('caches.update returns cache.name and validates against MemoryOutputSchema', async () => {
    const client = getAI();
    const originalUpdate = client.caches.update.bind(client.caches);
    // @ts-expect-error test override — simulate SDK response with upstream resource name
    client.caches.update = async () => ({
      name: 'cachedContents/abc',
      expireTime: '2030-01-01T00:00:00Z',
    });

    try {
      const result = await memoryWork(
        {} as never,
        emptyRootsFetcher,
        passthroughCreateCacheWork,
        {
          action: 'caches.update',
          cacheName: 'cachedContents/abc',
          ttl: '3600s',
        },
        createContext(),
      );

      assert.notStrictEqual(result.isError, true);
      const structured = result.structuredContent as {
        cache?: { name?: string; expireTime?: string };
      };
      assert.strictEqual(structured.cache?.name, 'cachedContents/abc');
      assert.strictEqual(structured.cache?.expireTime, '2030-01-01T00:00:00Z');
      const parsed = MemoryOutputSchema.safeParse(result.structuredContent);
      assert.strictEqual(parsed.success, true);
    } finally {
      client.caches.update = originalUpdate;
    }
  });

  it('caches.get maps structured not-found errors to a tool-level error', async () => {
    const client = getAI();
    const originalGet = client.caches.get.bind(client.caches);
    // @ts-expect-error test override — simulate structured not-found response from SDK
    client.caches.get = async () => {
      const err = new Error('missing cache') as Error & { code?: string; status?: number };
      err.code = 'NOT_FOUND';
      err.status = 404;
      throw err;
    };

    try {
      const result = await memoryWork(
        {} as never,
        emptyRootsFetcher,
        passthroughCreateCacheWork,
        {
          action: 'caches.get',
          cacheName: 'cachedContents/missing',
        },
        createContext(),
      );

      assert.strictEqual(result.isError, true);
      assert.match(result.content[0]?.text ?? '', /Cache 'cachedContents\/missing' not found\./);
    } finally {
      client.caches.get = originalGet;
    }
  });

  it('caches.delete unsupported-elicitation path produces schema-valid output', async () => {
    const result = await memoryWork(
      {} as never,
      emptyRootsFetcher,
      passthroughCreateCacheWork,
      {
        action: 'caches.delete',
        cacheName: 'cachedContents/mock-unsupported',
      },
      createContext(async () => {
        throw new Error('elicitation unsupported');
      }),
    );

    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      deleted?: boolean;
      confirmationRequired?: boolean;
    };
    assert.strictEqual(structured.deleted, false);
    assert.strictEqual(structured.confirmationRequired, true);
    const parsed = MemoryOutputSchema.safeParse(result.structuredContent);
    assert.strictEqual(parsed.success, true);
  });

  it('caches.delete declined path validates against MemoryOutputSchema', async () => {
    const client = getAI();
    const originalDelete = client.caches.delete.bind(client.caches);
    // @ts-expect-error test override — should never be reached on a declined flow
    client.caches.delete = async () => {
      throw new Error('caches.delete must not be called on a declined flow');
    };

    try {
      const result = await memoryWork(
        {} as never,
        emptyRootsFetcher,
        passthroughCreateCacheWork,
        {
          action: 'caches.delete',
          cacheName: 'cachedContents/mock-declined-parse',
        },
        createContext(async () => ({
          action: 'accept',
          content: { confirm: false },
        })),
      );

      assert.notStrictEqual(result.isError, true);
      const parsed = MemoryOutputSchema.safeParse(result.structuredContent);
      assert.strictEqual(parsed.success, true);
    } finally {
      client.caches.delete = originalDelete;
    }
  });
});
