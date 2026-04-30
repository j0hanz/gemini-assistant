// __tests__/lib/interaction-stream.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

import { consumeInteractionStream } from '../../src/lib/interaction-stream.js';

interface Notification {
  type: string;
  data: unknown;
}

test('consumeInteractionStream — parses SSE deltas and emits notifications', async () => {
  // Mock SSE event stream from Interactions API
  const mockEvents = [
    { type: 'content_part_delta', index: 0, delta: { text: 'Hello ' } },
    { type: 'content_part_delta', index: 0, delta: { text: 'world' } },
    { type: 'message_stop' },
  ];

  const notifications: Notification[] = [];
  const mockEmitter = {
    emit: (type, data) => notifications.push({ type, data }),
  };

  // Create async iterable from mock events
  const eventStream = (async function* () {
    for (const evt of mockEvents) {
      yield evt;
    }
  })();

  const result = await consumeInteractionStream(eventStream, mockEmitter);

  assert.deepStrictEqual(result.status, 'completed');
  assert.strictEqual(result.text, 'Hello world');
  assert.strictEqual(notifications.length, 3);

  // Verify specific notifications
  const progressNotifications = notifications.filter((n) => n.type === 'progress');
  assert.strictEqual(progressNotifications.length, 2);
  assert.deepStrictEqual(progressNotifications[0].data, { delta: 'Hello ' });
  assert.deepStrictEqual(progressNotifications[1].data, { delta: 'world' });

  const phaseTransitions = notifications.filter((n) => n.type === 'phase-transition');
  assert.strictEqual(phaseTransitions.length, 1);
  assert.deepStrictEqual(phaseTransitions[0].data, { phase: 'completed' });
});

test('consumeInteractionStream — handles errors gracefully', async () => {
  const notifications: Notification[] = [];
  const mockEmitter = {
    emit: (type, data) => notifications.push({ type, data }),
  };

  // Create an event stream that throws an error mid-process
  const eventStream = (async function* () {
    yield { type: 'content_part_delta', index: 0, delta: { text: 'Hello ' } };
    throw new Error('Stream processing failed');
  })();

  const result = await consumeInteractionStream(eventStream, mockEmitter);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.text, 'Hello ');
  assert.ok(result.error instanceof Error);
  assert.strictEqual(result.error.message, 'Stream processing failed');

  // Verify error phase transition was emitted
  const phaseTransitions = notifications.filter((n) => n.type === 'phase-transition');
  assert.strictEqual(phaseTransitions.length, 1);
  const phaseData = phaseTransitions[0].data as Record<string, unknown>;
  assert.strictEqual(phaseData.phase, 'failed');
  assert.ok(phaseData.error instanceof Error);
});

test('consumeInteractionStream — handles empty stream', async () => {
  const notifications: Notification[] = [];
  const mockEmitter = {
    emit: (type, data) => notifications.push({ type, data }),
  };

  // Create an empty event stream
  const eventStream = (async function* () {
    // No events
  })();

  const result = await consumeInteractionStream(eventStream, mockEmitter);

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.text, undefined);
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(notifications.length, 0);
});

test('consumeInteractionStream — handles missing delta text', async () => {
  const mockEvents = [
    { type: 'content_part_delta', index: 0, delta: { notText: 'value' } },
    { type: 'content_part_delta', index: 0, delta: null },
    { type: 'content_part_delta', index: 0 },
    { type: 'thought_summary', summary: 'A summary' },
    { type: 'message_stop' },
  ];

  const notifications: Notification[] = [];
  const mockEmitter = {
    emit: (type, data) => notifications.push({ type, data }),
  };

  const eventStream = (async function* () {
    for (const evt of mockEvents) {
      yield evt;
    }
  })();

  const result = await consumeInteractionStream(eventStream, mockEmitter);

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.text, undefined);

  // Verify progress notifications were NOT emitted for invalid deltas
  const progressNotifications = notifications.filter((n) => n.type === 'progress');
  assert.strictEqual(progressNotifications.length, 0);

  // Verify thought summary was emitted
  const thoughtNotifications = notifications.filter((n) => n.type === 'thought-delta');
  assert.strictEqual(thoughtNotifications.length, 1);
  assert.deepStrictEqual(thoughtNotifications[0].data, { summary: 'A summary' });

  // Verify phase transition was emitted
  const phaseTransitions = notifications.filter((n) => n.type === 'phase-transition');
  assert.strictEqual(phaseTransitions.length, 1);
});
