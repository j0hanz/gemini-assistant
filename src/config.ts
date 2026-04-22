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

function parseCorsOriginEnv(): string {
  const raw = process.env.CORS_ORIGIN;
  if (raw === undefined) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === '*' || /^https?:\/\/[^\s,]+$/.test(trimmed)) {
    return trimmed;
  }
  throw new Error('CORS_ORIGIN must be "*" or a single http(s) origin when set.');
}

function parseTransportModeEnv(): TransportMode {
  const raw = process.env.TRANSPORT ?? DEFAULT_TRANSPORT;
  if (raw === 'stdio' || raw === 'http' || raw === 'web-standard') {
    return raw;
  }
  throw new Error('TRANSPORT must be one of: stdio, http, web-standard.');
}

export function getApiKey(): string {
  const raw = process.env.API_KEY;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('API_KEY environment variable is required.');
  }
  return raw;
}

export function getGeminiModel(): string {
  return parseNonEmptyStringEnv('MODEL', DEFAULT_MODEL);
}

export function getExposeThoughts(): boolean {
  return parseBooleanEnv('THOUGHTS', false);
}

export function getVerbosePayloadLogging(): boolean {
  return parseBooleanEnv('LOG_PAYLOADS', false);
}

export function getTransportMode(): TransportMode {
  return parseTransportModeEnv();
}

export function getTransportConfig(): TransportConfig {
  const host = parseNonEmptyStringEnv('HOST', DEFAULT_HTTP_HOST);

  return {
    corsOrigin: parseCorsOriginEnv(),
    host,
    isStateless: parseBooleanEnv('STATELESS', false),
    maxSessions: parseIntEnv('MAX_TRANSPORT_SESSIONS', DEFAULT_MAX_TRANSPORT_SESSIONS, {
      min: 1,
      max: 10_000,
    }),
    port: parseIntEnv('PORT', DEFAULT_HTTP_PORT, { min: 1, max: 65_535 }),
    sessionTtlMs: parseIntEnv('TRANSPORT_SESSION_TTL_MS', DEFAULT_TRANSPORT_SESSION_TTL_MS, {
      min: 1_000,
    }),
  };
}

export function getAllowedHostsEnv(): string | undefined {
  const trimmed = process.env.ALLOWED_HOSTS?.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function getRootsEnv(): string | undefined {
  return process.env.ROOTS;
}

export function getSessionLimits(): {
  maxEventEntries: number;
  maxSessions: number;
  maxTranscriptEntries: number;
  ttlMs: number;
} {
  return {
    maxEventEntries: DEFAULT_MAX_EVENT_ENTRIES,
    maxSessions: DEFAULT_MAX_SESSIONS,
    maxTranscriptEntries: DEFAULT_MAX_TRANSCRIPT_ENTRIES,
    ttlMs: DEFAULT_SESSION_TTL_MS,
  };
}

// ── Workspace Cache ───────────────────────────────────────────────────

const DEFAULT_WORKSPACE_CACHE_TTL = '3600s';

export function getWorkspaceCacheEnabled(): boolean {
  return parseBooleanEnv('CACHE', false);
}

export function getWorkspaceContextFile(): string | undefined {
  return process.env.CONTEXT;
}

export function getWorkspaceCacheTtl(): string {
  return process.env.CACHE_TTL ?? DEFAULT_WORKSPACE_CACHE_TTL;
}

export function getWorkspaceAutoScan(): boolean {
  return parseBooleanEnv('AUTO_SCAN', true);
}
