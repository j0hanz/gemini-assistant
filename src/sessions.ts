import type {
  BlockedReason,
  Chat,
  Content,
  FinishReason,
  FunctionResponse,
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

import { getSessionLimits, getSessionRedactionPatterns, getSlimSessionEvents } from './config.js';

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
  /** Replay-safe parts for session rebuild. Filtered via {@link buildReplayHistoryParts}. */
  parts: Part[];
  /**
   * SDK-faithful Gemini `Part[]` for the `gemini://sessions/.../parts` resource.
   * Oversized `inlineData` payloads are elided, but `thought` parts and
   * `thoughtSignature` values are preserved verbatim.
   */
  rawParts?: Part[];
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

const SESSION_VALUE_MAX_STRING_LENGTH = 2000;
const SESSION_VALUE_MAX_ARRAY_ITEMS = 20;
const SESSION_VALUE_MAX_OBJECT_KEYS = 50;
const SESSION_VALUE_TRUNCATION_SUFFIX = '... [truncated]';

interface SessionFieldRule {
  key: string;
  shouldSanitize: (value: unknown) => boolean;
}

const FUNCTION_CALL_FIELD_RULES: readonly SessionFieldRule[] = [
  { key: 'args', shouldSanitize: (value) => Boolean(value) },
];

const TOOL_EVENT_FIELD_RULES: readonly SessionFieldRule[] = [
  { key: 'args', shouldSanitize: (value) => Boolean(value) },
  { key: 'code', shouldSanitize: (value) => value !== undefined },
  { key: 'output', shouldSanitize: (value) => value !== undefined },
  { key: 'response', shouldSanitize: (value) => Boolean(value) },
  { key: 'text', shouldSanitize: (value) => value !== undefined },
];

const SESSION_FREE_TEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
];

function shouldRedactSessionValue(keyContext?: string): boolean {
  if (!keyContext) return false;
  return getSessionRedactionPatterns().some((pattern) => pattern.test(keyContext));
}

export function sanitizeSessionValue(value: unknown, keyContext?: string): unknown {
  if (shouldRedactSessionValue(keyContext)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    if (value.length <= SESSION_VALUE_MAX_STRING_LENGTH) {
      return value;
    }

    const maxPrefixLength = Math.max(
      SESSION_VALUE_MAX_STRING_LENGTH - SESSION_VALUE_TRUNCATION_SUFFIX.length,
      0,
    );
    return `${value.slice(0, maxPrefixLength)}${SESSION_VALUE_TRUNCATION_SUFFIX}`;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, SESSION_VALUE_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeSessionValue(item, keyContext));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, SESSION_VALUE_MAX_OBJECT_KEYS)
        .map(([key, nestedValue]) => [key, sanitizeSessionValue(nestedValue, key)]),
    );
  }

  return value;
}

function applySessionFieldRules<T extends object>(item: T, rules: readonly SessionFieldRule[]): T {
  const source = item as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = { ...source };
  for (const rule of rules) {
    const value = source[rule.key];
    if (rule.shouldSanitize(value)) {
      out[rule.key] = sanitizeSessionValue(value, rule.key);
    }
  }
  return out as T;
}

export function sanitizeFunctionCalls(functionCalls: FunctionCallEntry[]): FunctionCallEntry[] {
  return functionCalls.map((functionCall) =>
    applySessionFieldRules(functionCall, FUNCTION_CALL_FIELD_RULES),
  );
}

export function sanitizeToolEvents(toolEvents: ToolEvent[]): ToolEvent[] {
  return toolEvents.map((toolEvent) => applySessionFieldRules(toolEvent, TOOL_EVENT_FIELD_RULES));
}

function sanitizeSessionText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  return SESSION_FREE_TEXT_SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[REDACTED]'),
    text,
  );
}

export function buildRebuiltChatContents(contents: ContentEntry[], maxBytes: number): Content[] {
  return selectReplayWindow(contents, maxBytes)
    .kept.map((entry) => ({
      role: entry.role,
      parts: buildReplayHistoryParts(structuredClone(entry.parts)),
    }))
    .filter((content) => content.parts.length > 0);
}

