import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Sessions module uses module-level state. We import fresh each test via dynamic import.
// Since ESM caches modules, we test the exported API directly.
import { getSession, isEvicted, listSessionEntries, setSession } from '../src/sessions.js';

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
  });
});
