// __tests__/lib/interaction-stream.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { consumeInteractionStream } from '../../src/lib/interaction-stream.js';

test('consumeInteractionStream — parses SSE deltas and emits notifications', async () => {
  // Mock SSE event stream from Interactions API
  const mockEvents = [
    { type: 'content_part_delta', index: 0, delta: { text: 'Hello ' } },
    { type: 'content_part_delta', index: 0, delta: { text: 'world' } },
    { type: 'message_stop' },
  ];

  const notifications = [];
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
  assert.ok(result.text.includes('Hello world'));
  assert.ok(notifications.length > 0);
});