export function appendToolResponseTurn(
  sessionId: string,
  responses: FunctionResponse[],
  deps: {
    appendSessionContent: (sessionId: string, item: ContentEntry) => boolean;
    now: () => number;
  },
  taskId?: string,
): boolean {
  if (responses.length === 0) return true;
  return deps.appendSessionContent(sessionId, {
    role: 'user',
    parts: responses.map((functionResponse) => ({ functionResponse })),
    timestamp: deps.now(),
    ...(taskId ? { taskId } : {}),
  });
}

export function getPendingFunctionCalls(entry: {
  contents: readonly ContentEntry[];
}): FunctionCallEntry[] {
  for (let index = entry.contents.length - 1; index >= 0; index -= 1) {
    const content = entry.contents[index];
    if (content?.role !== 'model') {
      continue;
    }

    const seenIds = new Set<string>();
    const functionCalls = content.parts.flatMap((part) => {
      const functionCall = part.functionCall;
      if (!functionCall) {
        return [];
      }

      const id = typeof functionCall.id === 'string' ? functionCall.id : undefined;
      if (id && seenIds.has(id)) {
        return [];
      }
      if (id) {
        seenIds.add(id);
      }

      return [
        {
          ...(id ? { id } : {}),
          ...(typeof functionCall.name === 'string' ? { name: functionCall.name } : {}),
          ...(functionCall.args && typeof functionCall.args === 'object'
            ? { args: functionCall.args }
            : {}),
          ...(typeof part.thoughtSignature === 'string'
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        } satisfies FunctionCallEntry,
      ];
    });

    if (functionCalls.length > 0) {
      return functionCalls;
    }
  }

  return [];
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

function cloneContentEntry(item: ContentEntry): ContentEntry {
  return {
    ...item,
    parts: cloneValue(item.parts),
    ...(item.rawParts !== undefined ? { rawParts: cloneValue(item.rawParts) } : {}),
    ...(item.finishReason !== undefined ? { finishReason: item.finishReason } : {}),
    ...(item.finishMessage !== undefined ? { finishMessage: item.finishMessage } : {}),
    ...(item.promptBlockReason !== undefined ? { promptBlockReason: item.promptBlockReason } : {}),
  };
}

/**
 * Produce SDK-faithful Gemini parts for persistence under {@link ContentEntry.rawParts}.
 * Only oversized `inlineData` payloads are dropped (to cap memory); `thought`
 * parts, nameless `functionCall`s, and `thoughtSignature` values are preserved
 * so replay-safe orchestration retains Gemini-native structure.
 */
export function capRawParts(parts: Part[]): Part[] {
  const inlineDataMaxBytes = getSessionLimits().replayInlineDataMaxBytes;
  return parts.filter((part) => {
    if (part.inlineData?.data && part.inlineData.data.length > inlineDataMaxBytes) {
      logger.child('sessions').debug('Dropping oversized inlineData part from raw parts', {
        inlineDataBytes: part.inlineData.data.length,
        inlineDataMaxBytes,
      });
      return false;
    }
    return true;
  });
}

export function buildReplayHistoryParts(parts: Part[]): Part[] {
  const inlineDataMaxBytes = getSessionLimits().replayInlineDataMaxBytes;
  return parts.filter((part) => {
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

export function buildTranscriptParts(parts: Part[]): Part[] {
  return parts.filter((part) => {
    if (part.thought === true) return false;
    return Boolean(part.text) || Boolean(part.inlineData) || Boolean(part.fileData);
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

export interface ReplayWindowSelection {
  dropped: number;
  kept: ContentEntry[];
}

function entryBytes(entry: ContentEntry): number {
  return JSON.stringify(entry.parts).length;
}

export function selectReplayWindow(
  contents: readonly ContentEntry[],
  maxBytes: number,
): ReplayWindowSelection {
  if (contents.length === 0) {
    return { kept: [], dropped: 0 };
  }

  const kept: ContentEntry[] = [];
  let totalBytes = 0;

  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const entry = contents[index];
    if (!entry) continue;

    const nextBytes = totalBytes + entryBytes(entry);
    if (nextBytes > maxBytes) {
      break;
    }

    kept.unshift(entry);
    totalBytes = nextBytes;
  }

  return {
    kept,
    dropped: contents.length - kept.length,
  };
}
