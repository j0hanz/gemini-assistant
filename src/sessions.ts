import type { Chat } from '@google/genai';

import { parseIntEnv } from './client.js';

const SESSION_TTL_MS = parseIntEnv('SESSION_TTL_MS', 30 * 60 * 1000);
const MAX_SESSIONS = parseIntEnv('MAX_SESSIONS', 50);

const MAX_EVICTED_ENTRIES = 1000;
const EVICTED_TRIM_TARGET = Math.floor(MAX_EVICTED_ENTRIES / 2);
const EVICTION_SWEEP_INTERVAL_MS = 60_000;

interface SessionEntry {
  chat: Chat;
  lastAccess: number;
}

interface SessionSummary {
  id: string;
  lastAccess: number;
}

export interface SessionChangeEvent {
  detailUris: string[];
}

const sessions = new Map<string, SessionEntry>();
const evictedSessions = new Set<string>();

let evictionTimer: ReturnType<typeof setInterval> | undefined;
let changeCallback: ((event: SessionChangeEvent) => void) | undefined;

export function onSessionChange(cb: (event: SessionChangeEvent) => void): void {
  changeCallback = cb;
}

function sessionDetailUri(id: string): string {
  return `sessions://${id}`;
}

function notifyChange(sessionIds: string[] = []): void {
  changeCallback?.({
    detailUris: sessionIds.map((id) => sessionDetailUri(id)),
  });
}

function now(): number {
  return Date.now();
}

function toSessionSummary(id: string, entry: SessionEntry): SessionSummary {
  return { id, lastAccess: entry.lastAccess };
}

function recordEvictedSession(id: string): void {
  evictedSessions.add(id);
  trimEvictedSessions();
}

function removeSession(id: string, trackEviction = false): boolean {
  const deleted = sessions.delete(id);
  if (deleted && trackEviction) {
    recordEvictedSession(id);
  }
  return deleted;
}

function setSessionEntry(id: string, entry: SessionEntry): void {
  sessions.delete(id);
  sessions.set(id, entry);
}

function updateSessionAccess(id: string, entry: SessionEntry): Chat {
  entry.lastAccess = now();
  setSessionEntry(id, entry);
  return entry.chat;
}

function storeSession(id: string, chat: Chat): void {
  evictedSessions.delete(id);
  setSessionEntry(id, { chat, lastAccess: now() });
}

function trimEvictedSessions(): void {
  if (evictedSessions.size <= MAX_EVICTED_ENTRIES) return;
  const excess = evictedSessions.size - EVICTED_TRIM_TARGET;
  let removed = 0;
  for (const id of evictedSessions) {
    if (removed >= excess) break;
    evictedSessions.delete(id);
    removed++;
  }
}

function evictExpiredSessions(): string[] {
  const currentTime = now();
  const evictedIds: string[] = [];

  for (const [id, entry] of sessions) {
    if (currentTime - entry.lastAccess > SESSION_TTL_MS) {
      removeSession(id, true);
      evictedIds.push(id);
    }
  }

  return evictedIds;
}

function hasExpired(entry: SessionEntry): boolean {
  return now() - entry.lastAccess > SESSION_TTL_MS;
}

function startEvictionTimer(): void {
  if (evictionTimer) return;
  evictionTimer = setInterval(() => {
    const evictedIds = evictExpiredSessions();
    if (evictedIds.length > 0) notifyChange(evictedIds);
  }, EVICTION_SWEEP_INTERVAL_MS);
  evictionTimer.unref();
}

function oldestSessionId(): string | undefined {
  const oldest = sessions.keys().next();
  return oldest.done ? undefined : oldest.value;
}

function evictOldest(): string | undefined {
  const oldestId = oldestSessionId();
  if (oldestId) {
    removeSession(oldestId, true);
  }
  return oldestId;
}

export function listSessionEntries(): SessionSummary[] {
  return Array.from(sessions, ([id, entry]) => toSessionSummary(id, entry));
}

export function completeSessionIds(prefix?: string): string[] {
  return listSessionEntries()
    .map((session) => session.id)
    .filter((id) => id.startsWith(prefix ?? ''));
}

export function getSessionEntry(id: string): SessionSummary | undefined {
  const entry = sessions.get(id);
  if (!entry) return undefined;
  return toSessionSummary(id, entry);
}

export function isEvicted(id: string): boolean {
  return evictedSessions.has(id);
}

export function getSession(id: string, taskId?: string): Chat | undefined {
  const entry = sessions.get(id);
  if (!entry) return undefined;
  if (hasExpired(entry)) {
    removeSession(id, true);
    void taskId;
    notifyChange([id]);
    return undefined;
  }
  const chat = updateSessionAccess(id, entry);
  void taskId;
  notifyChange([id]);
  return chat;
}

export function setSession(id: string, chat: Chat, taskId?: string): void {
  let evictedId: string | undefined;
  if (sessions.size >= MAX_SESSIONS && !sessions.has(id)) {
    evictedId = evictOldest();
  }
  storeSession(id, chat);
  startEvictionTimer();
  void taskId;
  notifyChange(evictedId ? [evictedId, id] : [id]);
}
