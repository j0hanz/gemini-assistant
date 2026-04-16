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

  it('truncates large structured payloads before persisting session events', async () => {
    const harness = createHarness();
    harness.sessions.set('sess-large', { events: [], transcript: [] });
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
        thoughtText: '',
        toolEvents: [],
        toolsUsed: [],
        hadCandidate: true,
      },
      toolProfile: 'none' as const,
    });

    const askWork = createAskWork(harness.deps as never);
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
});
