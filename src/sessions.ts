import type { Chat } from '@google/genai';

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const SESSION_TTL_MS = parseIntEnv('SESSION_TTL_MS', 30 * 60 * 1000);
const MAX_SESSIONS = parseIntEnv('MAX_SESSIONS', 50);

const MAX_EVICTED_ENTRIES = 1000;

interface SessionEntry {
  chat: Chat;
  lastAccess: number;
}

const sessions = new Map<string, SessionEntry>();
const evictedSessions = new Set<string>();

let evictionTimer: ReturnType<typeof setInterval> | undefined;
let changeCallback: (() => void) | undefined;

export function onSessionChange(cb: () => void): void {
  changeCallback = cb;
}

function notifyChange(): void {
  changeCallback?.();
}

function trimEvictedSessions(): void {
  if (evictedSessions.size <= MAX_EVICTED_ENTRIES) return;
  const excess = evictedSessions.size - Math.floor(MAX_EVICTED_ENTRIES / 2);
  let removed = 0;
  for (const id of evictedSessions) {
    if (removed >= excess) break;
    evictedSessions.delete(id);
    removed++;
  }
}

function startEvictionTimer(): void {
  if (evictionTimer) return;
  evictionTimer = setInterval(() => {
    const now = Date.now();
    let evicted = false;
    for (const [id, entry] of sessions) {
      if (now - entry.lastAccess > SESSION_TTL_MS) {
        sessions.delete(id);
        evictedSessions.add(id);
        evicted = true;
      }
    }
    trimEvictedSessions();
    if (evicted) notifyChange();
  }, 60_000);
  evictionTimer.unref();
}

function evictOldest(): void {
  let oldestId: string | undefined;
  let oldestTime = Infinity;
  for (const [id, entry] of sessions) {
    if (entry.lastAccess < oldestTime) {
      oldestTime = entry.lastAccess;
      oldestId = id;
    }
  }
  if (oldestId) {
    sessions.delete(oldestId);
    evictedSessions.add(oldestId);
    notifyChange();
  }
}

export function listSessionEntries(): { id: string; lastAccess: number }[] {
  return Array.from(sessions, ([id, entry]) => ({ id, lastAccess: entry.lastAccess }));
}

export function getSessionEntry(id: string): { id: string; lastAccess: number } | undefined {
  const entry = sessions.get(id);
  if (!entry) return undefined;
  return { id, lastAccess: entry.lastAccess };
}

export function isEvicted(id: string): boolean {
  return evictedSessions.has(id);
}

export function getSession(id: string): Chat | undefined {
  const entry = sessions.get(id);
  if (!entry) return undefined;
  entry.lastAccess = Date.now();
  return entry.chat;
}

export function setSession(id: string, chat: Chat): void {
  if (sessions.size >= MAX_SESSIONS && !sessions.has(id)) {
    evictOldest();
  }
  sessions.set(id, { chat, lastAccess: Date.now() });
  startEvictionTimer();
  notifyChange();
}
