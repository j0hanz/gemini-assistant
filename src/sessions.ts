
import type {
  GroundingMetadata,
  UrlContextMetadata,
} from '@google/genai';
import type { FunctionCallEntry, StreamAnomalies, ToolEvent } from './lib/streaming.js';
import type { UsageMetadata } from './schemas/outputs.js';

import { getSessionLimits, getSlimSessionEvents } from './config.js';

const MAX_EVICTED_ENTRIES = 1000;
const EVICTED_TRIM_TARGET = Math.floor(MAX_EVICTED_ENTRIES / 2);

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  taskId?: string;
}


export interface SessionEventEntry {
  request: {
    message: string;
    sentMessage?: string;
    toolProfile?: string;
    urls?: string[];
  };
  response: {
    data?: unknown;
    finishReason?: string;
    functionCalls?: FunctionCallEntry[];
    citationMetadata?: unknown;
    promptBlockReason?: string;
    promptFeedback?: unknown;
    schemaWarnings?: string[];
    safetyRatings?: unknown;
    finishMessage?: string;
    thoughts?: string;
    text: string;
    toolEvents?: ToolEvent[];
    usage?: UsageMetadata;
    groundingMetadata?: GroundingMetadata;
    urlContextMetadata?: UrlContextMetadata;
    anomalies?: StreamAnomalies;
  };
  timestamp: number;
  taskId?: string;
}


interface SessionEntry {
  interactionId: string;
  lastAccess: number;
  transcript: TranscriptEntry[];
  events: SessionEventEntry[];
}

export interface SessionSummary {
  id: string;
  lastAccess: number;
  transcriptCount: number;
  eventCount: number;
}

export interface SessionAccess {
  appendEvent(id: string, item: SessionEventEntry): boolean;
  appendTranscript(id: string, item: TranscriptEntry): boolean;
  completeSessionIds(prefix?: string): string[];
  getSessionEntry(id: string): SessionSummary | undefined;
  isEvicted(id: string): boolean;
  listTranscriptEntries(id: string): TranscriptEntry[] | undefined;
}

export interface SessionChangeEvent {
  listChanged: boolean;
  turnPartsAdded?: { sessionId: string; turnIndex: number };
}

interface SessionStoreOptions {
  maxEventEntries?: number;
  maxSessions?: number;
  maxTranscriptEntries?: number;
  now?: () => number;
  sweepIntervalMs?: number;
  ttlMs?: number;
}

type SessionChangeSubscriber = (event: SessionChangeEvent) => void;

const SESSION_FREE_TEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /("(?:api[_-]?key|authorization|password|secret|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
];




export function sanitizeSessionText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  return SESSION_FREE_TEXT_SECRET_PATTERNS.reduce((current, pattern, index) => {
    if (index === 0) {
      return current.replace(pattern, '$1"[REDACTED]"');
    }

    return current.replace(pattern, '[REDACTED]');
  }, text);
}




function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

type ResponseField = SessionEventEntry['response'];
type ResponseCloneStrategy = 'direct' | 'structuredClone' | 'shallowSpread' | 'arrayShallow';
interface ResponseFieldRule {
  key: keyof ResponseField;
  slimOnly: boolean;
  clone: ResponseCloneStrategy;
}

const RESPONSE_FIELD_RULES: readonly ResponseFieldRule[] = [
  { key: 'finishReason', slimOnly: false, clone: 'direct' },
  { key: 'promptBlockReason', slimOnly: false, clone: 'direct' },
  { key: 'data', slimOnly: false, clone: 'structuredClone' },
  { key: 'functionCalls', slimOnly: false, clone: 'arrayShallow' },
  { key: 'citationMetadata', slimOnly: true, clone: 'structuredClone' },
  { key: 'safetyRatings', slimOnly: true, clone: 'structuredClone' },
  { key: 'finishMessage', slimOnly: false, clone: 'direct' },
  { key: 'schemaWarnings', slimOnly: false, clone: 'arrayShallow' },
  { key: 'thoughts', slimOnly: true, clone: 'direct' },
  { key: 'toolEvents', slimOnly: true, clone: 'arrayShallow' },
  { key: 'usage', slimOnly: false, clone: 'shallowSpread' },
  { key: 'groundingMetadata', slimOnly: true, clone: 'structuredClone' },
  { key: 'urlContextMetadata', slimOnly: true, clone: 'structuredClone' },
  { key: 'promptFeedback', slimOnly: true, clone: 'structuredClone' },
  { key: 'anomalies', slimOnly: false, clone: 'shallowSpread' },
];

function applyResponseClone(value: unknown, strategy: ResponseCloneStrategy): unknown {
  switch (strategy) {
    case 'direct':
      return value;
    case 'structuredClone':
      return cloneValue(value);
    case 'shallowSpread':
      return { ...(value as object) };
    case 'arrayShallow':
      return (value as readonly unknown[]).map((entry) =>
        entry !== null && typeof entry === 'object' ? { ...entry } : entry,
      );
  }
}

