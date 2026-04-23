import type { SafetySetting } from '@google/genai';

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
const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 50;
const DEFAULT_MAX_EVENT_ENTRIES = 50;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_SESSION_REPLAY_MAX_BYTES = 50_000;
const DEFAULT_SESSION_REPLAY_INLINE_DATA_MAX_BYTES = 16 * 1024;

const DEFAULT_SESSION_REDACTION_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /^token$/i,
  /password/i,
  /secret/i,
  /credential/i,
  /cookie/i,
  /session[_-]?id/i,
];

let cachedSafetySettings: SafetySetting[] | undefined;
let cachedSafetySettingsSource: string | undefined;
let cachedSessionRedactionPatterns: RegExp[] | undefined;
let cachedSessionRedactionPatternsSource: string | undefined;

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
  replayInlineDataMaxBytes: number;
  replayMaxBytes: number;
  ttlMs: number;
} {
  return {
    maxEventEntries: DEFAULT_MAX_EVENT_ENTRIES,
    maxSessions: DEFAULT_MAX_SESSIONS,
    maxTranscriptEntries: DEFAULT_MAX_TRANSCRIPT_ENTRIES,
    replayInlineDataMaxBytes: parseIntEnv(
      'SESSION_REPLAY_INLINE_DATA_MAX_BYTES',
      DEFAULT_SESSION_REPLAY_INLINE_DATA_MAX_BYTES,
      { min: 0 },
    ),
    replayMaxBytes: parseIntEnv('SESSION_REPLAY_MAX_BYTES', DEFAULT_SESSION_REPLAY_MAX_BYTES, {
      min: 1,
    }),
    ttlMs: DEFAULT_SESSION_TTL_MS,
  };
}

// ── Workspace Cache ───────────────────────────────────────────────────

const DEFAULT_WORKSPACE_CACHE_TTL = '3600s';

export function getWorkspaceCacheEnabled(): boolean {
  return parseBooleanEnv('CACHE', true);
}

export function getWorkspaceContextFile(): string | undefined {
  return process.env.CONTEXT;
}

export function getWorkspaceCacheTtl(): string {
  return process.env.CACHE_TTL ?? DEFAULT_WORKSPACE_CACHE_TTL;
}

export function getWorkspaceAutoScan(): boolean {
  return parseBooleanEnv('AUTO_SCAN', false);
}

export function getMaxOutputTokens(): number {
  return parseIntEnv('GEMINI_MAX_OUTPUT_TOKENS', DEFAULT_MAX_OUTPUT_TOKENS, {
    min: 1,
    max: 1_048_576,
  });
}

export function getThinkingBudgetCap(): number {
  return parseIntEnv('GEMINI_THINKING_BUDGET_CAP', 32_768, {
    min: 0,
    max: 1_048_576,
  });
}

export function getSlimSessionEvents(): boolean {
  return !parseBooleanEnv('SESSION_EVENTS_VERBOSE', false);
}

function parseRegexPattern(raw: string): RegExp {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('GEMINI_SESSION_REDACT_KEYS entries must be non-empty regex patterns.');
  }

  const literalMatch = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
  if (literalMatch?.[1] !== undefined) {
    return new RegExp(literalMatch[1], literalMatch[2] ?? undefined);
  }

  return new RegExp(trimmed);
}

export function getSafetySettings(): SafetySetting[] | undefined {
  const raw = process.env.GEMINI_SAFETY_SETTINGS;
  if (cachedSafetySettingsSource === raw) {
    return cachedSafetySettings;
  }

  if (raw === undefined || raw.trim() === '') {
    cachedSafetySettingsSource = raw;
    cachedSafetySettings = undefined;
    return cachedSafetySettings;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('GEMINI_SAFETY_SETTINGS must be a JSON array when set.');
  }

  cachedSafetySettings = parsed as SafetySetting[];
  cachedSafetySettingsSource = raw;
  return cachedSafetySettings;
}

export function getSessionRedactionPatterns(): RegExp[] {
  const raw = process.env.GEMINI_SESSION_REDACT_KEYS;
  if (cachedSessionRedactionPatternsSource === raw) {
    return cachedSessionRedactionPatterns ?? DEFAULT_SESSION_REDACTION_PATTERNS;
  }

  const patterns =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_SESSION_REDACTION_PATTERNS
      : [
          ...DEFAULT_SESSION_REDACTION_PATTERNS,
          ...raw
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map(parseRegexPattern),
        ];

  cachedSessionRedactionPatterns = patterns;
  cachedSessionRedactionPatternsSource = raw;
  return cachedSessionRedactionPatterns;
}
