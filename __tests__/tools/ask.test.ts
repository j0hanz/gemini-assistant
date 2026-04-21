import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { workspaceCacheManager } from '../../src/lib/workspace-context.js';
import { chatWork, createAskWork } from '../../src/tools/chat.js';

function createContext(): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      log: async () => undefined,
      notify: async () => undefined,
      signal: new AbortController().signal,
    },
  } as unknown as ServerContext;
}

function createDeps(overrides: Partial<Parameters<typeof createAskWork>[0]> = {}) {
  return {
    appendSessionEvent: () => true,
    appendSessionTranscript: () => true,
    createChat: () => ({ kind: 'chat' }) as never,
    getSession: () => undefined,
    getSessionEntry: () => undefined,
    isEvicted: () => false,
    listSessionTranscriptEntries: () => undefined,
    now: () => 1,
    runWithoutSession: async (args: Record<string, unknown>) =>
      ({
        result: {
          content: [{ type: 'text' as const, text: 'Assistant answer' }],
          structuredContent: { answer: 'Assistant answer' },
        },
        streamResult: {
          functionCalls: [],
          parts: [],
          text: 'Assistant answer',
          thoughtText: '',
          toolEvents: [],
          toolsUsed: [],
        },
        toolProfile: 'none' as const,
        observedArgs: args,
      }) as never,
    setSession: () => undefined,
    ...overrides,
  };
}

