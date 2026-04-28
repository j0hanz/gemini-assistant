import {
  HarmBlockMethod,
  HarmBlockThreshold,
  HarmCategory,
  type SafetySetting,
} from '@google/genai';

interface TransportConfig {
  allowUnauthenticatedLoopbackHttp: boolean;
  corsOrigin: string;
  host: string;
  isStateless: boolean;
  maxSessions: number;
  port: number;
  token?: string;
  trustProxy: boolean;
  rateLimitBurst: number;
  rateLimitRps: number;
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
const DEFAULT_HTTP_RATE_LIMIT_RPS = 10;
const DEFAULT_HTTP_RATE_LIMIT_BURST = 20;
const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 50;
const DEFAULT_MAX_EVENT_ENTRIES = 50;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
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
const MAX_REDACTION_REGEX_LENGTH = 256;
const ALLOWED_REDACTION_REGEX_FLAGS = new Set(['i', 'u']);

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

function parseOptionalTokenEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length < 32) {
    throw new Error(`${name} must be at least 32 characters when set.`);
  }
  if (isTriviallyRepeatedToken(trimmed)) {
    throw new Error(`${name} must not be a trivially repeated pattern.`);
  }
  return trimmed;
}

function isTriviallyRepeatedToken(value: string): boolean {
  if (/^(.)\1+$/.test(value)) {
    return true;
  }

  for (let size = 2; size <= 8; size += 1) {
    if (value.length % size !== 0) {
      continue;
    }

    const segment = value.slice(0, size);
    if (segment.repeat(value.length / size) === value) {
      return true;
    }
  }

  return false;
}

function parseCorsOriginEnv(): string {
  const raw = process.env.CORS_ORIGIN;
  if (raw === undefined) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === '*') {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      'CORS_ORIGIN must be "*" or a single http(s) origin without path, query, or credentials when set.',
    );
  }

  if (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.origin === trimmed &&
    parsed.username === '' &&
    parsed.password === ''
  ) {
    return trimmed;
  }

  throw new Error(
    'CORS_ORIGIN must be "*" or a single http(s) origin without path, query, or credentials when set.',
  );
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

  const trimmed = raw.trim();
  if (!trimmed || containsNonPrintableAscii(trimmed)) {
    throw new Error('API_KEY must contain printable non-whitespace characters only.');
  }

  return trimmed;
}

