import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from '../../src/lib/event-store.js';

function msg(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', method: 'test', params: { id } };
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

  it('replays only the snapshot captured at replay start', async () => {
    const store = new InMemoryEventStore();
    const e1 = await store.storeEvent('s1', msg(1));
    const e2 = await store.storeEvent('s1', msg(2));
    const e3 = await store.storeEvent('s1', msg(3));

    const replayed: string[] = [];
    await store.replayEventsAfter(e1, {
      send: async (eventId) => {
        replayed.push(eventId);
        if (eventId === e2) {
          await store.storeEvent('s1', msg(4));
        }
      },
    });

    assert.deepStrictEqual(replayed, [e2, e3]);
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

  it('replays correctly after head eviction (offset math)', async () => {
    const store = new InMemoryEventStore();

    // Store 1002 events — first two evicted, third (e-3) survives
    const eventIds: string[] = [];
    for (let i = 0; i < 1002; i++) {
      eventIds.push(await store.storeEvent('s1', msg(i)));
    }

    // e-1 and e-2 evicted
    const first = eventIds[0] ?? '';
    const second = eventIds[1] ?? '';
    assert.equal(await store.getStreamIdForEventId(first), undefined);
    assert.equal(await store.getStreamIdForEventId(second), undefined);

    // e-3 (index 2) still present — replay from it should return e-4 onward
    const thirdEventId = eventIds[2] ?? '';
    assert.equal(await store.getStreamIdForEventId(thirdEventId), 's1');

    const replayed: string[] = [];
    await store.replayEventsAfter(thirdEventId, {
      send: async (eventId) => {
        replayed.push(eventId);
      },
    });

    // 1002 total - 2 evicted - 1 (the anchor) = 999 events replayed
    assert.equal(replayed.length, 999);
    assert.equal(replayed[0], eventIds[3]);
    assert.equal(replayed[replayed.length - 1], eventIds[1001]);
  });

  it('evicts the least recently active stream when max streams exceeded', async () => {
    const store = new InMemoryEventStore();
    const firstEventIds = new Map<string, string>();

    // Create 200 streams, then refresh s-0 so s-1 becomes the oldest active stream.
    for (let i = 0; i < 200; i++) {
      const streamId = `s-${i}`;
      firstEventIds.set(streamId, await store.storeEvent(streamId, msg(i)));
    }
    const refreshedEventId = await store.storeEvent('s-0', msg(999));
    await store.storeEvent('s-200', msg(200));

    assert.equal(await store.getStreamIdForEventId(firstEventIds.get('s-1') ?? ''), undefined);
    assert.equal(await store.getStreamIdForEventId(firstEventIds.get('s-0') ?? ''), 's-0');
    assert.equal(await store.getStreamIdForEventId(refreshedEventId), 's-0');
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
