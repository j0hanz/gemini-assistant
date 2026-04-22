import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import { getAI } from '../../src/client.js';
import { workspaceCacheManager } from '../../src/lib/workspace-context.js';
import {
  askWithoutSession,
  buildRebuiltChatContents,
  chatWork,
  createAskWork,
} from '../../src/tools/chat.js';

function createContext(): ServerContext {
  return createContextWithSignal(new AbortController().signal);
}

function createContextWithSignal(signal: AbortSignal): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      log: async () => undefined,
      notify: async () => undefined,
      signal,
    },
  } as unknown as ServerContext;
}

async function* fakeStream(text: string): AsyncGenerator {
  yield {
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
  };
}

function withGeminiStreamStub(responses: (string | (() => AsyncGenerator))[]): {
  calls: Record<string, unknown>[];
  restore: () => void;
} {
  process.env.API_KEY ??= 'test-key-for-ask';
  const client = getAI();
  const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
  const calls: Record<string, unknown>[] = [];

  // @ts-expect-error test override
  client.models.generateContentStream = async (request: Record<string, unknown>) => {
    calls.push(request);
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof response === 'function' ? response() : fakeStream(response ?? '');
  };

  return {
    calls,
    restore: () => {
      client.models.generateContentStream = originalGenerateContentStream;
    },
  };
}

