import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendSessionTranscript,
  completeSessionIds,
  getSession,
  getSessionEntry,
  isEvicted,
  listSessionEntries,
  listSessionTranscriptEntries,
  onSessionChange,
  setSession,
} from '../src/sessions.js';

function mockChat(label = 'chat'): { _label: string } {
  return { _label: label } as unknown as ReturnType<typeof mockChat>;
}

describe('sessions', () => {
  describe('getSession / setSession', () => {
    it('stores and retrieves a session', () => {
      const chat = mockChat('test-1');
      setSession('sess-get-set', chat as never);
      const retrieved = getSession('sess-get-set');
      assert.strictEqual(retrieved, chat);
    });

    it('returns undefined for unknown session', () => {
      const result = getSession('nonexistent-session-id-xyz');
      assert.strictEqual(result, undefined);
    });

    it('updates lastAccess on get', () => {
      setSession('sess-access', mockChat() as never);
      const before = listSessionEntries().find((session) => session.id === 'sess-access');
      assert.ok(before);

      getSession('sess-access');
      const after = listSessionEntries().find((session) => session.id === 'sess-access');
      assert.ok(after);
      assert.ok(after.lastAccess >= before.lastAccess);
    });

    it('returns metadata for an active session', () => {
      setSession('sess-entry-active', mockChat('entry-active') as never);
      const entry = getSessionEntry('sess-entry-active');

      assert.ok(entry);
      assert.strictEqual(entry.id, 'sess-entry-active');
      assert.strictEqual(typeof entry.lastAccess, 'number');
    });
  });

  describe('transcripts', () => {
    it('initializes an empty transcript for new sessions', () => {
      setSession('sess-empty-transcript', mockChat('empty') as never);
      assert.deepStrictEqual(listSessionTranscriptEntries('sess-empty-transcript'), []);
    });

    it('appends and reads transcript entries', () => {
      setSession('sess-transcript-append', mockChat('append') as never);
      appendSessionTranscript('sess-transcript-append', {
        role: 'user',
        text: 'Hello',
        timestamp: 1,
      });
      appendSessionTranscript('sess-transcript-append', {
        role: 'assistant',
        text: 'Hi',
        timestamp: 2,
        taskId: 'task-1',
      });

      assert.deepStrictEqual(listSessionTranscriptEntries('sess-transcript-append'), [
        { role: 'user', text: 'Hello', timestamp: 1 },
        { role: 'assistant', text: 'Hi', timestamp: 2, taskId: 'task-1' },
      ]);
    });

    it('notifies when transcript entries are appended', () => {
      let detailUris: string[] = [];
      let transcriptUris: string[] = [];
      setSession('sess-transcript-notify', mockChat('transcript-notify') as never);
      onSessionChange((event) => {
        detailUris = event.detailUris;
        transcriptUris = event.transcriptUris;
      });

      appendSessionTranscript('sess-transcript-notify', {
        role: 'user',
        text: 'Hello again',
        timestamp: 3,
      });

      assert.deepStrictEqual(detailUris, ['sessions://sess-transcript-notify']);
      assert.deepStrictEqual(transcriptUris, ['sessions://sess-transcript-notify/transcript']);
    });
  });

  describe('isEvicted', () => {
    it('returns false for active session', () => {
      setSession('sess-active', mockChat() as never);
      assert.strictEqual(isEvicted('sess-active'), false);
    });

    it('returns false for unknown session', () => {
      assert.strictEqual(isEvicted('never-existed-session'), false);
    });
  });

  describe('listSessionEntries', () => {
    it('returns array of session entries', () => {
      setSession('sess-list-test', mockChat() as never);
      const entries = listSessionEntries();
      const entry = entries.find((session) => session.id === 'sess-list-test');

      assert.ok(Array.isArray(entries));
      assert.ok(entry);
      assert.strictEqual(typeof entry.lastAccess, 'number');
    });
  });

  describe('completeSessionIds', () => {
    it('filters active session ids by prefix', () => {
      setSession('sess-complete-alpha', mockChat('alpha') as never);
      setSession('sess-complete-beta', mockChat('beta') as never);

      assert.deepStrictEqual(completeSessionIds('sess-complete-a'), ['sess-complete-alpha']);
    });

    it('returns all active session ids when prefix is omitted', () => {
      setSession('sess-complete-all', mockChat('all') as never);
      assert.ok(completeSessionIds().includes('sess-complete-all'));
    });
  });

  describe('session overwrite', () => {
    it('overwrites existing session with same ID', () => {
      const chat1 = mockChat('first');
      const chat2 = mockChat('second');
      setSession('sess-overwrite', chat1 as never);
      appendSessionTranscript('sess-overwrite', {
        role: 'user',
        text: 'Old turn',
        timestamp: 1,
      });

      setSession('sess-overwrite', chat2 as never);

      assert.strictEqual(getSession('sess-overwrite'), chat2);
      assert.deepStrictEqual(listSessionTranscriptEntries('sess-overwrite'), []);
    });

    it('clears evicted state when a session ID is reused', () => {
      const prefix = 'sess-evicted-reuse-';

      for (let i = 0; i < 60; i += 1) {
        setSession(`${prefix}${String(i)}`, mockChat(`bulk-${String(i)}`) as never);
      }

      assert.strictEqual(isEvicted(`${prefix}0`), true);

      const revived = mockChat('revived');
      setSession(`${prefix}0`, revived as never);

      assert.strictEqual(isEvicted(`${prefix}0`), false);
      assert.strictEqual(getSession(`${prefix}0`), revived);
    });

    it('evicts the least recently used active session and its transcript', () => {
      const prefix = 'sess-lru-order-';

      for (let i = 0; i <= 60; i += 1) {
        setSession(`${prefix}${String(i)}`, mockChat(`lru-${String(i)}`) as never);
      }

      appendSessionTranscript(`${prefix}12`, {
        role: 'user',
        text: 'Will be evicted',
        timestamp: 1,
      });

      assert.ok(getSession(`${prefix}11`));

      setSession(`${prefix}61`, mockChat('lru-overflow') as never);

      assert.strictEqual(isEvicted(`${prefix}11`), false);
      assert.strictEqual(isEvicted(`${prefix}12`), true);
      assert.strictEqual(listSessionTranscriptEntries(`${prefix}12`), undefined);
    });
  });

  describe('change notifications', () => {
    it('notifies when reading a session updates lastAccess', () => {
      let calls = 0;
      onSessionChange(() => {
        calls += 1;
      });

      setSession('sess-read-notify', mockChat('read-notify') as never);
      calls = 0;

      assert.ok(getSession('sess-read-notify'));
      assert.strictEqual(calls, 1);
    });

    it('notifies once when adding a session over capacity', () => {
      const prefix = 'sess-overflow-notify-';

      for (let i = 0; i < 60; i += 1) {
        setSession(`${prefix}${String(i)}`, mockChat(`notify-${String(i)}`) as never);
      }

      let calls = 0;
      onSessionChange(() => {
        calls += 1;
      });

      setSession(`${prefix}overflow`, mockChat('notify-overflow') as never);
      assert.strictEqual(calls, 1);
    });

    it('includes detail and transcript URIs on setSession', () => {
      let detailUris: string[] = [];
      let transcriptUris: string[] = [];
      onSessionChange((event) => {
        detailUris = event.detailUris;
        transcriptUris = event.transcriptUris;
      });

      setSession('sess-task-set', mockChat('task-set') as never);
      assert.ok(detailUris.includes('sessions://sess-task-set'));
      assert.ok(transcriptUris.includes('sessions://sess-task-set/transcript'));
    });

    it('includes detail and transcript URIs on getSession', () => {
      let detailUris: string[] = [];
      let transcriptUris: string[] = [];
      setSession('sess-task-get', mockChat('task-get') as never);
      onSessionChange((event) => {
        detailUris = event.detailUris;
        transcriptUris = event.transcriptUris;
      });

      getSession('sess-task-get');
      assert.deepStrictEqual(detailUris, ['sessions://sess-task-get']);
      assert.deepStrictEqual(transcriptUris, ['sessions://sess-task-get/transcript']);
    });
  });

  describe('ttl enforcement', () => {
    it('expires sessions on read before the sweep runs', async () => {
      process.env.SESSION_TTL_MS = '1';
      const fresh = (await import(
        `../src/sessions.js?ttl-read=${Date.now()}`
      )) as typeof import('../src/sessions.js');

      const chat = mockChat('ttl-read');
      fresh.setSession('sess-expire-on-read', chat as never);
      fresh.appendSessionTranscript('sess-expire-on-read', {
        role: 'user',
        text: 'hello',
        timestamp: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(fresh.getSession('sess-expire-on-read'), undefined);
      assert.strictEqual(fresh.isEvicted('sess-expire-on-read'), true);
      assert.strictEqual(fresh.listSessionTranscriptEntries('sess-expire-on-read'), undefined);

      delete process.env.SESSION_TTL_MS;
    });

    it('expires sessions on metadata reads before validation can treat them as active', async () => {
      process.env.SESSION_TTL_MS = '1';
      const fresh = (await import(
        `../src/sessions.js?ttl-entry=${Date.now()}`
      )) as typeof import('../src/sessions.js');

      const chat = mockChat('ttl-entry');
      fresh.setSession('sess-expire-on-entry', chat as never);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(fresh.getSessionEntry('sess-expire-on-entry'), undefined);
      assert.strictEqual(fresh.isEvicted('sess-expire-on-entry'), true);

      delete process.env.SESSION_TTL_MS;
    });
  });
});
