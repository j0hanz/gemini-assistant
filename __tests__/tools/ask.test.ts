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
    const originalEnabled = process.env.CACHE;
    const originalAllowedRoots = process.env.ROOTS;
    const originalGetOrCreateCache =
      workspaceCacheManager.getOrCreateCache.bind(workspaceCacheManager);
    process.env.CACHE = 'true';
    const allowedRoot = await mkdtemp(join(tmpdir(), 'ask-workspace-cache-'));

    let observedCacheName: string | undefined;
    let observedRoots: string[] | undefined;
    process.env.ROOTS = allowedRoot;
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
      process.env.CACHE = originalEnabled;
      process.env.ROOTS = originalAllowedRoots;
      workspaceCacheManager.getOrCreateCache = originalGetOrCreateCache;
      await rm(allowedRoot, { recursive: true, force: true });
    }
  });

  it('does not auto-apply workspace cache when resuming an existing session', async () => {
    const originalEnabled = process.env.CACHE;
    const originalGetOrCreateCache =
      workspaceCacheManager.getOrCreateCache.bind(workspaceCacheManager);
    process.env.CACHE = 'true';

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
      process.env.CACHE = originalEnabled;
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
