import type {
  BlockedReason,
  Chat,
  FinishReason,
  GenerateContentConfig,
  GroundingMetadata,
  Part,
  ToolConfig,
  ToolListUnion,
  UrlContextMetadata,
} from '@google/genai';

import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import type { FunctionCallEntry, StreamAnomalies, ToolEvent } from './lib/streaming.js';
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

export interface ContentEntry {
  role: 'user' | 'model';
  parts: Part[];
  timestamp: number;
  taskId?: string;
  finishReason?: FinishReason;
  finishMessage?: string;
  promptBlockReason?: BlockedReason;
}

export interface SessionGenerationContract {
  model: string;
  systemInstruction?: GenerateContentConfig['systemInstruction'];
  tools?: ToolListUnion;
  toolConfig?: ToolConfig;
  functionCallingMode?: unknown;
  thinkingConfig?: GenerateContentConfig['thinkingConfig'];
  responseMimeType?: GenerateContentConfig['responseMimeType'];
  responseJsonSchema?: unknown;
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
  chat: Chat;
  cacheName?: string;
  contract?: SessionGenerationContract;
  contents: ContentEntry[];
  events: SessionEventEntry[];
  lastAccess: number;
  rebuiltAt?: number;
  transcript: TranscriptEntry[];
}

export interface SessionSummary {
  id: string;
  cacheName?: string;
  contract?: SessionGenerationContract;
  lastAccess: number;
  transcriptCount: number;
  eventCount: number;
  rebuiltAt?: number;
}

export interface SessionChangeEvent {
  listChanged: boolean;
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
      ...(item.response.citationMetadata !== undefined
        ? { citationMetadata: cloneValue(item.response.citationMetadata) }
        : {}),
      ...(item.response.safetyRatings !== undefined
        ? { safetyRatings: cloneValue(item.response.safetyRatings) }
        : {}),
      ...(item.response.finishMessage !== undefined
        ? { finishMessage: item.response.finishMessage }
        : {}),
      ...(item.response.schemaWarnings
        ? { schemaWarnings: [...item.response.schemaWarnings] }
        : {}),
      ...(item.response.thoughts ? { thoughts: item.response.thoughts } : {}),
      ...(item.response.toolEvents
        ? { toolEvents: item.response.toolEvents.map((toolEvent) => ({ ...toolEvent })) }
        : {}),
      ...(item.response.usage ? { usage: { ...item.response.usage } } : {}),
      ...(item.response.groundingMetadata !== undefined
        ? { groundingMetadata: cloneValue(item.response.groundingMetadata) }
        : {}),
      ...(item.response.urlContextMetadata !== undefined
        ? { urlContextMetadata: cloneValue(item.response.urlContextMetadata) }
        : {}),
      ...(item.response.promptFeedback !== undefined
        ? { promptFeedback: cloneValue(item.response.promptFeedback) }
        : {}),
      ...(item.response.anomalies !== undefined
        ? { anomalies: { ...item.response.anomalies } }
        : {}),
    },
  };
}

function cloneContentEntry(item: ContentEntry): ContentEntry {
  return {
    ...item,
    parts: cloneValue(item.parts),
    ...(item.finishReason !== undefined ? { finishReason: item.finishReason } : {}),
    ...(item.finishMessage !== undefined ? { finishMessage: item.finishMessage } : {}),
    ...(item.promptBlockReason !== undefined ? { promptBlockReason: item.promptBlockReason } : {}),
  };
}

export function sanitizeHistoryParts(parts: Part[]): Part[] {
  const inlineDataMaxBytes = getSessionLimits().replayInlineDataMaxBytes;
  return parts.filter((part) => {
    if (part.thought === true) return false;
    if (part.functionCall && !part.functionCall.name) return false;
    if (part.inlineData?.data && part.inlineData.data.length > inlineDataMaxBytes) {
      // Replay history must not retain large raw media blobs; callers should
      // use fileData for durable replayable media references instead.
      logger.child('sessions').debug('Dropping oversized inlineData part from replay history', {
        inlineDataBytes: part.inlineData.data.length,
        inlineDataMaxBytes,
      });
      return false;
    }
    return true;
  });
}

