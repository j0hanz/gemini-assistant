import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAskWork } from '../../src/tools/ask.js';

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

function createHarness() {
  const sessions = new Map<
    string,
    { events: Record<string, unknown>[]; transcript: Record<string, unknown>[] }
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
      appendSessionTranscript: (sessionId: string, entry: Record<string, unknown>) => {
        const session = sessions.get(sessionId);
        if (!session) return false;
        session.transcript.push(entry);
        return true;
      },
      createChat: () => ({ kind: 'chat' }) as never,
      getSession: (sessionId: string) =>
        sessions.has(sessionId) ? ({ kind: 'chat' } as never) : undefined,
      getSessionEntry: (sessionId: string) =>
        sessions.has(sessionId) ? ({ id: sessionId, lastAccess: 0 } as never) : undefined,
      isEvicted: () => false,
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
          thoughtText: '',
          toolEvents: [],
          toolsUsed: [],
        },
        toolProfile: 'none' as const,
      }),
      setSession: (sessionId: string) => {
        sessions.set(sessionId, { events: [], transcript: [] });
      },
    },
  };
}

describe('ask transcript capture', () => {
  it('captures transcript entries when creating a new session', async () => {
    const harness = createHarness();
    const askWork = createAskWork(harness.deps as never);

    const result = await askWork(
      { message: 'Hello', sessionId: 'sess-new' },
      createContext('task-new'),
    );

    assert.strictEqual(result.isError, undefined);
    assert.deepStrictEqual(harness.sessions.get('sess-new')?.transcript, [
      { role: 'user', text: 'Hello', timestamp: 1, taskId: 'task-new' },
      { role: 'assistant', text: 'Assistant answer', timestamp: 2, taskId: 'task-new' },
    ]);
    assert.deepStrictEqual(harness.sessions.get('sess-new')?.events, [
      {
        request: { message: 'Hello' },
        response: { text: 'Assistant answer' },
        timestamp: 3,
        taskId: 'task-new',
      },
    ]);
    assert.ok(
      result.content.some(
        (item) => item.type === 'resource_link' && item.uri === 'sessions://sess-new',
      ),
    );
    assert.ok(
      result.content.some(
        (item) => item.type === 'resource_link' && item.uri === 'sessions://sess-new/events',
      ),
    );
  });

  it('captures transcript entries when resuming an existing session', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-existing', { events: [], transcript: [] });
    const askWork = createAskWork(harness.deps as never);

    await askWork({ message: 'Follow up', sessionId: 'sess-existing' }, createContext('task-2'));

    assert.deepStrictEqual(harness.sessions.get('sess-existing')?.transcript, [
      { role: 'user', text: 'Follow up', timestamp: 1, taskId: 'task-2' },
      { role: 'assistant', text: 'Assistant answer', timestamp: 2, taskId: 'task-2' },
    ]);
    assert.deepStrictEqual(harness.sessions.get('sess-existing')?.events, [
      {
        request: { message: 'Follow up' },
        response: { text: 'Assistant answer' },
        timestamp: 3,
        taskId: 'task-2',
      },
    ]);
  });

  it('does not store transcript entries when result generation fails', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-error', { events: [], transcript: [] });
    harness.deps.runWithoutSession = async () => ({
      result: {
        content: [{ type: 'text' as const, text: 'ask failed' }],
        isError: true,
      },
      streamResult: {
        functionCalls: [],
        parts: [],
        text: 'ask failed',
        thoughtText: '',
        toolEvents: [],
        toolsUsed: [],
      },
      toolProfile: 'none' as const,
    });
    const askWork = createAskWork(harness.deps as never);

    const result = await askWork({ message: 'Break', sessionId: 'sess-error' }, createContext());

    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(harness.sessions.get('sess-error')?.transcript, []);
    assert.deepStrictEqual(harness.sessions.get('sess-error')?.events, []);
  });

  it('persists structured output metadata in session events', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-structured', { events: [], transcript: [] });
    harness.deps.runWithoutSession = async () => ({
      result: {
        content: [{ type: 'text' as const, text: '{\n  "status": "ok"\n}' }],
        structuredContent: {
          answer: '{\n  "status": "ok"\n}',
          data: { status: 'ok' },
          schemaWarnings: [
            'thinkingLevel was ignored because responseSchema activates JSON mode (mutually exclusive)',
          ],
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
        thoughtText: '',
        toolEvents: [],
        toolsUsed: [],
      },
      toolProfile: 'search' as const,
      urls: ['https://example.com'],
    });
    const askWork = createAskWork(harness.deps as never);

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
          schemaWarnings: [
            'thinkingLevel was ignored because responseSchema activates JSON mode (mutually exclusive)',
          ],
          thoughts: 'Reasoning summary',
          functionCalls: [{ name: 'lookupWeather', args: { city: 'Stockholm' } }],
          toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
          usage: { totalTokenCount: 25 },
        },
        timestamp: 3,
        taskId: 'task-structured',
      },
    ]);
  });
});
