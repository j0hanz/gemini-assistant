import type { EventId, EventStore, JSONRPCMessage, StreamId } from '@modelcontextprotocol/server';

const MAX_EVENTS_PER_STREAM = 1000;
const MAX_STREAMS = 200;

interface StoredEvent {
  eventId: EventId;
  message: JSONRPCMessage;
}

export class InMemoryEventStore implements EventStore {
  private _streams = new Map<StreamId, StoredEvent[]>();
  private _eventToStream = new Map<EventId, StreamId>();
  private _counter = 0;

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId: EventId = `e-${++this._counter}`;

    let events = this._streams.get(streamId);
    if (!events) {
      this._evictIfNeeded();
      events = [];
      this._streams.set(streamId, events);
    }

    if (events.length >= MAX_EVENTS_PER_STREAM) {
      const removed = events.shift();
      if (removed) this._eventToStream.delete(removed.eventId);
    }

    events.push({ eventId, message });
    this._eventToStream.set(eventId, streamId);

    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this._eventToStream.get(eventId));
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = this._eventToStream.get(lastEventId);
    if (!streamId) return '';

    const events = this._streams.get(streamId);
    if (!events) return streamId;

    const idx = events.findIndex((e) => e.eventId === lastEventId);
    if (idx === -1) return streamId;

    for (let i = idx + 1; i < events.length; i++) {
      const event = events[i];
      if (event) await send(event.eventId, event.message);
    }

    return streamId;
  }

  cleanup(): void {
    this._streams.clear();
    this._eventToStream.clear();
    this._counter = 0;
  }

  private _evictIfNeeded(): void {
    if (this._streams.size < MAX_STREAMS) return;

    const oldest = this._streams.keys().next();
    if (oldest.done) return;

    const events = this._streams.get(oldest.value);
    if (events) {
      for (const e of events) this._eventToStream.delete(e.eventId);
    }
    this._streams.delete(oldest.value);
  }
}
