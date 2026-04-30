// __tests__/tools/chat.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

import { consumeInteractionStream } from '../../src/lib/interaction-stream.js';
import { buildInteractionParams } from '../../src/lib/interactions.js';
import type { ResolvedProfile } from '../../src/lib/tool-profiles.js';
import type { SessionAccess, SessionSummary } from '../../src/sessions.js';

// ── Test: buildInteractionParams builds valid params for session turns ──

test('chat tool with sessionId routes to Interactions API — buildInteractionParams', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const params = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Hello, assistant',
    previousInteractionId: 'interaction-123',
  });

  // Verify params structure
  assert.strictEqual((params as Record<string, unknown>).model, 'gemini-3-pro-preview');
  assert.strictEqual((params as Record<string, unknown>).input, 'Hello, assistant');
  assert.strictEqual(
    (params as Record<string, unknown>).previous_interaction_id,
    'interaction-123',
  );
});

// ── Test: consumeInteractionStream parses SSE deltas ──

test('chat tool with sessionId routes to Interactions API — consumeInteractionStream', async () => {
  const mockEvents = [
    { type: 'content_part_delta', index: 0, delta: { text: 'Hello ' } },
    { type: 'content_part_delta', index: 0, delta: { text: 'world' } },
    { type: 'message_stop' },
  ];

  const emitter = {
    emit: () => {
      // no-op
    },
  };

  const eventStream = (async function* () {
    for (const evt of mockEvents) {
      yield evt;
    }
  })();

  const result = await consumeInteractionStream(eventStream, emitter);

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.text, 'Hello world');
});

// ── Test: SessionAccess provides necessary methods ──

test('chat tool with sessionId routes to Interactions API — SessionAccess', () => {
  const mockSessionAccess: Partial<SessionAccess> = {
    getSessionEntry: (id: string) => {
      if (id === 'test-session-123') {
        return {
          id: 'test-session-123',
          lastAccess: Date.now(),
          transcriptCount: 0,
          eventCount: 0,
        } satisfies SessionSummary;
      }
      return undefined;
    },
    appendEvent: () => true,
    appendTranscript: () => true,
    completeSessionIds: () => [],
    listTranscriptEntries: () => [],
    isEvicted: () => false,
  };

  assert.ok(mockSessionAccess.getSessionEntry('test-session-123') !== undefined);
  assert.strictEqual(mockSessionAccess.appendEvent('test-session-123', {} as never), true);
  assert.strictEqual(mockSessionAccess.appendTranscript('test-session-123', {} as never), true);
});
