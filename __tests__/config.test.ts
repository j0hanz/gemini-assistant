import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getExposeThoughts,
  getGeminiModel,
  getSessionLimits,
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
  'ROOTS',
  'CONTEXT',
  'AUTO_SCAN',
  'CACHE',
  'CACHE_TTL',
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

    assert.deepStrictEqual(getTransportConfig(), {
      corsOrigin: '',
      host: '0.0.0.0',
      isStateless: false,
      maxSessions: 100,
      port: 3100,
      sessionTtlMs: 30 * 60 * 1000,
    });
  });

  it('returns default session limits', () => {
    assert.deepStrictEqual(getSessionLimits(), {
      maxEventEntries: 200,
      maxSessions: 50,
      maxTranscriptEntries: 200,
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

  it('defaults CACHE to false', () => {
    assert.strictEqual(getWorkspaceCacheEnabled(), false);
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
    assert.strictEqual(getWorkspaceCacheEnabled(), false);
    assert.strictEqual(getWorkspaceAutoScan(), true);
    assert.strictEqual(getTransportMode(), 'stdio');
    assert.strictEqual(getVerbosePayloadLogging(), false);
    assert.strictEqual(getExposeThoughts(), false);
    assert.strictEqual(getWorkspaceContextFile(), undefined);
    assert.strictEqual(getWorkspaceCacheTtl(), '3600s');
  });
});