function createDeps(overrides: Partial<Parameters<typeof createAskWork>[0]> = {}) {
  return {
    appendSessionEvent: () => true,
    appendSessionContent: () => true,
    appendSessionTranscript: () => true,
    createChat: () => ({ kind: 'chat' }) as never,
    getSession: () => undefined,
    getSessionEntry: () => undefined,
    isEvicted: () => false,
    listSessionContentEntries: () => undefined,
    listSessionTranscriptEntries: () => undefined,
    rebuildChat: () => undefined,
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
          toolsUsedOccurrences: [],
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

  it('returns the exact validation error for responseSchema plus googleSearch', async () => {
    const askWork = createAskWork(createDeps());

    const result = await askWork(
      {
        message: 'hello',
        googleSearch: true,
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
          text: 'chat: responseSchema cannot be combined with built-in tools (googleSearch, urlContext, codeExecution)',
        },
      ],
      isError: true,
    });
  });

  it('returns the exact validation error for responseSchema plus url context', async () => {
    const askWork = createAskWork(createDeps());

    const result = await askWork(
      {
        message: 'hello',
        responseSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
        },
        urls: ['https://example.com'],
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      content: [
        {
          type: 'text',
          text: 'chat: responseSchema cannot be combined with built-in tools (googleSearch, urlContext, codeExecution)',
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
              toolsUsedOccurrences: [],
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
              toolsUsedOccurrences: [],
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

  it('chatWork returns a tool error for unsupported responseSchemaJson $ref usage', async () => {
    const result = await chatWork(
      async () =>
        ({
          content: [{ type: 'text', text: 'Assistant answer' }],
          structuredContent: { answer: 'Assistant answer' },
        }) as never,
      {
        goal: 'return JSON',
        responseSchemaJson: JSON.stringify({
          type: 'object',
          properties: { answer: { $ref: '#/$defs/Answer' } },
          $defs: {
            Answer: { type: 'string' },
          },
        }),
      },
      createContext(),
    );

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /\$ref is not supported/);
  });

  it('retries once with repair suffix when first JSON response fails schema validation', async () => {
    const originalCache = process.env.CACHE;
    process.env.CACHE = 'false';
    const stub = withGeminiStreamStub(['{"count":"bad"}', '{"count":2}']);

    try {
      const askWork = createAskWork();
      const result = await askWork(
        {
          message: 'Return a count',
          responseSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
          },
        },
        createContext(),
      );

      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(result.isError, undefined);
      assert.deepStrictEqual(structured.data, { count: 2 });
      assert.strictEqual(structured.schemaWarnings, undefined);
      assert.strictEqual(stub.calls.length, 2);
      assert.strictEqual(typeof stub.calls[1]?.contents, 'string');
      assert.match(
        stub.calls[1].contents,
        /CRITICAL: The previous response was invalid JSON or failed schema validation/,
      );
    } finally {
      process.env.CACHE = originalCache;
      stub.restore();
    }
  });

  it('surfaces schemaWarnings after single retry exhaustion', async () => {
    const originalCache = process.env.CACHE;
    process.env.CACHE = 'false';
    const stub = withGeminiStreamStub(['{not json}', '{still not json}']);

    try {
      const askWork = createAskWork();
      const result = await askWork(
        {
          message: 'Return a count',
          responseSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
          },
        },
        createContext(),
      );

      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(structured.data, undefined);
      assert.ok(Array.isArray(structured.schemaWarnings));
      assert.strictEqual(stub.calls.length, 2);
    } finally {
      process.env.CACHE = originalCache;
      stub.restore();
    }
  });

  it('does not retry when sessionId is set', async () => {
    const originalCache = process.env.CACHE;
    process.env.CACHE = 'false';
    let sendCalls = 0;
    const chat = {
      sendMessageStream: async () => {
        sendCalls++;
        return fakeStream('{not json}');
      },
    };

    try {
      const askResult = await askWithoutSession(
        {
          message: 'Need JSON',
          sessionId: 'sess-new-json',
          responseSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
          },
        },
        createContext(),
        chat as never,
      );
      const result = askResult.result;

      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(sendCalls, 1);
      assert.ok(Array.isArray(structured.schemaWarnings));
    } finally {
      process.env.CACHE = originalCache;
    }
  });

  it('does not retry when aborted', async () => {
    const originalCache = process.env.CACHE;
    process.env.CACHE = 'false';
    const controller = new AbortController();
    const stub = withGeminiStreamStub([
      async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: '{not json}' }] },
              finishReason: 'STOP',
            },
          ],
        };
        controller.abort();
      },
      '{"count":2}',
    ]);

    try {
      const askWork = createAskWork();
      const result = await askWork(
        {
          message: 'Return a count',
          responseSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
          },
        },
        createContextWithSignal(controller.signal),
      );

      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(stub.calls.length, 1);
      assert.ok(Array.isArray(structured.schemaWarnings));
    } finally {
      process.env.CACHE = originalCache;
      stub.restore();
    }
  });

  it('stores replay-safe content entries for successful session turns', async () => {
    const originalCache = process.env.CACHE;
    process.env.CACHE = 'false';
    const contentEntries: Record<string, unknown>[] = [];
    const askWork = createAskWork(
      createDeps({
        appendSessionContent: (_sessionId, item) => {
          contentEntries.push(item as unknown as Record<string, unknown>);
          return true;
        },
        runWithoutSession: async () =>
          ({
            result: {
              content: [{ type: 'text' as const, text: 'Need tool result' }],
              structuredContent: { answer: 'Need tool result' },
            },
            streamResult: {
              functionCalls: [{ name: 'lookup', args: { q: 'x' } }],
              parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }],
              text: 'Need tool result',
              thoughtText: '',
              toolEvents: [{ kind: 'function_call', name: 'lookup', args: { q: 'x' } }],
              toolsUsed: ['lookup'],
              toolsUsedOccurrences: ['lookup'],
              hadCandidate: true,
            },
            toolProfile: 'none' as const,
          }) as never,
      }),
    );

    try {
      await askWork({ message: 'Call lookup', sessionId: 'sess-content' }, createContext());
    } finally {
      if (originalCache === undefined) {
        delete process.env.CACHE;
      } else {
        process.env.CACHE = originalCache;
      }
    }

    assert.deepStrictEqual(
      contentEntries.map((entry) => entry['role']),
      ['user', 'model'],
    );
    assert.deepStrictEqual(contentEntries[1]?.['parts'], [
      { functionCall: { name: 'lookup', args: { q: 'x' } } },
    ]);
  });

  it('builds rebuilt chat history from full content parts', () => {
    const history = buildRebuiltChatContents(
      [
        {
          role: 'user',
          parts: [{ text: 'Call lookup' }],
          timestamp: 1,
        },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }],
          timestamp: 1,
        },
      ],
      200_000,
    );

    assert.deepStrictEqual(history, [
      { role: 'user', parts: [{ text: 'Call lookup' }] },
      { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] },
    ]);
  });

  it('persists sentMessage for rebuilt sessions with summaries and stores finishReason', async () => {
    const events: Record<string, unknown>[] = [];
    const transcript = [
      { role: 'user' as const, text: 'previous question', timestamp: 1 },
      { role: 'assistant' as const, text: 'previous answer', timestamp: 2 },
    ];
    const askWork = createAskWork(
      createDeps({
        appendSessionEvent: (_sessionId, item) => {
          events.push(item);
          return true;
        },
        getSessionEntry: (sessionId?: string) =>
          sessionId === 'sess-rebuilt'
            ? { id: sessionId, lastAccess: 1, transcriptCount: 2, eventCount: 0 }
            : undefined,
        listSessionTranscriptEntries: () => transcript,
        rebuildChat: () => ({ kind: 'rebuilt-chat' }) as never,
        runWithoutSession: async (args: Record<string, unknown>) =>
          ({
            result: {
              content: [{ type: 'text' as const, text: 'Assistant answer' }],
              structuredContent: { answer: 'Assistant answer' },
            },
            streamResult: {
              functionCalls: [],
              parts: [{ text: 'Assistant answer' }],
              text: 'Assistant answer',
              thoughtText: '',
              toolEvents: [],
              toolsUsed: [],
              toolsUsedOccurrences: [],
              finishReason: FinishReason.STOP,
              hadCandidate: true,
            },
            sentMessage: args.message,
            toolProfile: 'none' as const,
          }) as never,
      }),
    );

    await askWork({ message: 'follow up', sessionId: 'sess-rebuilt' }, createContext());

    const event = events[0] as {
      request?: { message?: string; sentMessage?: string };
      response?: { finishReason?: string };
    };
    assert.strictEqual(event.request?.message, 'follow up');
    assert.match(event.request?.sentMessage ?? '', /previous question/);
    assert.match(event.request?.sentMessage ?? '', /\n\nfollow up$/);
    assert.strictEqual(event.response?.finishReason, FinishReason.STOP);
  });

  it('passes maxOutputTokens through to the Gemini config', async () => {
    const stub = withGeminiStreamStub(['Assistant answer']);
    const originalCache = process.env.CACHE;
    process.env.CACHE = 'false';

    try {
      const askWork = createAskWork();
      await askWork(
        {
          message: 'Return a short answer',
          maxOutputTokens: 12_345,
        },
        createContext(),
      );

      assert.strictEqual(
        stub.calls[0]?.config &&
          (stub.calls[0].config as { maxOutputTokens?: number }).maxOutputTokens,
        12_345,
      );
    } finally {
      process.env.CACHE = originalCache;
      stub.restore();
    }
  });
});
