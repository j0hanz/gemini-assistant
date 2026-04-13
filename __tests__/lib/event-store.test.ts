import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from '../../src/lib/event-store.js';

function msg(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', method: 'test', params: { id } } as JSONRPCMessage;
}

describe('InMemoryEventStore', () => {
  it('stores and replays events', async () => {
    const store = new InMemoryEventStore();
    const e1 = await store.storeEvent('s1', msg(1));
    const e2 = await store.storeEvent('s1', msg(2));
    const e3 = await store.storeEvent('s1', msg(3));

    const replayed: { eventId: string; message: JSONRPCMessage }[] = [];
    const streamId = await store.replayEventsAfter(e1, {
      send: async (eventId, message) => {
        replayed.push({ eventId, message });
      },
    });

    assert.equal(streamId, 's1');
    assert.equal(replayed.length, 2);
    assert.equal(replayed[0]?.eventId, e2);
    assert.equal(replayed[1]?.eventId, e3);
  });

  it('returns stream ID for event ID', async () => {
    const store = new InMemoryEventStore();
    const e1 = await store.storeEvent('stream-a', msg(1));

    const streamId = await store.getStreamIdForEventId(e1);
    assert.equal(streamId, 'stream-a');
  });

  it('returns undefined for unknown event ID', async () => {
    const store = new InMemoryEventStore();
    const streamId = await store.getStreamIdForEventId('unknown');
    assert.equal(streamId, undefined);
  });

  it('returns empty string when replaying unknown event', async () => {
    const store = new InMemoryEventStore();
    const streamId = await store.replayEventsAfter('unknown', {
      send: async () => {
        assert.fail('should not be called');
      },
    });
    assert.equal(streamId, '');
  });

  it('replays nothing when last event is the latest', async () => {
    const store = new InMemoryEventStore();
    await store.storeEvent('s1', msg(1));
    const e2 = await store.storeEvent('s1', msg(2));

    const replayed: string[] = [];
    await store.replayEventsAfter(e2, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });

    assert.equal(replayed.length, 0);
  });

  it('evicts oldest events when stream exceeds max', async () => {
    const store = new InMemoryEventStore();

    // Store 1001 events — first one should be evicted
    let firstEventId = '';
    for (let i = 0; i < 1001; i++) {
      const eid = await store.storeEvent('s1', msg(i));
      if (i === 0) firstEventId = eid;
    }

    // First event should be gone
    const streamId = await store.getStreamIdForEventId(firstEventId);
    assert.equal(streamId, undefined);
  });

  it('evicts oldest stream when max streams exceeded', async () => {
    const store = new InMemoryEventStore();

    // Create 201 streams — stream "s-0" should be evicted
    for (let i = 0; i <= 200; i++) {
      await store.storeEvent(`s-${i}`, msg(i));
    }

    // Event from first stream should be gone
    const streamId = await store.getStreamIdForEventId('e-1');
    assert.equal(streamId, undefined);
  });

  it('cleanup clears all state', async () => {
    const store = new InMemoryEventStore();
    const e1 = await store.storeEvent('s1', msg(1));

    store.cleanup();

    const streamId = await store.getStreamIdForEventId(e1);
    assert.equal(streamId, undefined);
  });

  it('generates monotonically increasing event IDs', async () => {
    const store = new InMemoryEventStore();
    const e1 = await store.storeEvent('s1', msg(1));
    const e2 = await store.storeEvent('s1', msg(2));
    const e3 = await store.storeEvent('s2', msg(3));

    assert.equal(e1, 'e-1');
    assert.equal(e2, 'e-2');
    assert.equal(e3, 'e-3');
  });
});
