import type { Chat } from '@google/genai';

import type { ToolProfile } from './lib/orchestration.js';
import type { FunctionCallEntry, ToolEvent } from './lib/streaming.js';
import type { UsageMetadata } from './schemas/outputs.js';

import { getSessionLimits } from './config.js';

const MAX_EVICTED_ENTRIES = 1000;
const EVICTED_TRIM_TARGET = Math.floor(MAX_EVICTED_ENTRIES / 2);
const EVICTION_SWEEP_INTERVAL_MS = 60_000;

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  taskId?: string;
}

export interface SessionEventEntry {
  request: {
    message: string;
    toolProfile?: ToolProfile;
    urls?: string[];
  };
  response: {
    data?: unknown;
    functionCalls?: FunctionCallEntry[];
    schemaWarnings?: string[];
    thoughts?: string;
    text: string;
    toolEvents?: ToolEvent[];
    usage?: UsageMetadata;
  };
  timestamp: number;
  taskId?: string;
}

interface SessionEntry {
  chat: Chat;
  events: SessionEventEntry[];
  lastAccess: number;
  transcript: TranscriptEntry[];
}

export interface SessionSummary {
  id: string;
  lastAccess: number;
}

export interface SessionChangeEvent {
  detailUris: string[];
  eventUris: string[];
  transcriptUris: string[];
}

export interface SessionStoreOptions {
  maxEventEntries?: number;
  maxSessions?: number;
  maxTranscriptEntries?: number;
  now?: () => number;
  sweepIntervalMs?: number;
  ttlMs?: number;
}

type SessionChangeSubscriber = (event: SessionChangeEvent) => void;

function sessionDetailUri(id: string): string {
  return `sessions://${id}`;
}

function sessionTranscriptUri(id: string): string {
  return `sessions://${id}/transcript`;
}