function cloneSessionEventEntry(item: SessionEventEntry): SessionEventEntry {
  const slim = getSlimSessionEvents();
  const response: ResponseField = { text: item.response.text };
  for (const rule of RESPONSE_FIELD_RULES) {
    if (rule.slimOnly && slim) continue;
    const value = item.response[rule.key];
    if (value === undefined) continue;
    (response as Record<string, unknown>)[rule.key] = applyResponseClone(value, rule.clone);
  }

  return {
    ...item,
    request: {
      ...item.request,
      message: sanitizeSessionText(item.request.message) ?? item.request.message,
      ...(item.request.sentMessage !== undefined
        ? { sentMessage: sanitizeSessionText(item.request.sentMessage) ?? item.request.sentMessage }
        : {}),
      ...(item.request.toolProfile !== undefined
        ? { toolProfile: sanitizeSessionText(item.request.toolProfile) ?? item.request.toolProfile }
        : {}),
      ...(item.request.urls ? { urls: [...item.request.urls] } : {}),
    },
    response,
  };
}

function toSessionSummary(id: string, entry: SessionEntry): SessionSummary {
  return {
    id,
    lastAccess: entry.lastAccess,
    transcriptCount: entry.transcript.length,
    eventCount: entry.events.length,
  };
}




export class SessionStore {
  private readonly evictedSessions = new Set<string>();

  private evictionTimer: ReturnType<typeof setInterval> | undefined;

  private readonly maxEventEntries: number;

  private readonly maxTranscriptEntries: number;

  private readonly nowFn: () => number;

  private readonly sessions = new Map<string, SessionEntry>();

  private readonly subscribers = new Set<SessionChangeSubscriber>();

  private readonly ttlMs: number;

  constructor(options: SessionStoreOptions = {}) {
    const defaults = getSessionLimits();
    this.maxEventEntries = options.maxEventEntries ?? defaults.maxEventEntries;
    this.maxTranscriptEntries = options.maxTranscriptEntries ?? defaults.maxTranscriptEntries;
    this.nowFn = options.now ?? (() => Date.now());
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
    // Filter out expired sessions without mutating the Map during iteration.
    const active: SessionSummary[] = [];
    for (const [id, entry] of this.sessions) {
      if (this.hasExpired(entry)) {
        continue;
      }
      active.push(toSessionSummary(id, entry));
    }
    return active;
  }

  listSessionTranscriptEntries(id: string): TranscriptEntry[] | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return entry.transcript.map((item) => ({
      ...item,
      text: sanitizeSessionText(item.text) ?? item.text,
    }));
  }

  listSessionEventEntries(id: string): SessionEventEntry[] | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return entry.events.map((item) => cloneSessionEventEntry(item));
  }


  appendSessionTranscript(id: string, item: TranscriptEntry): boolean {
    return this.appendSessionHistoryEntry(
      id,
      item,
      (entry) => entry.transcript,
      (value) => ({ ...value }),
      this.maxTranscriptEntries,
    );
  }


  appendSessionEvent(id: string, item: SessionEventEntry): boolean {
    return this.appendSessionHistoryEntry(
      id,
      item,
      (entry) => entry.events,
      cloneSessionEventEntry,
      this.maxEventEntries,
    );
  }

  private appendSessionHistoryEntry<T>(
    id: string,
    item: T,
    selectEntries: (entry: SessionEntry) => T[],
    cloneItem: (item: T) => T,
    maxEntries: number,
  ): boolean {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return false;
    const entries = selectEntries(entry);
    entries.push(cloneItem(item));
    this.trimSessionHistory(entries, maxEntries);
    this.touchSessionEntry(id, entry);
    return true;
  }

  completeSessionIds(prefix?: string): string[] {
    const lowered = (prefix ?? '').toLowerCase();
    return this.listSessionEntries()
      .map((session) => session.id)
      .filter((id) => id.toLowerCase().startsWith(lowered));
  }

  getSessionEntry(id: string): SessionSummary | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return toSessionSummary(id, entry);
  }

  isEvicted(id: string): boolean {
    return this.evictedSessions.has(id);
  }




  private notifyChange(
    listChanged = true,
    turnPartsAdded?: { sessionId: string; turnIndex: number },
  ): void {
    if (this.subscribers.size === 0) return;

    const event: SessionChangeEvent = {
      listChanged,
      ...(turnPartsAdded ? { turnPartsAdded } : {}),
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
    this.evictedSessions.delete(id);
    this.sessions.delete(id);
    this.sessions.set(id, entry);
  }

  private touchSessionEntry(id: string, entry: SessionEntry): void {
    entry.lastAccess = this.now();
    this.setSessionEntry(id, entry);
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


  private hasExpired(entry: SessionEntry): boolean {
    return this.now() - entry.lastAccess > this.ttlMs;
  }

  private getActiveSessionEntry(id: string): SessionEntry | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    if (!this.hasExpired(entry)) return entry;

    this.removeSession(id, true);
    setTimeout(() => {
      this.notifyChange(true);
    }, 0).unref();
    return undefined;
  }

}

export function createSessionAccess(store: SessionStore): SessionAccess {
  return {
    appendEvent: store.appendSessionEvent.bind(store),
    appendTranscript: store.appendSessionTranscript.bind(store),
    completeSessionIds: store.completeSessionIds.bind(store),
    getSessionEntry: store.getSessionEntry.bind(store),
    isEvicted: store.isEvicted.bind(store),
    listTranscriptEntries: store.listSessionTranscriptEntries.bind(store),
  };
}

export function createSessionStore(options?: SessionStoreOptions): SessionStore {
  return new SessionStore(options);
}

