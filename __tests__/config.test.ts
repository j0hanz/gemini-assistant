import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getApiKey,
  getExposeSessionResources,
  getExposeThoughts,
  getGeminiModel,
  getMaxOutputTokens,
  getSafetySettings,
  getSessionLimits,
  getSessionRedactionPatterns,
  getSlimSessionEvents,
  getThinkingBudgetCap,
  getTransportConfig,
  getTransportMode,
  getVerbosePayloadLogging,
  getWorkspaceAutoScan,
  getWorkspaceCacheEnabled,
  getWorkspaceCacheTtl,
  getWorkspaceContextFile,
} from '../src/config.js';

const NEW_VARS = [
  'API_KEY',
  'MODEL',
  'THOUGHTS',
  'LOG_PAYLOADS',
  'TRANSPORT',
  'HOST',
  'PORT',
  'CORS_ORIGIN',
  'STATELESS',
  'ALLOWED_HOSTS',
  'MCP_HTTP_TOKEN',
  'MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP',
  'MCP_HTTP_RATE_LIMIT_RPS',
  'MCP_HTTP_RATE_LIMIT_BURST',
  'MCP_TRUST_PROXY',
  'MAX_TRANSPORT_SESSIONS',
  'TRANSPORT_SESSION_TTL_MS',
  'ROOTS',
  'CONTEXT',
  'AUTO_SCAN',
  'CACHE',
  'CACHE_TTL',
  'GEMINI_MAX_OUTPUT_TOKENS',
  'GEMINI_THINKING_BUDGET_CAP',
  'GEMINI_SAFETY_SETTINGS',
  'GEMINI_SESSION_REDACT_KEYS',
  'SESSION_REPLAY_INLINE_DATA_MAX_BYTES',
  'SESSION_REPLAY_MAX_BYTES',
  'SESSION_EVENTS_VERBOSE',
  'MCP_EXPOSE_SESSION_RESOURCES',
] as const;

const OLD_VARS = [
  'GEMINI_MODEL',
  'GEMINI_EXPOSE_THOUGHTS',
  'ALLOWED_FILE_ROOTS',
  'WORKSPACE_CONTEXT_FILE',
  'WORKSPACE_AUTO_SCAN',
  'WORKSPACE_CACHE_ENABLED',
  'WORKSPACE_CACHE_TTL',
  'LOG_VERBOSE_PAYLOADS',
  'MCP_TRANSPORT',
  'MCP_HTTP_HOST',
  'MCP_HTTP_PORT',
  'MCP_CORS_ORIGIN',
  'MCP_STATELESS',
  'MCP_MAX_TRANSPORT_SESSIONS',
  'MCP_TRANSPORT_SESSION_TTL_MS',
  'MCP_ALLOWED_HOSTS',
  'MAX_SESSIONS',
  'SESSION_TTL_MS',
  'MAX_SESSION_EVENT_ENTRIES',
  'MAX_SESSION_TRANSCRIPT_ENTRIES',
] as const;

afterEach(() => {
  for (const name of NEW_VARS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[name];
  }
  for (const name of OLD_VARS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[name];
  }
});

