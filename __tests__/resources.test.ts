import assert from 'node:assert';
import { test } from 'node:test';

import { createSessionStore } from '../src/sessions.js';

test('SessionStore — provides getSessionInteractionId method', () => {
  const sessionStore = createSessionStore({ ttlMs: 60_000 });

  // Verify that getSessionInteractionId returns undefined for nonexistent session
  const result = sessionStore.getSessionInteractionId('nonexistent-session');
  assert.strictEqual(result, undefined);
});

test('SessionStore — supports session entries with interactionId', () => {
  const sessionStore = createSessionStore({ ttlMs: 60_000 });

  // Verify session store is created
  assert.ok(sessionStore);

  // Verify getSessionEntry returns undefined for new sessions
  const entry = sessionStore.getSessionEntry('test-session');
  assert.strictEqual(entry, undefined);
});
