import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Sessions module uses module-level state. We import fresh each test via dynamic import.
// Since ESM caches modules, we test the exported API directly.
import {
  completeSessionIds,
  getSession,
  isEvicted,
  listSessionEntries,
  onSessionChange,
  setSession,
} from '../src/sessions.js';

// Minimal mock Chat object — sessions only store the reference
function mockChat(label = 'chat'): { _label: string } {
  return { _label: label } as unknown as ReturnType<typeof mockChat>;
}

describe('sessions', () => {
  // NOTE: Since sessions is module-scoped state, tests are not fully isolated.
  // We test behaviors that don't depend on clean state first.

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
      const before = listSessionEntries().find((s) => s.id === 'sess-access');
      assert.ok(before);

      // Access the session - lastAccess should be >= before
      getSession('sess-access');
      const after = listSessionEntries().find((s) => s.id === 'sess-access');
      assert.ok(after);
      assert.ok(after.lastAccess >= before.lastAccess);
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
      assert.ok(Array.isArray(entries));
      const entry = entries.find((e) => e.id === 'sess-list-test');
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
      setSession('sess-overwrite', chat2 as never);
      const retrieved = getSession('sess-overwrite');
      assert.strictEqual(retrieved, chat2);
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

    it('evicts the least recently used active session', () => {
      const prefix = 'sess-lru-order-';

      for (let i = 0; i <= 60; i += 1) {
        setSession(`${prefix}${String(i)}`, mockChat(`lru-${String(i)}`) as never);
      }

      assert.ok(getSession(`${prefix}11`));

      setSession(`${prefix}61`, mockChat('lru-overflow') as never);

      assert.strictEqual(isEvicted(`${prefix}11`), false);
      assert.strictEqual(isEvicted(`${prefix}12`), true);
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

    it('includes the changed session detail URI on setSession', () => {
      let detailUris: string[] = [];
      onSessionChange((event) => {
        detailUris = event.detailUris;
      });

      setSession('sess-task-set', mockChat('task-set') as never, 'task-123');
      assert.ok(detailUris.includes('sessions://sess-task-set'));
    });

    it('includes the changed session detail URI on getSession', () => {
      let detailUris: string[] = [];
      setSession('sess-task-get', mockChat('task-get') as never);
      onSessionChange((event) => {
        detailUris = event.detailUris;
      });

      getSession('sess-task-get', 'task-456');
      assert.deepStrictEqual(detailUris, ['sessions://sess-task-get']);
    });

    it('provides detail URIs even without a taskId', () => {
      let detailUris: string[] = [];
      onSessionChange((event) => {
        detailUris = event.detailUris;
      });

      setSession('sess-no-task', mockChat('no-task') as never);
      assert.ok(detailUris.includes('sessions://sess-no-task'));
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
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(fresh.getSession('sess-expire-on-read'), undefined);
      assert.strictEqual(fresh.isEvicted('sess-expire-on-read'), true);

      delete process.env.SESSION_TTL_MS;
    });
  });
});