function sessionEventsUri(id: string): string {
  return `sessions://${id}/events`;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneSessionEventEntry(item: SessionEventEntry): SessionEventEntry {
  return {
    ...item,
    request: {
      ...item.request,
      ...(item.request.urls ? { urls: [...item.request.urls] } : {}),
    },
    response: {
      ...item.response,
      ...(item.response.data !== undefined ? { data: cloneValue(item.response.data) } : {}),
      ...(item.response.functionCalls
        ? {
            functionCalls: item.response.functionCalls.map((functionCall) => ({ ...functionCall })),
          }
        : {}),
      ...(item.response.schemaWarnings
        ? { schemaWarnings: [...item.response.schemaWarnings] }
        : {}),
      ...(item.response.thoughts ? { thoughts: item.response.thoughts } : {}),
      ...(item.response.toolEvents
        ? { toolEvents: item.response.toolEvents.map((toolEvent) => ({ ...toolEvent })) }
        : {}),
      ...(item.response.usage ? { usage: { ...item.response.usage } } : {}),
    },
  };
}

function toSessionSummary(id: string, entry: SessionEntry): SessionSummary {
  return { id, lastAccess: entry.lastAccess };
}

export class SessionStore {
  private readonly evictedSessions = new Set<string>();

  private evictionTimer: ReturnType<typeof setInterval> | undefined;

  private readonly maxSessions: number;

  private readonly maxEventEntries: number;

  private readonly maxTranscriptEntries: number;

  private readonly nowFn: () => number;

  private readonly sessions = new Map<string, SessionEntry>();

  private readonly subscribers = new Set<SessionChangeSubscriber>();

  private readonly sweepIntervalMs: number;

  private readonly ttlMs: number;

  constructor(options: SessionStoreOptions = {}) {
    const defaults = getSessionLimits();
    this.maxEventEntries = options.maxEventEntries ?? defaults.maxEventEntries;
    this.maxSessions = options.maxSessions ?? defaults.maxSessions;
    this.maxTranscriptEntries = options.maxTranscriptEntries ?? defaults.maxTranscriptEntries;
    this.nowFn = options.now ?? (() => Date.now());
    this.sweepIntervalMs = options.sweepIntervalMs ?? EVICTION_SWEEP_INTERVAL_MS;
    this.ttlMs = options.ttlMs ?? defaults.ttlMs;
  }

  subscribe(cb: SessionChangeSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  close(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = undefined;
    }
    this.sessions.clear();
    this.evictedSessions.clear();
    this.subscribers.clear();
  }

  listSessionEntries(): SessionSummary[] {
    const evictedIds = this.evictExpiredSessions();
    if (evictedIds.length > 0) {
      this.notifyChange(evictedIds);
    }

    return Array.from(this.sessions, ([id, entry]) => toSessionSummary(id, entry));
  }

  listSessionTranscriptEntries(id: string): TranscriptEntry[] | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return entry.transcript.map((item) => ({ ...item }));
  }

  listSessionEventEntries(id: string): SessionEventEntry[] | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return entry.events.map((item) => cloneSessionEventEntry(item));
  }

  appendSessionTranscript(id: string, item: TranscriptEntry): boolean {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return false;
    entry.transcript.push({ ...item });
    this.trimSessionHistory(entry.transcript, this.maxTranscriptEntries);
    this.notifyChange([id]);
    return true;
  }

  appendSessionEvent(id: string, item: SessionEventEntry): boolean {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return false;
    entry.events.push(cloneSessionEventEntry(item));
    this.trimSessionHistory(entry.events, this.maxEventEntries);
    this.notifyChange([id]);
    return true;
  }

  completeSessionIds(prefix?: string): string[] {
    return this.listSessionEntries()
      .map((session) => session.id)
      .filter((id) => id.startsWith(prefix ?? ''));
  }

  getSessionEntry(id: string): SessionSummary | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return toSessionSummary(id, entry);
  }

  isEvicted(id: string): boolean {
    return this.evictedSessions.has(id);
  }

  getSession(id: string): Chat | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    const chat = this.updateSessionAccess(id, entry);
    this.notifyChange([id]);
    return chat;
  }

  setSession(id: string, chat: Chat): void {
    let evictedId: string | undefined;
    if (this.sessions.size >= this.maxSessions && !this.sessions.has(id)) {
      evictedId = this.evictOldest();
    }
    this.storeSession(id, chat);
    this.startEvictionTimer();
    this.notifyChange(evictedId ? [evictedId, id] : [id]);
  }

  private notifyChange(sessionIds: string[] = []): void {
    if (this.subscribers.size === 0) return;

    const event = {
      detailUris: sessionIds.map((id) => sessionDetailUri(id)),
      eventUris: sessionIds.map((id) => sessionEventsUri(id)),
      transcriptUris: sessionIds.map((id) => sessionTranscriptUri(id)),
    };

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private now(): number {
    return this.nowFn();
  }

  private recordEvictedSession(id: string): void {
    this.evictedSessions.add(id);
    this.trimEvictedSessions();
  }

  private removeSession(id: string, trackEviction = false): boolean {
    const deleted = this.sessions.delete(id);
    if (deleted && trackEviction) {
      this.recordEvictedSession(id);
    }
    return deleted;
  }

  private setSessionEntry(id: string, entry: SessionEntry): void {
    this.sessions.delete(id);
    this.sessions.set(id, entry);
  }

  private updateSessionAccess(id: string, entry: SessionEntry): Chat {
    entry.lastAccess = this.now();
    this.setSessionEntry(id, entry);
    return entry.chat;
  }

  private storeSession(id: string, chat: Chat): void {
    this.evictedSessions.delete(id);
    this.setSessionEntry(id, { chat, events: [], lastAccess: this.now(), transcript: [] });
  }

  private trimEvictedSessions(): void {
    if (this.evictedSessions.size <= MAX_EVICTED_ENTRIES) return;
    const excess = this.evictedSessions.size - EVICTED_TRIM_TARGET;
    let removed = 0;
    for (const id of this.evictedSessions) {
      if (removed >= excess) break;
      this.evictedSessions.delete(id);
      removed++;
    }
  }

  private trimSessionHistory(entries: unknown[], maxEntries: number): void {
    if (entries.length <= maxEntries) return;
    entries.splice(0, entries.length - maxEntries);
  }

  private evictExpiredSessions(): string[] {
    const currentTime = this.now();
    const evictedIds: string[] = [];

    for (const [id, entry] of this.sessions) {
      if (currentTime - entry.lastAccess > this.ttlMs) {
        this.removeSession(id, true);
        evictedIds.push(id);
      }
    }

    return evictedIds;
  }

  private hasExpired(entry: SessionEntry): boolean {
    return this.now() - entry.lastAccess > this.ttlMs;
  }

  private getActiveSessionEntry(id: string): SessionEntry | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    if (!this.hasExpired(entry)) return entry;

    this.removeSession(id, true);
    this.notifyChange([id]);
    return undefined;
  }

  private startEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      const evictedIds = this.evictExpiredSessions();
      if (evictedIds.length > 0) this.notifyChange(evictedIds);
    }, this.sweepIntervalMs);
    this.evictionTimer.unref();
  }

  private oldestSessionId(): string | undefined {
    const oldest = this.sessions.keys().next();
    return oldest.done ? undefined : oldest.value;
  }

  private evictOldest(): string | undefined {
    const oldestId = this.oldestSessionId();
    if (oldestId) {
      this.removeSession(oldestId, true);
    }
    return oldestId;
  }
}

export function createSessionStore(options?: SessionStoreOptions): SessionStore {
  return new SessionStore(options);
}
