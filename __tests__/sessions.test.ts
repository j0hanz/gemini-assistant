import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createSessionStore,
  type SessionStore,
  type SessionStoreOptions,
} from '../src/sessions.js';

function mockChat(label = 'chat'): { _label: string } {
  return { _label: label } as unknown as ReturnType<typeof mockChat>;
}

const stores: SessionStore[] = [];

function createStore(options?: SessionStoreOptions): SessionStore {
  const store = createSessionStore(options);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe('sessions', () => {
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

    it('returns metadata for an active session', () => {
      const store = createStore();
      store.setSession('sess-entry-active', mockChat('entry-active') as never);
      const entry = store.getSessionEntry('sess-entry-active');

      assert.ok(entry);
      assert.strictEqual(entry.id, 'sess-entry-active');
      assert.strictEqual(typeof entry.lastAccess, 'number');
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

    it('notifies when transcript entries are appended', () => {
      const store = createStore();
      let detailUris: string[] = [];
      let eventUris: string[] = [];
      let transcriptUris: string[] = [];
      store.setSession('sess-transcript-notify', mockChat('transcript-notify') as never);
      store.subscribe((event) => {
        detailUris = event.detailUris;
        eventUris = event.eventUris;
        transcriptUris = event.transcriptUris;
      });

      store.appendSessionTranscript('sess-transcript-notify', {
        role: 'user',
        text: 'Hello again',
        timestamp: 3,
      });

      assert.deepStrictEqual(detailUris, ['memory://sessions/sess-transcript-notify']);
      assert.deepStrictEqual(eventUris, ['memory://sessions/sess-transcript-notify/events']);
      assert.deepStrictEqual(transcriptUris, [
        'memory://sessions/sess-transcript-notify/transcript',
      ]);
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
          toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
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
            toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
          },
          timestamp: 1,
        },
      ]);
    });

    it('notifies when session event entries are appended', () => {
      const store = createStore();
      let eventUris: string[] = [];
      store.setSession('sess-events-notify', mockChat('events-notify') as never);
      store.subscribe((event) => {
        eventUris = event.eventUris;
      });

      store.appendSessionEvent('sess-events-notify', {
        request: { message: 'inspect events' },
        response: { text: 'done' },
        timestamp: 1,
      });

      assert.deepStrictEqual(eventUris, ['memory://sessions/sess-events-notify/events']);
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
    it('overwrites existing session with same ID', () => {
      const store = createStore();
      const chat1 = mockChat('first');
      const chat2 = mockChat('second');
      store.setSession('sess-overwrite', chat1 as never);
      store.appendSessionTranscript('sess-overwrite', {
        role: 'user',
        text: 'Old turn',
        timestamp: 1,
      });

      store.setSession('sess-overwrite', chat2 as never);

      assert.strictEqual(store.getSession('sess-overwrite'), chat2);
      assert.deepStrictEqual(store.listSessionTranscriptEntries('sess-overwrite'), []);
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

      assert.ok(store.getSession(`${prefix}11`));

      store.setSession(`${prefix}61`, mockChat('lru-overflow') as never);

      assert.strictEqual(store.isEvicted(`${prefix}11`), false);
      assert.strictEqual(store.isEvicted(`${prefix}12`), true);
      assert.strictEqual(store.listSessionTranscriptEntries(`${prefix}12`), undefined);
    });
  });

  describe('change notifications', () => {
    it('notifies when reading a session updates lastAccess', () => {
      const store = createStore();
      let calls = 0;
      store.subscribe(() => {
        calls += 1;
      });

      store.setSession('sess-read-notify', mockChat('read-notify') as never);
      calls = 0;

      assert.ok(store.getSession('sess-read-notify'));
      assert.strictEqual(calls, 1);
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

    it('includes detail and transcript URIs on setSession', () => {
      const store = createStore();
      let detailUris: string[] = [];
      let eventUris: string[] = [];
      let transcriptUris: string[] = [];
      store.subscribe((event) => {
        detailUris = event.detailUris;
        eventUris = event.eventUris;
        transcriptUris = event.transcriptUris;
      });

      store.setSession('sess-task-set', mockChat('task-set') as never);
      assert.ok(detailUris.includes('memory://sessions/sess-task-set'));
      assert.ok(eventUris.includes('memory://sessions/sess-task-set/events'));
      assert.ok(transcriptUris.includes('memory://sessions/sess-task-set/transcript'));
    });

    it('includes detail and transcript URIs on getSession', () => {
      const store = createStore();
      let detailUris: string[] = [];
      let eventUris: string[] = [];
      let transcriptUris: string[] = [];
      store.setSession('sess-task-get', mockChat('task-get') as never);
      store.subscribe((event) => {
        detailUris = event.detailUris;
        eventUris = event.eventUris;
        transcriptUris = event.transcriptUris;
      });

      store.getSession('sess-task-get');
      assert.deepStrictEqual(detailUris, ['memory://sessions/sess-task-get']);
      assert.deepStrictEqual(eventUris, ['memory://sessions/sess-task-get/events']);
      assert.deepStrictEqual(transcriptUris, ['memory://sessions/sess-task-get/transcript']);
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
});
