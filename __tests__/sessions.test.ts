import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import { AppError } from '../src/lib/errors.js';
import {
  buildReplayHistoryParts,
  buildTranscriptParts,
  createSessionAccess,
  createSessionStore,
  type SessionStore,
  type SessionStoreOptions,
} from '../src/sessions.js';
import {
  appendToolResponseTurn,
  buildRebuiltChatContents,
  chatWork,
  createAskWork,
} from '../src/tools/chat.js';

function mockChat(label = 'chat'): { _label: string } {
  return { _label: label };
}

function createContext(): import('@modelcontextprotocol/server').ServerContext {
  return {
    mcpReq: {
      _meta: {},
      log: async () => undefined,
      notify: async () => undefined,
      signal: new AbortController().signal,
    },
  } as import('@modelcontextprotocol/server').ServerContext;
}

const stores: SessionStore[] = [];

function createStore(options?: SessionStoreOptions): SessionStore {
  const store = createSessionStore(options);
  stores.push(store);
  return store;
}

afterEach(() => {
  delete process.env.SESSION_EVENTS_VERBOSE;
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe('sessions', () => {
  describe('createSessionAccess', () => {
    it('adapts a session store behind the narrow session service interface', () => {
      const store = createStore();
      const access = createSessionAccess(store);

      store.setSession('sess-access-adapter', mockChat('adapter') as never);
      access.appendTranscript('sess-access-adapter', {
        role: 'user',
        text: 'Hello',
        timestamp: 1,
      });

      assert.deepStrictEqual(access.listTranscriptEntries('sess-access-adapter'), [
        { role: 'user', text: 'Hello', timestamp: 1 },
      ]);
      assert.strictEqual(
        access.getSession('sess-access-adapter'),
        store.getSession('sess-access-adapter'),
      );
    });
  });

  describe('buildReplayHistoryParts', () => {
    it('preserves thought parts along with Gemini replay parts', () => {
      const parts = [
        { text: 'summary', thought: true },
        { text: '', thoughtSignature: 'sig-empty' },
        { text: 'visible', thoughtSignature: 'sig-text' },
        { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-fn' },
        { toolCall: { toolType: 'URL_CONTEXT' }, thoughtSignature: 'sig-tool' },
        { executableCode: { code: 'print(1)' }, thoughtSignature: 'sig-code' },
        { codeExecutionResult: { output: '1' }, thoughtSignature: 'sig-result' },
        { text: 'plain' },
      ];

      assert.deepStrictEqual(buildReplayHistoryParts(parts as never), [
        { text: 'summary', thought: true },
        { text: '', thoughtSignature: 'sig-empty' },
        { text: 'visible', thoughtSignature: 'sig-text' },
        { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-fn' },
        { toolCall: { toolType: 'URL_CONTEXT' }, thoughtSignature: 'sig-tool' },
        { executableCode: { code: 'print(1)' }, thoughtSignature: 'sig-code' },
        { codeExecutionResult: { output: '1' }, thoughtSignature: 'sig-result' },
        { text: 'plain' },
      ]);
    });

    it('is backward-compatible with v0 persisted session parts', () => {
      const persisted = JSON.parse(
        JSON.stringify([
          { text: 'old answer' },
          { text: 'old thought', thought: true },
          { functionCall: { name: 'lookup' }, thoughtSignature: 'sig-old' },
        ]),
      ) as never;

      assert.deepStrictEqual(buildReplayHistoryParts(persisted), [
        { text: 'old answer' },
        { text: 'old thought', thought: true },
        { functionCall: { name: 'lookup' }, thoughtSignature: 'sig-old' },
      ]);
    });

    it('keeps thought parts and signed text parts in rebuilt chat contents', () => {
      const rebuilt = buildRebuiltChatContents(
        [
          {
            role: 'model',
            parts: [
              { text: 'private', thought: true, thoughtSignature: 'sig-thought' },
              { text: 'visible', thoughtSignature: 'sig-visible' },
            ],
            timestamp: 1,
          },
        ],
        200_000,
      );

      assert.deepStrictEqual(rebuilt, [
        {
          role: 'model',
          parts: [
            { text: 'private', thought: true, thoughtSignature: 'sig-thought' },
            { text: 'visible', thoughtSignature: 'sig-visible' },
          ],
        },
      ]);
    });

    it('drops functionCall parts without a name on replay', () => {
      const parts = [
        { functionCall: { name: 'lookup', args: { q: 'x' } } },
        { functionCall: { args: { stray: true } } },
        { functionCall: { name: '', args: { empty: true } } },
        { text: 'after' },
      ];
      assert.deepStrictEqual(buildReplayHistoryParts(parts as never), [
        { functionCall: { name: 'lookup', args: { q: 'x' } } },
        { text: 'after' },
      ]);
    });

    it('preserves thoughtSignature byte-for-byte on retained parts', () => {
      const parts = [
        { functionCall: { name: 'lookup' }, thoughtSignature: 'opaque-signature-value' },
      ];

      assert.strictEqual(
        buildReplayHistoryParts(parts as never)[0]?.thoughtSignature,
        'opaque-signature-value',
      );
    });

    it('drops orphaned functionResponse parts when their paired functionCall was removed', () => {
      const parts = [
        { functionCall: { args: { stray: true } } },
        { functionResponse: { name: 'lookup', response: { ok: true } } },
        { functionCall: { id: 'call-1', name: 'fetch' } },
        { functionResponse: { id: 'call-1', name: 'fetch', response: { ok: true } } },
      ];

      assert.deepStrictEqual(buildReplayHistoryParts(parts as never), [
        { functionCall: { id: 'call-1', name: 'fetch' } },
        { functionResponse: { id: 'call-1', name: 'fetch', response: { ok: true } } },
      ]);
    });

    it('builds transcript parts from user-visible text and media only', () => {
      const parts = [
        { text: 'visible' },
        { text: 'private', thought: true },
        { functionCall: { name: 'lookup', args: { q: 'x' } } },
        { inlineData: { data: 'abc', mimeType: 'text/plain' } },
      ];

      assert.deepStrictEqual(buildTranscriptParts(parts as never), [
        { text: 'visible' },
        { inlineData: { data: 'abc', mimeType: 'text/plain' } },
      ]);
    });

    it('buildRebuiltChatContents skips entries whose parts sanitize to empty', () => {
      const rebuilt = buildRebuiltChatContents(
        [
          {
            role: 'model',
            parts: [{ functionCall: { args: { stray: true } } }],
            timestamp: 1,
          },
          {
            role: 'user',
            parts: [{ text: 'next' }],
            timestamp: 2,
          },
        ],
        200_000,
      );

      assert.deepStrictEqual(rebuilt, [{ role: 'user', parts: [{ text: 'next' }] }]);
    });
  });

  describe('getSession / setSession', () => {
    it('stores and retrieves a session', () => {
      const store = createStore();
      const chat = mockChat('test-1');
      store.setSession('sess-get-set', chat as never);
      const retrieved = store.getSession('sess-get-set');
      assert.strictEqual(retrieved, chat);
    });

    it('returns undefined for unknown session', () => {
      const store = createStore();
      const result = store.getSession('nonexistent-session-id-xyz');
      assert.strictEqual(result, undefined);
    });

    it('updates lastAccess on get', () => {
      const store = createStore();
      store.setSession('sess-access', mockChat() as never);
      const before = store.listSessionEntries().find((session) => session.id === 'sess-access');
      assert.ok(before);

      store.getSession('sess-access');
      const after = store.listSessionEntries().find((session) => session.id === 'sess-access');
      assert.ok(after);
      assert.ok(after.lastAccess >= before.lastAccess);
    });

    it('updates lastAccess on transcript writes', () => {
      let now = 100;
      const store = createStore({ now: () => now, ttlMs: 1_000, sweepIntervalMs: 60_000 });
      store.setSession('sess-write-access', mockChat() as never);

      const before = store.getSessionEntry('sess-write-access');
      assert.ok(before);

      now = 200;
      store.appendSessionTranscript('sess-write-access', {
        role: 'user',
        text: 'Hello',
        timestamp: 1,
      });

      const after = store.getSessionEntry('sess-write-access');
      assert.ok(after);
      assert.ok(after.lastAccess > before.lastAccess);
    });

    it('updates lastAccess on event writes', () => {
      let now = 100;
      const store = createStore({ now: () => now, ttlMs: 1_000, sweepIntervalMs: 60_000 });
      store.setSession('sess-event-write-access', mockChat() as never);

      const before = store.getSessionEntry('sess-event-write-access');
      assert.ok(before);

      now = 200;
      store.appendSessionEvent('sess-event-write-access', {
        request: { message: 'Hello' },
        response: { text: 'Hi' },
        timestamp: 1,
      });

      const after = store.getSessionEntry('sess-event-write-access');
      assert.ok(after);
      assert.ok(after.lastAccess > before.lastAccess);
    });

    it('returns metadata for an active session', () => {
      const store = createStore();
      store.setSession('sess-entry-active', mockChat('entry-active') as never);
      const entry = store.getSessionEntry('sess-entry-active');

      assert.ok(entry);
      assert.strictEqual(entry.id, 'sess-entry-active');
      assert.strictEqual(typeof entry.lastAccess, 'number');
    });

    it('stores cloned session generation contracts on summaries', () => {
      const store = createStore();
      store.setSession('sess-contract', mockChat('contract') as never, undefined, undefined, {
        model: 'gemini-test',
        systemInstruction: 'original',
        tools: [{ googleSearch: {} }],
      });

      const entry = store.getSessionEntry('sess-contract');
      assert.deepStrictEqual(entry?.contract, {
        model: 'gemini-test',
        systemInstruction: 'original',
        tools: [{ googleSearch: {} }],
      });

      if (entry?.contract?.tools?.[0]) {
        entry.contract.tools[0] = { codeExecution: {} };
      }

      assert.deepStrictEqual(store.getSessionEntry('sess-contract')?.contract?.tools, [
        { googleSearch: {} },
      ]);
    });
  });

  describe('transcripts', () => {
    it('initializes an empty transcript for new sessions', () => {
      const store = createStore();
      store.setSession('sess-empty-transcript', mockChat('empty') as never);
      assert.deepStrictEqual(store.listSessionTranscriptEntries('sess-empty-transcript'), []);
    });

    it('appends and reads transcript entries', () => {
      const store = createStore();
      store.setSession('sess-transcript-append', mockChat('append') as never);
      store.appendSessionTranscript('sess-transcript-append', {
        role: 'user',
        text: 'Hello',
        timestamp: 1,
      });
      store.appendSessionTranscript('sess-transcript-append', {
        role: 'assistant',
        text: 'Hi',
        timestamp: 2,
        taskId: 'task-1',
      });

      assert.deepStrictEqual(store.listSessionTranscriptEntries('sess-transcript-append'), [
        { role: 'user', text: 'Hello', timestamp: 1 },
        { role: 'assistant', text: 'Hi', timestamp: 2, taskId: 'task-1' },
      ]);
    });

    it('retains only the most recent transcript entries when over the limit', () => {
      const store = createStore({ maxTranscriptEntries: 2 });
      store.setSession('sess-transcript-cap', mockChat('cap') as never);

      store.appendSessionTranscript('sess-transcript-cap', {
        role: 'user',
        text: 'first',
        timestamp: 1,
      });
      store.appendSessionTranscript('sess-transcript-cap', {
        role: 'assistant',
        text: 'second',
        timestamp: 2,
      });
      store.appendSessionTranscript('sess-transcript-cap', {
        role: 'user',
        text: 'third',
        timestamp: 3,
      });

      assert.deepStrictEqual(store.listSessionTranscriptEntries('sess-transcript-cap'), [
        { role: 'assistant', text: 'second', timestamp: 2 },
        { role: 'user', text: 'third', timestamp: 3 },
      ]);
    });

    it('does not notify when transcript entries are appended', () => {
      const store = createStore();
      let notifications = 0;
      store.setSession('sess-transcript-notify', mockChat('transcript-notify') as never);
      store.subscribe(() => {
        notifications += 1;
      });

      store.appendSessionTranscript('sess-transcript-notify', {
        role: 'user',
        text: 'Hello again',
        timestamp: 3,
      });

      assert.strictEqual(notifications, 0);
    });
  });

  describe('content entries', () => {
    it('appends and reads replay content entries as clones', () => {
      const store = createStore();
      store.setSession('sess-content-append', mockChat('content') as never);
      const parts = [{ text: 'Hello' }, { functionCall: { name: 'lookup', args: { q: 'x' } } }];

      store.appendSessionContent('sess-content-append', {
        role: 'model',
        parts,
        timestamp: 1,
        taskId: 'task-content',
      });

      const entries = store.listSessionContentEntries('sess-content-append');
      assert.deepStrictEqual(entries, [
        {
          role: 'model',
          parts,
          timestamp: 1,
          taskId: 'task-content',
        },
      ]);

      if (entries?.[0]?.parts[0]) {
        entries[0].parts[0].text = 'mutated';
      }

      assert.strictEqual(
        store.listSessionContentEntries('sess-content-append')?.[0]?.parts[0]?.text,
        'Hello',
      );
    });

    it('retains only the most recent content entries when over the transcript limit', () => {
      const store = createStore({ maxTranscriptEntries: 2 });
      store.setSession('sess-content-cap', mockChat('content-cap') as never);

      for (let i = 1; i <= 3; i += 1) {
        store.appendSessionContent('sess-content-cap', {
          role: i % 2 === 0 ? 'model' : 'user',
          parts: [{ text: `content-${String(i)}` }],
          timestamp: i,
        });
      }

      assert.deepStrictEqual(store.listSessionContentEntries('sess-content-cap'), [
        { role: 'model', parts: [{ text: 'content-2' }], timestamp: 2 },
        { role: 'user', parts: [{ text: 'content-3' }], timestamp: 3 },
      ]);
    });

    it('removes content entries when a session is evicted', () => {
      const store = createStore({ maxSessions: 1 });
      store.setSession('sess-content-old', mockChat('old') as never);
      store.appendSessionContent('sess-content-old', {
        role: 'user',
        parts: [{ text: 'old' }],
        timestamp: 1,
      });

      store.setSession('sess-content-new', mockChat('new') as never);

      assert.strictEqual(store.isEvicted('sess-content-old'), true);
      assert.strictEqual(store.listSessionContentEntries('sess-content-old'), undefined);
    });

    it('appends synthetic functionResponse turns through the replay helper', () => {
      const store = createStore();
      store.setSession('sess-function-response', mockChat('function-response') as never);

      assert.strictEqual(
        appendToolResponseTurn(
          'sess-function-response',
          [
            { id: 'call-1', name: 'lookup', response: { ok: true } },
            { id: 'call-2', name: 'lookup_more', response: { value: 42 } },
          ],
          {
            appendSessionContent: store.appendSessionContent.bind(store),
            now: () => 123,
          },
          'task-response',
        ),
        true,
      );

      assert.deepStrictEqual(store.listSessionContentEntries('sess-function-response'), [
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'call-1', name: 'lookup', response: { ok: true } } },
            {
              functionResponse: { id: 'call-2', name: 'lookup_more', response: { value: 42 } },
            },
          ],
          timestamp: 123,
          taskId: 'task-response',
        },
      ]);
      assert.deepStrictEqual(
        buildRebuiltChatContents(
          store.listSessionContentEntries('sess-function-response') ?? [],
          200_000,
        ),
        [
          {
            role: 'user',
            parts: [
              { functionResponse: { id: 'call-1', name: 'lookup', response: { ok: true } } },
              {
                functionResponse: {
                  id: 'call-2',
                  name: 'lookup_more',
                  response: { value: 42 },
                },
              },
            ],
          },
        ],
      );
    });
  });

  describe('events', () => {
    it('appends and reads session event entries', () => {
      const store = createStore();
      store.setSession('sess-events-append', mockChat('events') as never);
      store.appendSessionEvent('sess-events-append', {
        request: { message: 'Hello', toolProfile: 'search', urls: ['https://example.com'] },
        response: {
          text: 'Hi',
          functionCalls: [{ name: 'lookupWeather', id: 'call-1', args: { city: 'Stockholm' } }],
        },
        timestamp: 1,
      });

      assert.deepStrictEqual(store.listSessionEventEntries('sess-events-append'), [
        {
          request: {
            message: 'Hello',
            toolProfile: 'search',
            urls: ['https://example.com'],
          },
          response: {
            text: 'Hi',
            functionCalls: [{ name: 'lookupWeather', id: 'call-1', args: { city: 'Stockholm' } }],
          },
          timestamp: 1,
        },
      ]);
    });

    it('does not notify when session event entries are appended', () => {
      const store = createStore();
      let notifications = 0;
      store.setSession('sess-events-notify', mockChat('events-notify') as never);
      store.subscribe(() => {
        notifications += 1;
      });

      store.appendSessionEvent('sess-events-notify', {
        request: { message: 'inspect events' },
        response: { text: 'done' },
        timestamp: 1,
      });

      assert.strictEqual(notifications, 0);
    });

    it('retains only the most recent event entries when over the limit', () => {
      const store = createStore({ maxEventEntries: 2 });
      store.setSession('sess-events-cap', mockChat('events-cap') as never);

      for (let i = 1; i <= 3; i += 1) {
        store.appendSessionEvent('sess-events-cap', {
          request: { message: `event-${String(i)}` },
          response: { text: `response-${String(i)}` },
          timestamp: i,
        });
      }

      assert.deepStrictEqual(store.listSessionEventEntries('sess-events-cap'), [
        {
          request: { message: 'event-2' },
          response: { text: 'response-2' },
          timestamp: 2,
        },
        {
          request: { message: 'event-3' },
          response: { text: 'response-3' },
          timestamp: 3,
        },
      ]);
    });

    it('preserves replay provenance fields (finishReason, groundingMetadata, urlContextMetadata, promptFeedback, anomalies) through clone round-trip', () => {
      process.env.SESSION_EVENTS_VERBOSE = 'true';
      const store = createStore();
      store.setSession('sess-provenance', mockChat('provenance') as never);

      const groundingMetadata = {
        webSearchQueries: ['what is foo'],
      } as unknown as Record<string, unknown>;
      const urlContextMetadata = {
        urlMetadata: [{ retrievedUrl: 'https://example.com' }],
      } as unknown as Record<string, unknown>;
      const promptFeedback = { blockReason: 'SAFETY' } as unknown as Record<string, unknown>;
      const anomalies = { namelessFunctionCalls: 1 };

      store.appendSessionEvent('sess-provenance', {
        request: { message: 'prompt' },
        response: {
          text: 'ok',
          finishReason: 'STOP',
          finishMessage: 'done',
          promptBlockReason: 'SAFETY',
          namelessFunctionCallCount: 1,
          groundingMetadata,
          urlContextMetadata,
          promptFeedback,
          anomalies,
        },
        timestamp: 1,
      });

      store.appendSessionContent('sess-provenance', {
        role: 'model',
        parts: [{ text: 'ok' }],
        timestamp: 2,
        finishReason: FinishReason.STOP,
        finishMessage: 'done',
      });

      const events = store.listSessionEventEntries('sess-provenance');
      assert.deepStrictEqual(events?.[0]?.response.groundingMetadata, groundingMetadata);
      assert.deepStrictEqual(events?.[0]?.response.urlContextMetadata, urlContextMetadata);
      assert.deepStrictEqual(events?.[0]?.response.promptFeedback, promptFeedback);
      assert.deepStrictEqual(events?.[0]?.response.anomalies, anomalies);
      assert.strictEqual(events?.[0]?.response.finishReason, 'STOP');
      assert.strictEqual(events?.[0]?.response.finishMessage, 'done');

      // Mutating the returned clone must NOT mutate the stored entry.
      if (events?.[0]?.response.groundingMetadata) {
        events[0].response.groundingMetadata.webSearchQueries = ['mutated'];
      }
      const eventsAgain = store.listSessionEventEntries('sess-provenance');
      assert.deepStrictEqual(eventsAgain?.[0]?.response.groundingMetadata?.webSearchQueries, [
        'what is foo',
      ]);

      const contents = store.listSessionContentEntries('sess-provenance');
      assert.strictEqual(contents?.[0]?.finishReason, FinishReason.STOP);
      assert.strictEqual(contents?.[0]?.finishMessage, 'done');
    });

    it('strips verbose event payloads by default while keeping compact fields', () => {
      const store = createStore();
      store.setSession('sess-slim-events', mockChat('slim-events') as never);

      store.appendSessionEvent('sess-slim-events', {
        request: { message: 'prompt' },
        response: {
          text: 'ok',
          functionCalls: [{ name: 'lookup', id: 'call-1', args: { q: 'x' } }],
          toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
          thoughts: 'private',
          safetyRatings: [{ category: 'x' }],
          citationMetadata: { citations: [] },
          groundingMetadata: { webSearchQueries: ['q'] },
          urlContextMetadata: { urlMetadata: [] },
          promptFeedback: { blockReason: 'SAFETY' },
          usage: { totalTokenCount: 10 },
        },
        timestamp: 1,
      });

      assert.deepStrictEqual(store.listSessionEventEntries('sess-slim-events'), [
        {
          request: { message: 'prompt' },
          response: {
            text: 'ok',
            functionCalls: [{ name: 'lookup', id: 'call-1', args: { q: 'x' } }],
            usage: { totalTokenCount: 10 },
          },
          timestamp: 1,
        },
      ]);
    });

    it('redacts free-text secrets in request fields when cloning session events', () => {
      const store = createStore();
      store.setSession('sess-redacted-events', mockChat('redacted-events') as never);

      store.appendSessionEvent('sess-redacted-events', {
        request: {
          message: 'Authorization: topsecret and Bearer abc.def-ghi=',
          sentMessage: 'api_key=xyz123',
          toolProfile: 'token: hidden',
        },
        response: { text: 'ok' },
        timestamp: 1,
      });

      assert.deepStrictEqual(store.listSessionEventEntries('sess-redacted-events'), [
        {
          request: {
            message: '[REDACTED] and [REDACTED]',
            sentMessage: '[REDACTED]',
            toolProfile: '[REDACTED]',
          },
          response: { text: 'ok' },
          timestamp: 1,
        },
      ]);
    });
  });

  describe('isEvicted', () => {
    it('returns false for active session', () => {
      const store = createStore();
      store.setSession('sess-active', mockChat() as never);
      assert.strictEqual(store.isEvicted('sess-active'), false);
    });

    it('returns false for unknown session', () => {
      const store = createStore();
      assert.strictEqual(store.isEvicted('never-existed-session'), false);
    });
  });

  describe('listSessionEntries', () => {
    it('returns array of session entries', () => {
      const store = createStore();
      store.setSession('sess-list-test', mockChat() as never);
      const entries = store.listSessionEntries();
      const entry = entries.find((session) => session.id === 'sess-list-test');

      assert.ok(Array.isArray(entries));
      assert.ok(entry);
      assert.strictEqual(typeof entry.lastAccess, 'number');
    });

    it('excludes expired sessions and evicts them silently', () => {
      let now = 1_000_000;
      const store = createStore({ ttlMs: 1_000, now: () => now, sweepIntervalMs: 60_000 });
      store.setSession('sess-expiry-active', mockChat('active') as never);
      store.setSession('sess-expiry-stale', mockChat('stale') as never);

      // Advance past TTL to expire both entries, then refresh one via get.
      now += 500;
      store.getSession('sess-expiry-active');
      now += 600; // sess-expiry-stale is now older than ttlMs; active still fresh.

      const ids = store.listSessionEntries().map((session) => session.id);
      assert.ok(ids.includes('sess-expiry-active'));
      assert.ok(!ids.includes('sess-expiry-stale'));
      assert.strictEqual(store.isEvicted('sess-expiry-stale'), true);
    });
  });

  describe('completeSessionIds', () => {
    it('filters active session ids by prefix', () => {
      const store = createStore();
      store.setSession('sess-complete-alpha', mockChat('alpha') as never);
      store.setSession('sess-complete-beta', mockChat('beta') as never);

      assert.deepStrictEqual(store.completeSessionIds('sess-complete-a'), ['sess-complete-alpha']);
    });

    it('returns all active session ids when prefix is omitted', () => {
      const store = createStore();
      store.setSession('sess-complete-all', mockChat('all') as never);
      assert.ok(store.completeSessionIds().includes('sess-complete-all'));
    });
  });

  describe('session overwrite', () => {
    it('throws when setSession is called with an existing ID', () => {
      const store = createStore();
      const chat1 = mockChat('first');
      const chat2 = mockChat('second');
      store.setSession('sess-overwrite', chat1 as never);
      store.appendSessionTranscript('sess-overwrite', {
        role: 'user',
        text: 'Old turn',
        timestamp: 1,
      });

      assert.throws(
        () => store.setSession('sess-overwrite', chat2 as never),
        (error) =>
          error instanceof AppError &&
          error.message.includes('Session already exists: sess-overwrite'),
      );

      assert.strictEqual(store.getSession('sess-overwrite'), chat1);
      assert.deepStrictEqual(store.listSessionTranscriptEntries('sess-overwrite'), [
        { role: 'user', text: 'Old turn', timestamp: 1 },
      ]);
    });

    it('replaceSession preserves history for an existing ID', () => {
      const store = createStore();
      const chat1 = mockChat('first');
      const chat2 = mockChat('second');
      store.setSession('sess-replace', chat1 as never);
      store.appendSessionTranscript('sess-replace', {
        role: 'user',
        text: 'Old turn',
        timestamp: 1,
      });

      store.replaceSession('sess-replace', chat2 as never);

      assert.strictEqual(store.getSession('sess-replace'), chat2);
      assert.deepStrictEqual(store.listSessionTranscriptEntries('sess-replace'), [
        { role: 'user', text: 'Old turn', timestamp: 1 },
      ]);
    });

    it('emits listChanged=false on replaceSession and listChanged=true on setSession', () => {
      const store = createStore();
      const events: { listChanged: boolean }[] = [];
      store.subscribe((event) => {
        events.push({ listChanged: event.listChanged });
      });

      store.setSession('sess-replace-notify', mockChat('initial') as never);
      store.replaceSession('sess-replace-notify', mockChat('replacement') as never);

      const setEvent = events.find((event) => event.listChanged);
      const replaceEvent = events.find((event) => !event.listChanged);

      assert.ok(setEvent, 'setSession must emit listChanged=true');
      assert.ok(replaceEvent, 'replaceSession must emit listChanged=false');
    });

    it('clears evicted state when a session ID is reused', () => {
      const store = createStore({ maxSessions: 50 });
      const prefix = 'sess-evicted-reuse-';

      for (let i = 0; i < 60; i += 1) {
        store.setSession(`${prefix}${String(i)}`, mockChat(`bulk-${String(i)}`) as never);
      }

      assert.strictEqual(store.isEvicted(`${prefix}0`), true);

      const revived = mockChat('revived');
      store.setSession(`${prefix}0`, revived as never);

      assert.strictEqual(store.isEvicted(`${prefix}0`), false);
      assert.strictEqual(store.getSession(`${prefix}0`), revived);
    });

    it('evicts the least recently used active session and its transcript', () => {
      const store = createStore({ maxSessions: 50 });
      const prefix = 'sess-lru-order-';

      for (let i = 0; i <= 60; i += 1) {
        store.setSession(`${prefix}${String(i)}`, mockChat(`lru-${String(i)}`) as never);
      }

      store.appendSessionTranscript(`${prefix}12`, {
        role: 'user',
        text: 'Will be evicted',
        timestamp: 1,
      });

      for (let i = 13; i <= 60; i += 1) {
        assert.ok(store.getSession(`${prefix}${String(i)}`));
      }
      assert.ok(store.getSession(`${prefix}11`));

      store.setSession(`${prefix}61`, mockChat('lru-overflow') as never);

      assert.strictEqual(store.isEvicted(`${prefix}11`), false);
      assert.strictEqual(store.isEvicted(`${prefix}12`), true);
      assert.strictEqual(store.listSessionTranscriptEntries(`${prefix}12`), undefined);
    });
  });

  describe('change notifications', () => {
    it('does not notify when reading a session updates lastAccess', () => {
      const store = createStore();
      let calls = 0;
      store.subscribe(() => {
        calls += 1;
      });

      store.setSession('sess-read-notify', mockChat('read-notify') as never);
      calls = 0;

      assert.ok(store.getSession('sess-read-notify'));
      assert.strictEqual(calls, 0);
    });

    it('notifies once when adding a session over capacity', () => {
      const store = createStore({ maxSessions: 50 });
      const prefix = 'sess-overflow-notify-';

      for (let i = 0; i < 60; i += 1) {
        store.setSession(`${prefix}${String(i)}`, mockChat(`notify-${String(i)}`) as never);
      }

      let calls = 0;
      store.subscribe(() => {
        calls += 1;
      });

      store.setSession(`${prefix}overflow`, mockChat('notify-overflow') as never);
      assert.strictEqual(calls, 1);
    });

    it('emits listChanged=true on setSession', () => {
      const store = createStore();
      let listChanged = false;
      store.subscribe((event) => {
        listChanged = event.listChanged;
      });

      store.setSession('sess-task-set', mockChat('task-set') as never);
      assert.strictEqual(listChanged, true);
    });

    it('does not notify on getSession', () => {
      const store = createStore();
      store.setSession('sess-task-get', mockChat('task-get') as never);
      let calls = 0;
      store.subscribe(() => {
        calls += 1;
      });

      store.getSession('sess-task-get');
      assert.strictEqual(calls, 0);
    });

    it('keeps actively written sessions alive until ttl expires from the latest write', () => {
      let now = 1_000;
      const store = createStore({ ttlMs: 100, now: () => now, sweepIntervalMs: 60_000 });
      store.setSession('sess-write-ttl', mockChat('ttl-write') as never);

      now = 1_050;
      store.appendSessionTranscript('sess-write-ttl', {
        role: 'user',
        text: 'keep alive',
        timestamp: 1,
      });

      now = 1_120;
      assert.ok(store.getSessionEntry('sess-write-ttl'));

      now = 1_200;
      assert.strictEqual(store.getSession('sess-write-ttl'), undefined);
    });
  });

  describe('ttl enforcement', () => {
    it('expires sessions on read before the sweep runs', async () => {
      const store = createStore({ ttlMs: 1 });
      const chat = mockChat('ttl-read');
      store.setSession('sess-expire-on-read', chat as never);
      store.appendSessionTranscript('sess-expire-on-read', {
        role: 'user',
        text: 'hello',
        timestamp: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(store.getSession('sess-expire-on-read'), undefined);
      assert.strictEqual(store.isEvicted('sess-expire-on-read'), true);
      assert.strictEqual(store.listSessionTranscriptEntries('sess-expire-on-read'), undefined);
    });

    it('expires sessions on metadata reads before validation can treat them as active', async () => {
      const store = createStore({ ttlMs: 1 });
      const chat = mockChat('ttl-entry');
      store.setSession('sess-expire-on-entry', chat as never);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(store.getSessionEntry('sess-expire-on-entry'), undefined);
      assert.strictEqual(store.isEvicted('sess-expire-on-entry'), true);
    });
  });

  describe('restart rebuilds and redacts', () => {
    it('rebuilds a resumed session after restart and sets rebuiltAt', async () => {
      const transcript = [
        { role: 'user' as const, text: 'hello', timestamp: 1 },
        { role: 'assistant' as const, text: 'hi', timestamp: 2 },
      ];
      let rebuiltAt: number | undefined;
      let observedMessage: string | undefined;

      const askWork = createAskWork({
        appendSessionEvent: () => true,
        appendSessionContent: () => true,
        appendSessionTranscript: () => true,
        createChat: () => ({ chat: mockChat('live-chat') as never }),
        getSession: () => undefined,
        getSessionEntry: (sessionId: string) =>
          sessionId === 'sess-restart'
            ? ({
                id: sessionId,
                lastAccess: 1,
                transcriptCount: transcript.length,
                eventCount: 0,
                rebuiltAt,
              } as never)
            : undefined,
        isEvicted: () => false,
        listSessionContentEntries: () => undefined,
        listSessionTranscriptEntries: (sessionId: string) =>
          sessionId === 'sess-restart' ? transcript : undefined,
        now: () => 123_456,
        rebuildChat: (sessionId: string) => {
          if (sessionId !== 'sess-restart') return undefined;
          rebuiltAt = 123_456;
          return mockChat('rebuilt-chat') as never;
        },
        runWithoutSession: async (args: Record<string, unknown>) => {
          observedMessage = args.message as string | undefined;
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
        setSession: () => undefined,
      });

      const result = await chatWork(
        askWork,
        {
          goal: 'follow up',
          sessionId: 'sess-restart',
        },
        createContext(),
      );

      const structured = result.structuredContent as Record<string, unknown>;
      assert.strictEqual(result.isError, undefined);
      assert.match(observedMessage ?? '', /\n\nfollow up$/);
      assert.strictEqual((structured.session as Record<string, unknown>).rebuiltAt, 123_456);
    });

    it('redacts sensitive keys in persisted session events', async () => {
      const events: unknown[] = [];
      const askWork = createAskWork({
        appendSessionEvent: (_sessionId, item) => {
          events.push(item);
          return true;
        },
        appendSessionContent: () => true,
        appendSessionTranscript: () => true,
        createChat: () => ({ chat: mockChat('live-chat') as never }),
        getSession: () => undefined,
        getSessionEntry: () => undefined,
        isEvicted: () => false,
        listSessionContentEntries: () => undefined,
        listSessionTranscriptEntries: () => undefined,
        now: () => 1,
        rebuildChat: () => undefined,
        runWithoutSession: async () =>
          ({
            result: {
              content: [{ type: 'text' as const, text: 'Assistant answer' }],
              structuredContent: {
                answer: 'Assistant answer',
                data: {
                  apiKey: 'secret-value',
                  nested: { token: 'hidden-value' },
                  list: [{ password: 'another-secret' }],
                },
                functionCalls: [
                  {
                    name: 'lookup',
                    args: {
                      authorization: 'bearer secret',
                    },
                  },
                ],
                toolEvents: [
                  {
                    kind: 'tool_call',
                    args: {
                      sessionId: 'sess-secret',
                    },
                    response: {
                      cookie: 'hidden-cookie',
                    },
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
              toolsUsedOccurrences: [],
            },
            toolProfile: 'none' as const,
          }) as never,
        setSession: () => undefined,
      });

      await chatWork(
        askWork,
        {
          goal: 'redact secrets',
          sessionId: 'sess-redact',
        },
        createContext(),
      );

      const event = events[0] as {
        response?: {
          data?: {
            apiKey?: string;
            list?: { password?: string }[];
            nested?: { token?: string };
          };
          functionCalls?: { args?: Record<string, unknown> }[];
          toolEvents?: {
            args?: Record<string, unknown>;
            response?: Record<string, unknown>;
          }[];
        };
      };

      assert.strictEqual(event.response?.data?.apiKey, '[REDACTED]');
      assert.strictEqual(event.response?.data?.nested?.token, '[REDACTED]');
      assert.strictEqual(event.response?.data?.list?.[0]?.password, '[REDACTED]');
      assert.strictEqual(event.response?.functionCalls?.[0]?.args?.authorization, '[REDACTED]');
      assert.strictEqual(event.response?.toolEvents?.[0]?.args?.sessionId, '[REDACTED]');
      assert.strictEqual(event.response?.toolEvents?.[0]?.response?.cookie, '[REDACTED]');
    });
  });
});
