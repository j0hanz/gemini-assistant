interface TransportConfig {
  corsOrigin: string;
  host: string;
  isStateless: boolean;
  maxSessions: number;
  port: number;
  sessionTtlMs: number;
}

export type TransportMode = 'stdio' | 'http' | 'web-standard';

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_TRANSPORT: TransportMode = 'stdio';
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_TRANSPORT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TRANSPORT_SESSIONS = 100;
const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 200;
const DEFAULT_MAX_EVENT_ENTRIES = 200;
const MAX_SESSION_COUNT = 10_000;
const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false" when set.`);
}

function parseIntEnv(
  name: string,
  fallback: number,
  opts: { max?: number; min?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer when set.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer when set.`);
  }
  if (opts.min !== undefined && parsed < opts.min) {
    throw new Error(`${name} must be >= ${String(opts.min)}.`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new Error(`${name} must be <= ${String(opts.max)}.`);
  }

  return parsed;
}

function parseNonEmptyStringEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${name} must be a non-empty string when set.`);
  }
  return trimmed;
}

function parseTransportModeEnv(): TransportMode {
  const raw = process.env.MCP_TRANSPORT ?? DEFAULT_TRANSPORT;
  if (raw === 'stdio' || raw === 'http' || raw === 'web-standard') {
    return raw;
  }
  throw new Error('MCP_TRANSPORT must be one of: stdio, http, web-standard.');
}

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}

export function getExposeThoughts(): boolean {
  return process.env.GEMINI_EXPOSE_THOUGHTS === 'true';
}

export function getTransportMode(): TransportMode {
  return parseTransportModeEnv();
}

export function getTransportConfig(): TransportConfig {
  return {
    corsOrigin: process.env.MCP_CORS_ORIGIN ?? '',
    host: parseNonEmptyStringEnv('MCP_HTTP_HOST', DEFAULT_HTTP_HOST),
    isStateless: parseBooleanEnv('MCP_STATELESS', false),
    maxSessions: parseIntEnv('MCP_MAX_TRANSPORT_SESSIONS', DEFAULT_MAX_TRANSPORT_SESSIONS, {
      min: 1,
      max: MAX_SESSION_COUNT,
    }),
    port: parseIntEnv('MCP_HTTP_PORT', DEFAULT_HTTP_PORT, { min: 1, max: 65_535 }),
    sessionTtlMs: parseIntEnv('MCP_TRANSPORT_SESSION_TTL_MS', DEFAULT_TRANSPORT_SESSION_TTL_MS, {
      min: 1,
      max: MAX_SESSION_TTL_MS,
    }),
  };
}

export function getAllowedHostsEnv(): string | undefined {
  return process.env.MCP_ALLOWED_HOSTS;
}

export function getAllowedFileRootsEnv(): string | undefined {
  return process.env.ALLOWED_FILE_ROOTS;
}

export function getSessionLimits(): {
  maxEventEntries: number;
  maxSessions: number;
  maxTranscriptEntries: number;
  ttlMs: number;
} {
  return {
    maxEventEntries: parseIntEnv('MAX_SESSION_EVENT_ENTRIES', DEFAULT_MAX_EVENT_ENTRIES, {
      min: 1,
      max: 10_000,
    }),
    maxSessions: parseIntEnv('MAX_SESSIONS', DEFAULT_MAX_SESSIONS, {
      min: 1,
      max: MAX_SESSION_COUNT,
    }),
    maxTranscriptEntries: parseIntEnv(
      'MAX_SESSION_TRANSCRIPT_ENTRIES',
      DEFAULT_MAX_TRANSCRIPT_ENTRIES,
      { min: 1, max: 10_000 },
    ),
    ttlMs: parseIntEnv('SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS, {
      min: 1,
      max: MAX_SESSION_TTL_MS,
    }),
  };
}

// ── Workspace Cache ───────────────────────────────────────────────────

const DEFAULT_WORKSPACE_CACHE_TTL = '3600s';

export function getWorkspaceCacheEnabled(): boolean {
  return process.env.WORKSPACE_CACHE_ENABLED === 'true';
}

export function getWorkspaceContextFile(): string | undefined {
  return process.env.WORKSPACE_CONTEXT_FILE;
}

export function getWorkspaceCacheTtl(): string {
  return process.env.WORKSPACE_CACHE_TTL ?? DEFAULT_WORKSPACE_CACHE_TTL;
}

export function getWorkspaceAutoScan(): boolean {
  return process.env.WORKSPACE_AUTO_SCAN !== 'false';
}