function toSessionSummary(id: string, entry: SessionEntry): SessionSummary {
  return {
    id,
    ...(entry.cacheName ? { cacheName: entry.cacheName } : {}),
    ...(entry.contract ? { contract: cloneValue(entry.contract) } : {}),
    lastAccess: entry.lastAccess,
    transcriptCount: entry.transcript.length,
    eventCount: entry.events.length,
    ...(entry.rebuiltAt !== undefined ? { rebuiltAt: entry.rebuiltAt } : {}),
  };
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
    // Read-path eviction: filter out expired sessions so consumers never see
    // entries that subsequent session reads would report as missing. Eviction
    // is performed silently (no notifyChange) — the periodic sweep remains the
    // canonical broadcaster to avoid notification storms on every list call.
    const active: SessionSummary[] = [];
    for (const [id, entry] of this.sessions) {
      if (this.hasExpired(entry)) {
        this.removeSession(id, true);
        continue;
      }
      active.push(toSessionSummary(id, entry));
    }
    return active;
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

  listSessionContentEntries(id: string): ContentEntry[] | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return entry.contents.map((item) => cloneContentEntry(item));
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

  appendSessionContent(id: string, item: ContentEntry): boolean {
    return this.appendSessionHistoryEntry(
      id,
      item,
      (entry) => entry.contents,
      cloneContentEntry,
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

  getSession(id: string): Chat | undefined {
    const entry = this.getActiveSessionEntry(id);
    if (!entry) return undefined;
    return this.updateSessionAccess(id, entry);
  }

  setSession(
    id: string,
    chat: Chat,
    rebuiltAt?: number,
    cacheName?: string,
    contract?: SessionGenerationContract,
  ): void {
    if (this.sessions.has(id)) {
      throw new AppError('sessions', `Session already exists: ${id}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldest();
    }
    this.createSession(id, chat, rebuiltAt, cacheName, contract);
    this.startEvictionTimer();
    this.notifyChange(true);
  }

  replaceSession(id: string, chat: Chat): void {
    const entry = this.sessions.get(id);
    if (!entry) {
      this.setSession(id, chat);
      return;
    }

    entry.chat = chat;
    this.setSessionEntry(id, entry);
    this.startEvictionTimer();
    // Replacement preserves collection membership (same id).
    // Do NOT fire `notifications/resources/list_changed`.
    this.notifyChange(false);
  }

  private notifyChange(listChanged = true): void {
    if (this.subscribers.size === 0) return;

    const event: SessionChangeEvent = { listChanged };

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

  private touchSessionEntry(id: string, entry: SessionEntry): void {
    entry.lastAccess = this.now();
    this.setSessionEntry(id, entry);
  }

  private updateSessionAccess(id: string, entry: SessionEntry): Chat {
    this.touchSessionEntry(id, entry);
    return entry.chat;
  }

  private createSession(
    id: string,
    chat: Chat,
    rebuiltAt?: number,
    cacheName?: string,
    contract?: SessionGenerationContract,
  ): void {
    this.storeSession(id, chat, rebuiltAt, cacheName, contract);
  }

  private storeSession(
    id: string,
    chat: Chat,
    rebuiltAt?: number,
    cacheName?: string,
    contract?: SessionGenerationContract,
  ): void {
    this.evictedSessions.delete(id);
    this.setSessionEntry(id, {
      chat,
      ...(cacheName ? { cacheName } : {}),
      ...(contract ? { contract: cloneValue(contract) } : {}),
      contents: [],
      events: [],
      lastAccess: this.now(),
      ...(rebuiltAt !== undefined ? { rebuiltAt } : {}),
      transcript: [],
    });
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

    // Read-path eviction: remove silently. The periodic sweep is responsible
    // for broadcasting eviction notifications so we do not amplify per-read
    // TTL expirations into notification storms across connected clients.
    this.removeSession(id, true);
    return undefined;
  }

  private startEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      const evictedIds = this.evictExpiredSessions();
      if (evictedIds.length > 0) this.notifyChange(true);
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