describe('ask contract', () => {
  it('returns the exact validation error for expired sessions', async () => {
    const askWork = createAskWork(
      createDeps({
        isEvicted: (sessionId?: string) => sessionId === 'sess-expired',
      }),
    );

    const result = await askWork(
      {
        message: 'hello',
        sessionId: 'sess-expired',
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      content: [
        {
          type: 'text',
          text: "chat: Session 'sess-expired' has expired.",
        },
      ],
      isError: true,
    });
  });

  it('returns the exact validation error for cacheName plus systemInstruction', async () => {
    const askWork = createAskWork(createDeps());

    const result = await askWork(
      {
        message: 'hello',
        cacheName: 'cachedContents/abc123',
        systemInstruction: 'system',
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      content: [
        {
          type: 'text',
          text: 'chat: systemInstruction cannot be used with cacheName. Embed the system instruction in the cache via memory action=caches.create instead.',
        },
      ],
      isError: true,
    });
    assert.doesNotMatch(result.content[0]?.text ?? '', /\bask\b|create_cache/);
  });

  it('returns the exact validation error for cacheName plus existing session', async () => {
    const askWork = createAskWork(
      createDeps({
        getSessionEntry: (sessionId?: string) =>
          sessionId === 'sess-1' ? ({ id: 'sess-1' } as never) : undefined,
      }),
    );

    const result = await askWork(
      {
        message: 'hello',
        sessionId: 'sess-1',
        cacheName: 'cachedContents/abc123',
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      content: [
        {
          type: 'text',
          text: 'chat: Cannot apply cached content to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
        },
      ],
      isError: true,
    });
    assert.doesNotMatch(result.content[0]?.text ?? '', /\bask\b|cachedContent/);
  });

  it('returns the exact validation error for cacheName plus generation controls', async () => {
    const askWork = createAskWork(createDeps());

    const result = await askWork(
      {
        message: 'hello',
        cacheName: 'cachedContents/abc123',
        temperature: 0.4,
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      content: [
        {
          type: 'text',
          text: 'chat: temperature and seed cannot be used with cacheName. Generation parameters are fixed when the cache is created.',
        },
      ],
      isError: true,
    });
  });

  it('returns the exact validation error for responseSchema plus existing session', async () => {
    const askWork = createAskWork(
      createDeps({
        getSessionEntry: (sessionId?: string) =>
          sessionId === 'sess-1' ? ({ id: 'sess-1' } as never) : undefined,
      }),
    );

    const result = await askWork(
      {
        message: 'hello',
        sessionId: 'sess-1',
        responseSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
        },
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      content: [
        {
          type: 'text',
          text: 'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
        },
      ],
      isError: true,
    });
  });

  it('auto-applies workspace cache metadata on single-turn calls', async () => {
    const originalEnabled = process.env.WORKSPACE_CACHE_ENABLED;
    const originalAllowedRoots = process.env.ALLOWED_FILE_ROOTS;
    const originalGetOrCreateCache =
      workspaceCacheManager.getOrCreateCache.bind(workspaceCacheManager);
    process.env.WORKSPACE_CACHE_ENABLED = 'true';
    const allowedRoot = await mkdtemp(join(tmpdir(), 'ask-workspace-cache-'));

    let observedCacheName: string | undefined;
    let observedRoots: string[] | undefined;
    process.env.ALLOWED_FILE_ROOTS = allowedRoot;
    workspaceCacheManager.getOrCreateCache = async (roots) => {
      observedRoots = roots;
      return 'cachedContents/workspace-1';
    };
    const askWork = createAskWork(
      createDeps({
        runWithoutSession: async (args: Record<string, unknown>) => {
          observedCacheName = args.cacheName as string | undefined;
          return {
            result: {
              content: [{ type: 'text' as const, text: 'Assistant answer' }],
              structuredContent: { answer: 'Assistant answer' },
            },
            streamResult: {
              functionCalls: [],
              parts: [],
              text: 'Assistant answer',
              thoughtText: '',
              toolEvents: [],
              toolsUsed: [],
            },
            toolProfile: 'none' as const,
          } as never;
        },
      }),
    );

    try {
      const result = await askWork({ message: 'hello' }, createContext());

      assert.strictEqual(observedCacheName, 'cachedContents/workspace-1');
      assert.deepStrictEqual(observedRoots, [allowedRoot]);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(structured.answer, 'Assistant answer');
      const contextUsed = structured.contextUsed as Record<string, unknown>;
      assert.strictEqual(contextUsed.workspaceCacheApplied, true);
      assert.ok(Array.isArray(contextUsed.sources));
    } finally {
      process.env.WORKSPACE_CACHE_ENABLED = originalEnabled;
      process.env.ALLOWED_FILE_ROOTS = originalAllowedRoots;
      workspaceCacheManager.getOrCreateCache = originalGetOrCreateCache;
      await rm(allowedRoot, { recursive: true, force: true });
    }
  });

  it('does not auto-apply workspace cache when resuming an existing session', async () => {
    const originalEnabled = process.env.WORKSPACE_CACHE_ENABLED;
    const originalGetOrCreateCache =
      workspaceCacheManager.getOrCreateCache.bind(workspaceCacheManager);
    process.env.WORKSPACE_CACHE_ENABLED = 'true';

    let workspaceCalls = 0;
    let observedCacheName: string | undefined;
    workspaceCacheManager.getOrCreateCache = async () => {
      workspaceCalls++;
      return 'cachedContents/workspace-1';
    };

    const askWork = createAskWork(
      createDeps({
        getSession: () => ({ kind: 'chat' }) as never,
        getSessionEntry: () => ({ id: 'sess-1' }) as never,
        runWithoutSession: async (args: Record<string, unknown>) => {
          observedCacheName = args.cacheName as string | undefined;
          return {
            result: {
              content: [{ type: 'text' as const, text: 'Assistant answer' }],
              structuredContent: { answer: 'Assistant answer' },
            },
            streamResult: {
              functionCalls: [],
              parts: [],
              text: 'Assistant answer',
              thoughtText: '',
              toolEvents: [],
              toolsUsed: [],
            },
            toolProfile: 'none' as const,
          } as never;
        },
      }),
    );

    try {
      const result = await askWork({ message: 'hello', sessionId: 'sess-1' }, createContext());

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(workspaceCalls, 0);
      assert.strictEqual(observedCacheName, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(structured.answer, 'Assistant answer');
      const contextUsed = structured.contextUsed as Record<string, unknown>;
      assert.strictEqual(contextUsed.workspaceCacheApplied, false);
    } finally {
      process.env.WORKSPACE_CACHE_ENABLED = originalEnabled;
      workspaceCacheManager.getOrCreateCache = originalGetOrCreateCache;
    }
  });

  it('chatWork forwards a validated responseSchema parsed from responseSchemaJson', async () => {
    const originalJsonParse = JSON.parse.bind(JSON);
    let jsonParseCalls = 0;
    let observedResponseSchema: unknown;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      jsonParseCalls++;
      return originalJsonParse(...args) as unknown;
    }) as typeof JSON.parse;

    try {
      const result = await chatWork(
        async (args) => {
          observedResponseSchema = args.responseSchema;
          return {
            content: [{ type: 'text', text: 'Assistant answer' }],
            structuredContent: { answer: 'Assistant answer' },
          };
        },
        {
          goal: 'return JSON',
          responseSchemaJson: JSON.stringify({
            type: 'object',
            properties: { answer: { type: 'string' } },
          }),
        },
        createContext(),
      );

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(jsonParseCalls, 1);
      assert.deepStrictEqual(observedResponseSchema, {
        type: 'object',
        properties: { answer: { type: 'string' } },
      });
    } finally {
      JSON.parse = originalJsonParse;
    }
  });
});
