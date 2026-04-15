interface TransportConfig {
  port: number;
  host: string;
  corsOrigin: string;
  isStateless: boolean;
}

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_TRANSPORT = 'stdio';
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 50;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}

export function getExposeThoughts(): boolean {
  return process.env.GEMINI_EXPOSE_THOUGHTS === 'true';
}

export function getTransportMode(): string {
  return process.env.MCP_TRANSPORT ?? DEFAULT_TRANSPORT;
}

export function getTransportConfig(): TransportConfig {
  return {
    port: parseIntEnv('MCP_HTTP_PORT', DEFAULT_HTTP_PORT),
    host: process.env.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST,
    corsOrigin: process.env.MCP_CORS_ORIGIN ?? '',
    isStateless: process.env.MCP_STATELESS === 'true',
  };
}

export function getAllowedHostsEnv(): string | undefined {
  return process.env.MCP_ALLOWED_HOSTS;
}

export function getAllowedFileRootsEnv(): string | undefined {
  return process.env.ALLOWED_FILE_ROOTS;
}

export function getSessionLimits(): { ttlMs: number; maxSessions: number } {
  return {
    ttlMs: parseIntEnv('SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS),
    maxSessions: parseIntEnv('MAX_SESSIONS', DEFAULT_MAX_SESSIONS),
  };
}
