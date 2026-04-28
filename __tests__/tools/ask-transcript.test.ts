import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import { toToolSessionAccess, toToolWorkspaceAccess } from '../../src/lib/tool-context.js';
import { createWorkspaceCacheManager } from '../../src/lib/workspace-context.js';
import {
  appendSessionTurn,
  buildSessionEventRequest,
  buildSessionEventResponse,
  createSessionStore,
} from '../../src/sessions.js';
import {
  createAskWork as createBaseAskWork,
  createDefaultAskDependencies,
} from '../../src/tools/chat.js';

const workspaceCacheManager = createWorkspaceCacheManager();

function createAskWork(
  deps: Parameters<typeof createBaseAskWork>[0],
  manager = workspaceCacheManager,
) {
  return createBaseAskWork(deps, toToolWorkspaceAccess(manager));
}

let previousCacheEnv: string | undefined;

beforeEach(() => {
  previousCacheEnv = process.env.CACHE;
  process.env.CACHE = 'false';
});

afterEach(() => {
  if (previousCacheEnv === undefined) {
    delete process.env.CACHE;
  } else {
    process.env.CACHE = previousCacheEnv;
  }
});

function createContext(taskId?: string): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      log: async () => undefined,
      notify: async () => undefined,
      signal: new AbortController().signal,
    },
    ...(taskId ? { task: { id: taskId } } : {}),
  } as unknown as ServerContext;
}

async function withSessionResourcesExposed<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.MCP_EXPOSE_SESSION_RESOURCES;
  process.env.MCP_EXPOSE_SESSION_RESOURCES = 'true';
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.MCP_EXPOSE_SESSION_RESOURCES;
    } else {
      process.env.MCP_EXPOSE_SESSION_RESOURCES = original;
    }
  }
}

function createHarness() {
  const sessions = new Map<
    string,
    {
      contents: Record<string, unknown>[];
      events: Record<string, unknown>[];
      transcript: Record<string, unknown>[];
    }
  >();
  let nowValue = 0;

  return {
    sessions,
    deps: {
      appendSessionEvent: (sessionId: string, entry: Record<string, unknown>) => {
        const session = sessions.get(sessionId);
        if (!session) return false;
        session.events.push(entry);
        return true;
      },
      appendSessionContent: (sessionId: string, entry: Record<string, unknown>) => {
        const session = sessions.get(sessionId);
        if (!session) return false;
        session.contents.push(entry);
        return true;
      },
      appendSessionTranscript: (sessionId: string, entry: Record<string, unknown>) => {
        const session = sessions.get(sessionId);
        if (!session) return false;
        session.transcript.push(entry);
        return true;
      },
      createChat: () => ({ chat: { kind: 'chat' } as never }),
      getSession: (sessionId: string) =>
        sessions.has(sessionId) ? ({ kind: 'chat' } as never) : undefined,
      getSessionEntry: (sessionId: string) =>
        sessions.has(sessionId) ? ({ id: sessionId, lastAccess: 0 } as never) : undefined,
      isEvicted: () => false,
      listSessionContentEntries: (sessionId: string) => sessions.get(sessionId)?.contents as never,
      listSessionTranscriptEntries: (sessionId: string) =>
        sessions.get(sessionId)?.transcript as never,
      now: () => {
        nowValue += 1;
        return nowValue;
      },
      runWithoutSession: async () => ({
        result: {
          content: [{ type: 'text' as const, text: 'Assistant answer' }],
        },
        streamResult: {
          functionCalls: [],
          parts: [],
          text: 'Assistant answer',
          textByWave: ['Assistant answer'],
          thoughtText: '',
          toolEvents: [],
          toolsUsed: [],
          toolsUsedOccurrences: [],
        },
        toolProfile: 'none' as const,
      }),
      setSession: (sessionId: string) => {
        sessions.set(sessionId, { contents: [], events: [], transcript: [] });
      },
      rebuildChat: () => undefined,
    },
  };
}

function createAskExecutionResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    result: {
      content: [{ type: 'text' as const, text: 'Assistant answer' }],
      structuredContent: {
        answer: 'Assistant answer',
      },
    },
    streamResult: {
      functionCalls: [],
      parts: [],
      text: 'Assistant answer',
      textByWave: ['Assistant answer'],
      thoughtText: '',
      toolEvents: [],
      toolsUsed: [],
      toolsUsedOccurrences: [],
    },
    toolProfile: 'none' as const,
    ...overrides,
  };
}

describe('ask transcript capture', () => {
  it('captures transcript entries when creating a new session', async () => {
    const harness = createHarness();
    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

    const result = await askWork(
      { message: 'Hello', sessionId: 'sess-new' },
      createContext('task-new'),
    );

    assert.strictEqual(result.isError, undefined);
    assert.deepStrictEqual(harness.sessions.get('sess-new')?.transcript, [
      { role: 'user', text: 'Hello', timestamp: 1, taskId: 'task-new' },
      { role: 'assistant', text: 'Assistant answer', timestamp: 1, taskId: 'task-new' },
    ]);
    assert.deepStrictEqual(harness.sessions.get('sess-new')?.events, [
      {
        request: { message: 'Hello' },
        response: { text: 'Assistant answer' },
        timestamp: 2,
        taskId: 'task-new',
      },
    ]);
    assert.ok(
      result.content.some(
        (item) => item.type === 'resource_link' && item.uri === 'session://sess-new',
      ),
    );
    assert.ok(
      !result.content.some(
        (item) => item.type === 'resource_link' && item.uri === 'session://sess-new/events',
      ),
    );
    assert.ok(
      !result.content.some(
        (item) =>
          item.type === 'resource_link' && item.uri === 'gemini://sessions/sess-new/turns/1/parts',
      ),
    );
  });

  it('adds sensitive session resource links only when explicitly enabled', async () => {
    await withSessionResourcesExposed(async () => {
      const harness = createHarness();
      const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

      const result = await askWork(
        { message: 'Hello', sessionId: 'sess-new' },
        createContext('task-new'),
      );

      assert.strictEqual(result.isError, undefined);
      assert.ok(
        result.content.some(
          (item) => item.type === 'resource_link' && item.uri === 'session://sess-new',
        ),
      );
      assert.ok(
        result.content.some(
          (item) => item.type === 'resource_link' && item.uri === 'session://sess-new/transcript',
        ),
      );
      assert.ok(
        result.content.some(
          (item) => item.type === 'resource_link' && item.uri === 'session://sess-new/events',
        ),
      );
      assert.ok(
        result.content.some(
          (item) =>
            item.type === 'resource_link' &&
            item.uri === 'gemini://sessions/sess-new/turns/1/parts',
        ),
      );
    });
  });

  it('encodes session resource links for session IDs with spaces, %, /, and #', async () => {
    const harness = createHarness();
    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);
    const sessionId = 'sess special%/#';

    const result = await askWork({ message: 'Hello', sessionId }, createContext('task-encoded'));

    const encodedSessionId = encodeURIComponent(sessionId);
    assert.strictEqual(result.isError, undefined);
    assert.ok(
      result.content.some(
        (item) => item.type === 'resource_link' && item.uri === `session://${encodedSessionId}`,
      ),
    );
    assert.ok(
      !result.content.some(
        (item) =>
          item.type === 'resource_link' && item.uri === `session://${encodedSessionId}/events`,
      ),
    );
    assert.ok(
      !result.content.some(
        (item) =>
          item.type === 'resource_link' &&
          item.uri === `gemini://sessions/${encodedSessionId}/turns/1/parts`,
      ),
    );
  });

  it('returns an explicit error for transcript-only sessions that cannot be rebuilt', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-legacy', {
      contents: [],
      events: [],
      transcript: [{ role: 'assistant', text: 'Old answer', timestamp: 1 }],
    });
    harness.deps.getSession = () => undefined;
    harness.deps.rebuildChat = () => undefined;
    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

    const result = await askWork(
      { message: 'Follow up', sessionId: 'sess-legacy' },
      createContext(),
    );

    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0]?.text ?? '',
      /session sess-legacy cannot be resumed: no turn parts persisted/,
    );
  });

  it('captures transcript entries when resuming an existing session', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-existing', { contents: [], events: [], transcript: [] });
    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

    await askWork({ message: 'Follow up', sessionId: 'sess-existing' }, createContext('task-2'));

    assert.deepStrictEqual(harness.sessions.get('sess-existing')?.transcript, [
      { role: 'user', text: 'Follow up', timestamp: 1, taskId: 'task-2' },
      { role: 'assistant', text: 'Assistant answer', timestamp: 1, taskId: 'task-2' },
    ]);
    assert.deepStrictEqual(harness.sessions.get('sess-existing')?.events, [
      {
        request: { message: 'Follow up' },
        response: { text: 'Assistant answer' },
        timestamp: 2,
        taskId: 'task-2',
      },
    ]);
  });

  it('does not store transcript entries when result generation fails', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-error', { contents: [], events: [], transcript: [] });
    harness.deps.runWithoutSession = async () => ({
      result: {
        content: [{ type: 'text' as const, text: 'ask failed' }],
        isError: true,
      },
      streamResult: {
        functionCalls: [],
        parts: [],
        text: 'ask failed',
        textByWave: ['ask failed'],
        thoughtText: '',
        toolEvents: [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
      },
      toolProfile: 'none' as const,
    });
    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

    const result = await askWork({ message: 'Break', sessionId: 'sess-error' }, createContext());

    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(harness.sessions.get('sess-error')?.transcript, []);
    assert.deepStrictEqual(harness.sessions.get('sess-error')?.events, []);
  });

  it('persists structured output metadata in session events', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-structured', { contents: [], events: [], transcript: [] });
    harness.deps.runWithoutSession = async () => ({
      result: {
        content: [{ type: 'text' as const, text: '{\n  "status": "ok"\n}' }],
        structuredContent: {
          answer: '{\n  "status": "ok"\n}',
          data: { status: 'ok' },
          thoughts: 'Reasoning summary',
          functionCalls: [{ name: 'lookupWeather', args: { city: 'Stockholm' } }],
          toolEvents: [{ kind: 'tool_call' as const, id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
          usage: { totalTokenCount: 25 },
        },
      },
      streamResult: {
        functionCalls: [],
        parts: [],
        text: '{\n  "status": "ok"\n}',
        textByWave: ['{\n  "status": "ok"\n}'],
        thoughtText: '',
        toolEvents: [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
      },
      toolProfile: 'search' as const,
      urls: ['https://example.com'],
    });
    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

    await askWork(
      { message: 'Need JSON', sessionId: 'sess-structured' },
      createContext('task-structured'),
    );

    assert.deepStrictEqual(harness.sessions.get('sess-structured')?.events, [
      {
        request: {
          message: 'Need JSON',
          toolProfile: 'search',
          urls: ['https://example.com'],
        },
        response: {
          text: '{\n  "status": "ok"\n}',
          data: { status: 'ok' },
          thoughts: 'Reasoning summary',
          functionCalls: [{ name: 'lookupWeather', args: { city: 'Stockholm' } }],
          toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
          usage: { totalTokenCount: 25 },
        },
        timestamp: 2,
        taskId: 'task-structured',
      },
    ]);
  });

  it('truncates large structured payloads before persisting session events', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-large', { contents: [], events: [], transcript: [] });
    harness.deps.runWithoutSession = async () => ({
      result: {
        content: [{ type: 'text' as const, text: 'Assistant answer' }],
        structuredContent: {
          answer: 'Assistant answer',
          data: {
            payload: 'x'.repeat(2500),
            list: Array.from({ length: 25 }, (_, index) => `item-${index}`),
            object: Object.fromEntries(
              Array.from({ length: 60 }, (_, index) => [`key-${index}`, `value-${index}`]),
            ),
          },
          functionCalls: [
            {
              name: 'lookupWeather',
              args: { details: 'y'.repeat(2500) },
            },
          ],
          toolEvents: [
            {
              kind: 'tool_response' as const,
              response: { output: 'z'.repeat(2500) },
              output: 'q'.repeat(2500),
            },
          ],
        },
      },
      streamResult: {
        functionCalls: [],
        parts: [],
        text: 'Assistant answer',
        textByWave: ['Assistant answer'],
        thoughtText: '',
        toolEvents: [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
        hadCandidate: true,
      },
      toolProfile: 'none' as const,
    });

    const askWork = createAskWork(harness.deps as never, workspaceCacheManager);
    await askWork({ message: 'Store large payload', sessionId: 'sess-large' }, createContext());

    const event = harness.sessions.get('sess-large')?.events[0];
    const response = event?.['response'] as Record<string, unknown>;
    const data = response['data'] as Record<string, unknown>;
    const functionCalls = response['functionCalls'] as { args?: Record<string, unknown> }[];
    const toolEvents = response['toolEvents'] as {
      output?: string;
      response?: Record<string, unknown>;
    }[];

    assert.match(String(data['payload']), /\.\.\. \[truncated\]$/);
    assert.strictEqual((data['list'] as unknown[]).length, 20);
    assert.strictEqual(Object.keys(data['object'] as Record<string, unknown>).length, 50);
    assert.match(String(functionCalls[0]?.args?.['details']), /\.\.\. \[truncated\]$/);
    assert.match(String(toolEvents[0]?.response?.['output']), /\.\.\. \[truncated\]$/);
    assert.match(String(toolEvents[0]?.output), /\.\.\. \[truncated\]$/);
  });

  it('persists automatic workspace-cache metadata on new sessions', async () => {
    const originalEnabled = process.env.CACHE;
    const originalRootsFallback = process.env.ROOTS_FALLBACK_CWD;
    const originalGetOrCreateCache =
      workspaceCacheManager.getOrCreateCache.bind(workspaceCacheManager);
    process.env.CACHE = 'true';
    process.env.ROOTS_FALLBACK_CWD = 'true';
    workspaceCacheManager.getOrCreateCache = async () => 'cachedContents/workspace-1';

    try {
      const harness = createHarness();
      const askWork = createAskWork(harness.deps as never, workspaceCacheManager);

      const result = await askWork(
        { message: 'Use workspace context', sessionId: 'sess-workspace' },
        createContext('task-workspace'),
      );

      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(structured.answer, 'Assistant answer');
      const contextUsed = structured.contextUsed as Record<string, unknown>;
      assert.strictEqual(contextUsed.workspaceCacheApplied, true);

      const events = harness.sessions.get('sess-workspace')?.events ?? [];
      assert.strictEqual(events.length, 1);
      const event = events[0];
      assert.ok(event);
      const response = event.response as Record<string, unknown>;
      assert.strictEqual(response.text, 'Assistant answer');
      assert.strictEqual(response.workspaceCache, undefined);
    } finally {
      process.env.CACHE = originalEnabled;
      if (originalRootsFallback === undefined) {
        delete process.env.ROOTS_FALLBACK_CWD;
      } else {
        process.env.ROOTS_FALLBACK_CWD = originalRootsFallback;
      }
      workspaceCacheManager.getOrCreateCache = originalGetOrCreateCache;
    }
  });

  it('preserves stored system instructions when rebuilding a cached session', async () => {
    process.env.API_KEY ??= 'test-key-for-rebuild';
    const sessionStore = createSessionStore();
    const manager = createWorkspaceCacheManager();
    const originalGetCacheStatus = manager.getCacheStatus.bind(manager);
    const ai = getAI();
    const originalCreateChat = ai.chats.create.bind(ai.chats);
    let capturedConfig: Record<string, unknown> | undefined;

    manager.getCacheStatus = () => ({
      cacheName: 'cachedContents/workspace-1',
      contentHash: 'hash',
      enabled: true,
      estimatedTokens: 0,
      sources: [],
      createdAt: Date.now(),
      ttl: '3600s',
    });
    ai.chats.create = ((options: { config?: Record<string, unknown> }) => {
      capturedConfig = options.config;
      return { kind: 'rebuilt-chat' };
    }) as typeof ai.chats.create;

    try {
      sessionStore.setSession(
        'sess-rebuild-cache',
        { kind: 'old-chat' } as never,
        undefined,
        'cachedContents/workspace-1',
        {
          model: 'gemini-3-flash-preview',
          systemInstruction: 'Preserve this instruction',
        },
      );
      sessionStore.appendSessionContent('sess-rebuild-cache', {
        role: 'user',
        parts: [{ text: 'Hello' }],
        timestamp: 1,
      });

      const deps = createDefaultAskDependencies(
        toToolSessionAccess(sessionStore),
        toToolWorkspaceAccess(manager),
      );
      const rebuilt = deps.rebuildChat('sess-rebuild-cache', {
        message: 'Follow up',
        sessionId: 'sess-rebuild-cache',
      });

      assert.deepStrictEqual(rebuilt, { kind: 'rebuilt-chat' });
      assert.strictEqual(capturedConfig?.cachedContent, 'cachedContents/workspace-1');
      assert.strictEqual(capturedConfig?.systemInstruction, 'Preserve this instruction');
    } finally {
      ai.chats.create = originalCreateChat;
      manager.getCacheStatus = originalGetCacheStatus;
      sessionStore.close();
      await manager.close();
    }
  });

  it('appendSessionTurn appends transcript and event entries for successful results', () => {
    const harness = createHarness();
    harness.sessions.set('sess-direct', { contents: [], events: [], transcript: [] });

    appendSessionTurn(
      'sess-direct',
      createAskExecutionResult({
        toolProfile: 'search',
        urls: ['https://example.com'],
      }),
      { message: 'Hello', sessionId: 'sess-direct' },
      harness.deps,
      'task-direct',
    );

    assert.deepStrictEqual(harness.sessions.get('sess-direct')?.transcript, [
      { role: 'user', text: 'Hello', timestamp: 1, taskId: 'task-direct' },
      { role: 'assistant', text: 'Assistant answer', timestamp: 1, taskId: 'task-direct' },
    ]);
    assert.deepStrictEqual(harness.sessions.get('sess-direct')?.events, [
      {
        request: {
          message: 'Hello',
          toolProfile: 'search',
          urls: ['https://example.com'],
        },
        response: { text: 'Assistant answer' },
        timestamp: 2,
        taskId: 'task-direct',
      },
    ]);
  });

  it('appendSessionTurn skips all writes for error results', () => {
    const harness = createHarness();
    harness.sessions.set('sess-error-direct', { contents: [], events: [], transcript: [] });

    appendSessionTurn(
      'sess-error-direct',
      createAskExecutionResult({
        result: {
          content: [{ type: 'text' as const, text: 'failed' }],
          isError: true,
        },
      }),
      { message: 'Hello', sessionId: 'sess-error-direct' },
      harness.deps,
      'task-direct',
    );

    assert.deepStrictEqual(harness.sessions.get('sess-error-direct')?.transcript, []);
    assert.deepStrictEqual(harness.sessions.get('sess-error-direct')?.events, []);
    assert.deepStrictEqual(harness.sessions.get('sess-error-direct')?.contents, []);
  });

  it('buildSessionEventRequest omits toolProfile when it is none', () => {
    assert.deepStrictEqual(
      buildSessionEventRequest('Hello', 'Hello', createAskExecutionResult({ toolProfile: 'none' })),
      { message: 'Hello' },
    );
  });

  it('buildSessionEventResponse redacts sensitive structured metadata fields', () => {
    const response = buildSessionEventResponse(
      createAskExecutionResult({
        streamResult: {
          functionCalls: [],
          parts: [],
          text: 'Assistant answer',
          textByWave: ['Assistant answer'],
          thoughtText: '',
          toolEvents: [],
          toolsUsed: [],
          toolsUsedOccurrences: [],
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com' } }] },
          urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://example.com' }] },
        },
      }),
      {
        answer: 'Assistant answer',
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'LOW' }],
        citationMetadata: { citations: [{ startIndex: 1, endIndex: 2 }] },
      },
    );

    assert.deepStrictEqual(response.text, 'Assistant answer');
    assert.deepStrictEqual(response.safetyRatings, '[REDACTED]');
    assert.deepStrictEqual(response.citationMetadata, '[REDACTED]');
    assert.deepStrictEqual(response.groundingMetadata, '[REDACTED]');
    assert.deepStrictEqual(response.urlContextMetadata, '[REDACTED]');
  });
});