describe('config parsing', () => {
  it('rejects invalid transport modes', () => {
    process.env.TRANSPORT = 'socket';
    assert.throws(() => getTransportMode(), /TRANSPORT/);
  });

  it('rejects invalid transport ports', () => {
    process.env.PORT = '70000';
    assert.throws(() => getTransportConfig(), /PORT/);
  });

  it('rejects empty transport hosts', () => {
    process.env.HOST = '   ';
    assert.throws(() => getTransportConfig(), /HOST/);
  });

  it('rejects invalid verbose payload logging flags', () => {
    process.env.LOG_PAYLOADS = 'yes';
    assert.throws(() => getVerbosePayloadLogging(), /LOG_PAYLOADS/);
  });

  it('rejects invalid THOUGHTS boolean', () => {
    process.env.THOUGHTS = 'yes';
    assert.throws(() => getExposeThoughts(), /THOUGHTS/);
  });

  it('enables sensitive session resources only for explicit true or 1', () => {
    assert.strictEqual(getExposeSessionResources(), false);
    process.env.MCP_EXPOSE_SESSION_RESOURCES = 'true';
    assert.strictEqual(getExposeSessionResources(), true);
    process.env.MCP_EXPOSE_SESSION_RESOURCES = '1';
    assert.strictEqual(getExposeSessionResources(), true);
    process.env.MCP_EXPOSE_SESSION_RESOURCES = 'false';
    assert.strictEqual(getExposeSessionResources(), false);
    process.env.MCP_EXPOSE_SESSION_RESOURCES = 'yes';
    assert.strictEqual(getExposeSessionResources(), false);
  });

  it('rejects invalid CACHE boolean', () => {
    process.env.CACHE = 'yes';
    assert.throws(() => getWorkspaceCacheEnabled(), /CACHE/);
  });

  it('rejects invalid AUTO_SCAN boolean', () => {
    process.env.AUTO_SCAN = 'yes';
    assert.throws(() => getWorkspaceAutoScan(), /AUTO_SCAN/);
  });

  it('returns validated transport config values', () => {
    process.env.PORT = '3100';
    process.env.HOST = '0.0.0.0';
    process.env.CORS_ORIGIN = 'https://example.test';
    process.env.STATELESS = 'true';
    process.env.MAX_TRANSPORT_SESSIONS = '250';
    process.env.TRANSPORT_SESSION_TTL_MS = '60000';

    assert.deepStrictEqual(getTransportConfig(), {
      allowUnauthenticatedLoopbackHttp: false,
      corsOrigin: 'https://example.test',
      host: '0.0.0.0',
      isStateless: true,
      maxSessions: 250,
      port: 3100,
      rateLimitBurst: 20,
      rateLimitRps: 10,
      sessionTtlMs: 60_000,
      trustProxy: false,
    });
  });

  it('returns default transport config values when optional envs are unset', () => {
    assert.deepStrictEqual(getTransportConfig(), {
      allowUnauthenticatedLoopbackHttp: false,
      corsOrigin: '',
      host: '127.0.0.1',
      isStateless: false,
      maxSessions: 100,
      port: 3000,
      rateLimitBurst: 20,
      rateLimitRps: 10,
      sessionTtlMs: 30 * 60 * 1000,
      trustProxy: false,
    });
  });

  it('returns validated HTTP auth and rate-limit config values', () => {
    process.env.MCP_HTTP_TOKEN = 'token-1234567890abcdef-token-123456';
    process.env.MCP_HTTP_RATE_LIMIT_RPS = '7';
    process.env.MCP_HTTP_RATE_LIMIT_BURST = '11';
    process.env.MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP = 'true';
    process.env.MCP_TRUST_PROXY = 'true';

    assert.strictEqual(getTransportConfig().token, 'token-1234567890abcdef-token-123456');
    assert.strictEqual(getTransportConfig().rateLimitRps, 7);
    assert.strictEqual(getTransportConfig().rateLimitBurst, 11);
    assert.strictEqual(getTransportConfig().allowUnauthenticatedLoopbackHttp, true);
    assert.strictEqual(getTransportConfig().trustProxy, true);
  });

  it('rejects invalid HTTP auth and rate-limit config values', () => {
    process.env.MCP_HTTP_TOKEN = 'short';
    assert.throws(() => getTransportConfig(), /MCP_HTTP_TOKEN/);

    process.env.MCP_HTTP_TOKEN = 'ab'.repeat(16);
    assert.throws(() => getTransportConfig(), /trivially repeated pattern/);

    delete process.env.MCP_HTTP_TOKEN;
    process.env.MCP_HTTP_RATE_LIMIT_RPS = '0';
    assert.throws(() => getTransportConfig(), /MCP_HTTP_RATE_LIMIT_RPS/);

    process.env.MCP_HTTP_RATE_LIMIT_RPS = '1';
    process.env.MCP_HTTP_RATE_LIMIT_BURST = '0';
    assert.throws(() => getTransportConfig(), /MCP_HTTP_RATE_LIMIT_BURST/);
  });

  it('accepts wildcard CORS origin', () => {
    process.env.CORS_ORIGIN = '*';
    assert.strictEqual(getTransportConfig().corsOrigin, '*');
  });

  it('rejects wildcard CORS when bearer auth is enabled', () => {
    process.env.CORS_ORIGIN = '*';
    process.env.MCP_HTTP_TOKEN = '0123456789abcdef0123456789abcdef';

    assert.throws(() => getTransportConfig(), /wildcard CORS|CORS_ORIGIN/i);
  });

  it('accepts a strict bare http(s) origin', () => {
    process.env.CORS_ORIGIN = 'https://example.com';
    assert.strictEqual(getTransportConfig().corsOrigin, 'https://example.com');
  });

  it('rejects CORS origins with paths, credentials, or non-http schemes', () => {
    process.env.CORS_ORIGIN = 'https://example.com/path';
    assert.throws(() => getTransportConfig(), /CORS_ORIGIN/);

    process.env.CORS_ORIGIN = 'https://user:pass@example.com';
    assert.throws(() => getTransportConfig(), /CORS_ORIGIN/);

    process.env.CORS_ORIGIN = 'ftp://example.com';
    assert.throws(() => getTransportConfig(), /CORS_ORIGIN/);
  });

  it('rejects invalid transport option env values', () => {
    process.env.CORS_ORIGIN = 'https://a.test,https://b.test';
    assert.throws(() => getTransportConfig(), /CORS_ORIGIN/);

    process.env.CORS_ORIGIN = 'https://example.test';
    process.env.STATELESS = 'yes';
    assert.throws(() => getTransportConfig(), /STATELESS/);

    process.env.STATELESS = 'false';
    process.env.MAX_TRANSPORT_SESSIONS = '0';
    assert.throws(() => getTransportConfig(), /MAX_TRANSPORT_SESSIONS/);

    process.env.MAX_TRANSPORT_SESSIONS = '100';
    process.env.TRANSPORT_SESSION_TTL_MS = '999';
    assert.throws(() => getTransportConfig(), /TRANSPORT_SESSION_TTL_MS/);

    process.env.TRANSPORT_SESSION_TTL_MS = '1000';
    process.env.MCP_TRUST_PROXY = 'yes';
    assert.throws(() => getTransportConfig(), /MCP_TRUST_PROXY/);
  });

  it('rejects weak low-entropy HTTP tokens', () => {
    process.env.MCP_HTTP_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';

    assert.throws(() => getTransportConfig(), /48 chars|16 distinct/i);
  });

  it('accepts short tokens when they contain enough distinct characters', () => {
    process.env.MCP_HTTP_TOKEN = '0123456789abcdef0123456789abcdef';

    assert.strictEqual(getTransportConfig().token, '0123456789abcdef0123456789abcdef');
  });

  it('accepts longer tokens even when uniqueness is lower', () => {
    process.env.MCP_HTTP_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbb';

    assert.strictEqual(
      getTransportConfig().token,
      'aaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('returns default session limits', () => {
    assert.deepStrictEqual(getSessionLimits(), {
      maxEventEntries: 50,
      maxSessions: 50,
      maxTranscriptEntries: 50,
      replayInlineDataMaxBytes: 16 * 1024,
      replayMaxBytes: 50_000,
      ttlMs: 30 * 60 * 1000,
    });
  });

  it('defaults verbose payload logging to false', () => {
    assert.strictEqual(getVerbosePayloadLogging(), false);
  });

  it('returns validated verbose payload logging values', () => {
    process.env.LOG_PAYLOADS = 'true';
    assert.strictEqual(getVerbosePayloadLogging(), true);
  });

  it('defaults MODEL to the project default', () => {
    assert.strictEqual(getGeminiModel(), 'gemini-3-flash-preview');
  });

  it('returns the configured MODEL when set', () => {
    process.env.MODEL = 'gemini-3-pro';
    assert.strictEqual(getGeminiModel(), 'gemini-3-pro');
  });

  it('rejects empty MODEL values', () => {
    process.env.MODEL = '   ';
    assert.throws(() => getGeminiModel(), /MODEL/);
  });

  it('defaults THOUGHTS to false', () => {
    assert.strictEqual(getExposeThoughts(), false);
  });

  it('honours THOUGHTS=true', () => {
    process.env.THOUGHTS = 'true';
    assert.strictEqual(getExposeThoughts(), true);
  });

  it('defaults CACHE to true', () => {
    assert.strictEqual(getWorkspaceCacheEnabled(), true);
  });

  it('honours CACHE=true', () => {
    process.env.CACHE = 'true';
    assert.strictEqual(getWorkspaceCacheEnabled(), true);
  });

  it('defaults AUTO_SCAN to true', () => {
    assert.strictEqual(getWorkspaceAutoScan(), true);
  });

  it('honours AUTO_SCAN=false', () => {
    process.env.AUTO_SCAN = 'false';
    assert.strictEqual(getWorkspaceAutoScan(), false);
  });

  it('defaults CACHE_TTL to 3600s', () => {
    assert.strictEqual(getWorkspaceCacheTtl(), '3600s');
  });

  it('defaults GEMINI_MAX_OUTPUT_TOKENS to 2048', () => {
    assert.strictEqual(getMaxOutputTokens(), 2048);
  });

  it('defaults GEMINI_THINKING_BUDGET_CAP to 16384', () => {
    assert.strictEqual(getThinkingBudgetCap(), 16384);
  });

  it('returns configured GEMINI_THINKING_BUDGET_CAP when set', () => {
    process.env.GEMINI_THINKING_BUDGET_CAP = '2048';
    assert.strictEqual(getThinkingBudgetCap(), 2_048);
  });

  it('defaults to slim session events', () => {
    assert.strictEqual(getSlimSessionEvents(), true);
  });

  it('disables slim session events when SESSION_EVENTS_VERBOSE=true', () => {
    process.env.SESSION_EVENTS_VERBOSE = 'true';
    assert.strictEqual(getSlimSessionEvents(), false);
  });

  it('returns configured GEMINI_MAX_OUTPUT_TOKENS when set', () => {
    process.env.GEMINI_MAX_OUTPUT_TOKENS = '4096';
    assert.strictEqual(getMaxOutputTokens(), 4096);
  });

  it('returns configured GEMINI_SAFETY_SETTINGS when set', () => {
    process.env.GEMINI_SAFETY_SETTINGS = JSON.stringify([
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        method: 'PROBABILITY',
        threshold: 'BLOCK_ONLY_HIGH',
      },
    ]);

    assert.deepStrictEqual(getSafetySettings(), [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        method: 'PROBABILITY',
        threshold: 'BLOCK_ONLY_HIGH',
      },
    ]);
  });

  it('rejects invalid GEMINI_SAFETY_SETTINGS entries', () => {
    process.env.GEMINI_SAFETY_SETTINGS = JSON.stringify([
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'NOT_A_THRESHOLD',
      },
    ]);

    assert.throws(() => getSafetySettings(), /GEMINI_SAFETY_SETTINGS\[0\]\.threshold/);

    process.env.GEMINI_SAFETY_SETTINGS = JSON.stringify([
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_ONLY_HIGH',
        extra: true,
      },
    ]);

    assert.throws(() => getSafetySettings(), /unknown keys: extra/);
  });

  it('trims API_KEY values', () => {
    process.env.API_KEY = '  abc123  ';

    assert.strictEqual(getApiKey(), 'abc123');
  });

  it('rejects API_KEY values with control characters', () => {
    process.env.API_KEY = 'abc\tdef';

    assert.throws(() => getApiKey(), /API_KEY/);
  });

  it('rejects unsafe session redaction regexes', () => {
    process.env.GEMINI_SESSION_REDACT_KEYS = '/(a+)+$/';

    assert.throws(() => getSessionRedactionPatterns(), /regex|pattern|unsafe/i);
  });

  it('rejects overlong session redaction regexes', () => {
    process.env.GEMINI_SESSION_REDACT_KEYS = `/${'a'.repeat(257)}/`;

    assert.throws(() => getSessionRedactionPatterns(), /256|pattern/i);
  });

  it('accepts safe session redaction regexes with supported flags', () => {
    process.env.GEMINI_SESSION_REDACT_KEYS = '/^foo$/i';

    assert.ok(getSessionRedactionPatterns().some((pattern) => pattern.source === '^foo$'));
  });

  it('returns the configured CACHE_TTL when set', () => {
    process.env.CACHE_TTL = '7200s';
    assert.strictEqual(getWorkspaceCacheTtl(), '7200s');
  });

  it('returns the configured CONTEXT when set', () => {
    process.env.CONTEXT = '/tmp/ctx.md';
    assert.strictEqual(getWorkspaceContextFile(), '/tmp/ctx.md');
  });

  it('returns undefined CONTEXT when unset', () => {
    assert.strictEqual(getWorkspaceContextFile(), undefined);
  });

  it('ignores old env variable names (no alias fallback)', () => {
    process.env.GEMINI_MODEL = 'legacy-model';
    process.env.WORKSPACE_CACHE_ENABLED = 'true';
    process.env.WORKSPACE_AUTO_SCAN = 'false';
    process.env.MCP_TRANSPORT = 'http';
    process.env.LOG_VERBOSE_PAYLOADS = 'true';
    process.env.GEMINI_EXPOSE_THOUGHTS = 'true';
    process.env.WORKSPACE_CONTEXT_FILE = '/tmp/legacy.md';
    process.env.WORKSPACE_CACHE_TTL = '9999s';

    assert.strictEqual(getGeminiModel(), 'gemini-3-flash-preview');
    assert.strictEqual(getWorkspaceCacheEnabled(), true);
    assert.strictEqual(getWorkspaceAutoScan(), true);
    assert.strictEqual(getTransportMode(), 'stdio');
    assert.strictEqual(getVerbosePayloadLogging(), false);
    assert.strictEqual(getExposeThoughts(), false);
    assert.strictEqual(getWorkspaceContextFile(), undefined);
    assert.strictEqual(getWorkspaceCacheTtl(), '3600s');
  });
});
