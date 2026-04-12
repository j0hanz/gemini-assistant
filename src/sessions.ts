import type { Chat } from '@google/genai';

const parsedTtl =
  process.env.SESSION_TTL_MS !== undefined ? Number(process.env.SESSION_TTL_MS) : undefined;
const SESSION_TTL_MS =
  parsedTtl !== undefined && !Number.isNaN(parsedTtl) ? parsedTtl : 30 * 60 * 1000;

const parsedMax =
  process.env.MAX_SESSIONS !== undefined ? Number(process.env.MAX_SESSIONS) : undefined;
const MAX_SESSIONS = parsedMax !== undefined && !Number.isNaN(parsedMax) ? parsedMax : 50;

const MAX_EVICTED_ENTRIES = 1000;

interface SessionEntry {
  chat: Chat;
  lastAccess: number;
}

const sessions = new Map<string, SessionEntry>();
const evictedSessions = new Set<string>();

let evictionTimer: ReturnType<typeof setInterval> | undefined;

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
    for (const [id, entry] of sessions) {
      if (now - entry.lastAccess > SESSION_TTL_MS) {
        sessions.delete(id);
        evictedSessions.add(id);
      }
    }
    trimEvictedSessions();
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
  }
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
}
