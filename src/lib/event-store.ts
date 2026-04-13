import type { EventId, EventStore, JSONRPCMessage, StreamId } from '@modelcontextprotocol/server';

const MAX_EVENTS_PER_STREAM = 1000;
const MAX_STREAMS = 200;

interface StoredEvent {
  eventId: EventId;
  message: JSONRPCMessage;
}

interface StreamState {
  events: StoredEvent[];
  baseOffset: number;
}

interface EventLocation {
  streamId: StreamId;
  absoluteIndex: number;
}

export class InMemoryEventStore implements EventStore {
  private _streams = new Map<StreamId, StreamState>();
  private _eventToStream = new Map<EventId, EventLocation>();
  private _counter = 0;

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId: EventId = `e-${++this._counter}`;

    let state = this._streams.get(streamId);
    if (!state) {
      this._evictIfNeeded();
      state = { events: [], baseOffset: 0 };
      this._streams.set(streamId, state);
    }

    if (state.events.length >= MAX_EVENTS_PER_STREAM) {
      const removed = state.events.shift();
      if (removed) this._eventToStream.delete(removed.eventId);
      state.baseOffset++;
    }

    const absoluteIndex = state.baseOffset + state.events.length;
    state.events.push({ eventId, message });
    this._eventToStream.set(eventId, { streamId, absoluteIndex });

    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this._eventToStream.get(eventId)?.streamId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const location = this._eventToStream.get(lastEventId);
    if (!location) return '';

    const state = this._streams.get(location.streamId);
    if (!state) return location.streamId;

    const arrayIndex = location.absoluteIndex - state.baseOffset;
    if (arrayIndex < 0 || arrayIndex >= state.events.length) return location.streamId;

    for (let i = arrayIndex + 1; i < state.events.length; i++) {
      const event = state.events[i];
      if (event) await send(event.eventId, event.message);
    }

    return location.streamId;
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

    const state = this._streams.get(oldest.value);
    if (state) {
      for (const e of state.events) this._eventToStream.delete(e.eventId);
    }
    this._streams.delete(oldest.value);
  }
}