function containsNonPrintableAscii(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

export function getGeminiModel(): string {
  return parseNonEmptyStringEnv('MODEL', DEFAULT_MODEL);
}

export function getExposeThoughts(): boolean {
  return parseBooleanEnv('THOUGHTS', false);
}

export function getExposeSessionResources(): boolean {
  return parseBooleanEnv('MCP_EXPOSE_SESSION_RESOURCES', false);
}

export function getVerbosePayloadLogging(): boolean {
  return parseBooleanEnv('LOG_PAYLOADS', false);
}

export function getLogDir(): string | undefined {
  const raw = process.env.LOG_DIR;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function getLogToStderr(): boolean {
  return parseBooleanEnv('LOG_TO_STDERR', false);
}

export function getTransportMode(): TransportMode {
  return parseTransportModeEnv();
}

export function getStatelessTransportFlag(): boolean {
  const mode = parseTransportModeEnv();
  if (mode !== 'http' && mode !== 'web-standard') return false;
  return parseBooleanEnv('STATELESS', false);
}

export function getTransportConfig(): TransportConfig {
  const host = parseNonEmptyStringEnv('HOST', DEFAULT_HTTP_HOST);
  const token = parseOptionalTokenEnv('MCP_HTTP_TOKEN');
  const corsOrigin = parseCorsOriginEnv();

  if (corsOrigin === '*' && token !== undefined) {
    throw new Error(
      'CORS_ORIGIN cannot be "*" when MCP_HTTP_TOKEN is set. Refuse wildcard CORS with bearer auth.',
    );
  }

  return {
    allowUnauthenticatedLoopbackHttp: parseBooleanEnv(
      'MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP',
      false,
    ),
    corsOrigin,
    host,
    isStateless: parseBooleanEnv('STATELESS', false),
    maxSessions: parseIntEnv('MAX_TRANSPORT_SESSIONS', DEFAULT_MAX_TRANSPORT_SESSIONS, {
      min: 1,
      max: 10_000,
    }),
    port: parseIntEnv('PORT', DEFAULT_HTTP_PORT, { min: 1, max: 65_535 }),
    ...(token ? { token } : {}),
    rateLimitBurst: parseIntEnv('MCP_HTTP_RATE_LIMIT_BURST', DEFAULT_HTTP_RATE_LIMIT_BURST, {
      min: 1,
    }),
    rateLimitRps: parseIntEnv('MCP_HTTP_RATE_LIMIT_RPS', DEFAULT_HTTP_RATE_LIMIT_RPS, { min: 1 }),
    sessionTtlMs: parseIntEnv('TRANSPORT_SESSION_TTL_MS', DEFAULT_TRANSPORT_SESSION_TTL_MS, {
      min: 1_000,
    }),
    trustProxy: parseBooleanEnv('MCP_TRUST_PROXY', false),
  };
}

export function getAllowedHostsEnv(): string | undefined {
  const trimmed = process.env.ALLOWED_HOSTS?.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function getRootsEnv(): string | undefined {
  return process.env.ROOTS;
}

export function getRootsFallbackCwd(): boolean {
  return parseBooleanEnv('ROOTS_FALLBACK_CWD', false);
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
const CACHE_TTL_PATTERN = /^(\d+)s$/;

export function getWorkspaceCacheEnabled(): boolean {
  return parseBooleanEnv('CACHE', true);
}

export function getWorkspaceContextFile(): string | undefined {
  return process.env.CONTEXT;
}

export function getWorkspaceCacheTtl(): string {
  const raw = process.env.CACHE_TTL;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WORKSPACE_CACHE_TTL;
  }

  const trimmed = raw.trim();
  const match = CACHE_TTL_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      'CACHE_TTL must be a positive integer followed by "s" (e.g. "3600s") when set.',
    );
  }

  const seconds = Number.parseInt(match[1] ?? '0', 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('CACHE_TTL must specify a positive number of seconds when set.');
  }

  return trimmed;
}

export function getWorkspaceAutoScan(): boolean {
  return parseBooleanEnv('AUTO_SCAN', true);
}

export function getReviewDocs(): string[] | undefined {
  const raw = process.env.REVIEW_DOCS;
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getMaxOutputTokens(): number {
  return parseIntEnv('GEMINI_MAX_OUTPUT_TOKENS', DEFAULT_MAX_OUTPUT_TOKENS, {
    min: 1,
    max: 1_048_576,
  });
}

export function getThinkingBudgetCap(): number {
  return parseIntEnv('GEMINI_THINKING_BUDGET_CAP', 16_384, {
    min: 0,
    max: 1_048_576,
  });
}

export function getSlimSessionEvents(): boolean {
  return !parseBooleanEnv('SESSION_EVENTS_VERBOSE', false);
}

/**
 * Parses admin-controlled environment regex patterns. These values are not
 * user input and are trusted as deployment configuration.
 */
function parseRegexPattern(raw: string): RegExp {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('GEMINI_SESSION_REDACT_KEYS entries must be non-empty regex patterns.');
  }
  if (trimmed.length > MAX_REDACTION_REGEX_LENGTH) {
    throw new Error(
      `GEMINI_SESSION_REDACT_KEYS entries must be <= ${String(MAX_REDACTION_REGEX_LENGTH)} characters.`,
    );
  }

  const literalMatch = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
  if (literalMatch?.[1] !== undefined) {
    const flags = literalMatch[2] ?? '';
    if (Array.from(flags).some((flag) => !ALLOWED_REDACTION_REGEX_FLAGS.has(flag))) {
      throw new Error('GEMINI_SESSION_REDACT_KEYS only supports the i and u regex flags.');
    }
    if (containsNestedQuantifierShape(literalMatch[1])) {
      throw new Error(
        'GEMINI_SESSION_REDACT_KEYS contains an unsafe nested-quantifier regex pattern.',
      );
    }
    return new RegExp(literalMatch[1], flags);
  }

  if (containsNestedQuantifierShape(trimmed)) {
    throw new Error(
      'GEMINI_SESSION_REDACT_KEYS contains an unsafe nested-quantifier regex pattern.',
    );
  }

  return new RegExp(trimmed);
}

function containsNestedQuantifierShape(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*(?:\+|\*|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:\+|\*|\{\d+(?:,\d*)?\})/u.test(
    pattern,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnumValue<T extends Record<string, string>>(
  enumObject: T,
  value: unknown,
): value is T[keyof T] {
  return typeof value === 'string' && Object.values(enumObject).includes(value);
}

function parseSafetySetting(value: unknown, index: number): SafetySetting {
  if (!isRecord(value)) {
    throw new Error(`GEMINI_SAFETY_SETTINGS[${String(index)}] must be an object.`);
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => key !== 'category' && key !== 'method' && key !== 'threshold',
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `GEMINI_SAFETY_SETTINGS[${String(index)}] contains unknown keys: ${unknownKeys.join(', ')}.`,
    );
  }

  if (!isEnumValue(HarmCategory, value.category)) {
    throw new Error(
      `GEMINI_SAFETY_SETTINGS[${String(index)}].category must be a valid HarmCategory value.`,
    );
  }
  if (!isEnumValue(HarmBlockThreshold, value.threshold)) {
    throw new Error(
      `GEMINI_SAFETY_SETTINGS[${String(index)}].threshold must be a valid HarmBlockThreshold value.`,
    );
  }
  if (value.method !== undefined && !isEnumValue(HarmBlockMethod, value.method)) {
    throw new Error(
      `GEMINI_SAFETY_SETTINGS[${String(index)}].method must be a valid HarmBlockMethod value.`,
    );
  }

  return {
    category: value.category,
    ...(value.method !== undefined ? { method: value.method } : {}),
    threshold: value.threshold,
  };
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

  cachedSafetySettings = parsed.map(parseSafetySetting);
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
