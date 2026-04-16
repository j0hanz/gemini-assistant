import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getSessionLimits, getTransportConfig, getTransportMode } from '../src/config.js';

afterEach(() => {
  delete process.env.MAX_SESSIONS;
  delete process.env.MAX_SESSION_EVENT_ENTRIES;
  delete process.env.MAX_SESSION_TRANSCRIPT_ENTRIES;
  delete process.env.MCP_HTTP_HOST;
  delete process.env.MCP_HTTP_PORT;
  delete process.env.MCP_MAX_TRANSPORT_SESSIONS;
  delete process.env.MCP_STATELESS;
  delete process.env.MCP_TRANSPORT;
  delete process.env.MCP_TRANSPORT_SESSION_TTL_MS;
  delete process.env.SESSION_TTL_MS;
});

describe('config parsing', () => {
  it('rejects invalid transport modes', () => {
    process.env.MCP_TRANSPORT = 'socket';
    assert.throws(() => getTransportMode(), /MCP_TRANSPORT/);
  });

  it('rejects invalid transport ports', () => {
    process.env.MCP_HTTP_PORT = '70000';
    assert.throws(() => getTransportConfig(), /MCP_HTTP_PORT/);
  });

  it('rejects empty transport hosts', () => {
    process.env.MCP_HTTP_HOST = '   ';
    assert.throws(() => getTransportConfig(), /MCP_HTTP_HOST/);
  });

  it('rejects invalid stateless flags', () => {
    process.env.MCP_STATELESS = 'yes';
    assert.throws(() => getTransportConfig(), /MCP_STATELESS/);
  });

  it('rejects invalid session ttl values', () => {
    process.env.SESSION_TTL_MS = '0';
    assert.throws(() => getSessionLimits(), /SESSION_TTL_MS/);
  });

  it('rejects invalid transport session limits', () => {
    process.env.MCP_MAX_TRANSPORT_SESSIONS = '0';
    assert.throws(() => getTransportConfig(), /MCP_MAX_TRANSPORT_SESSIONS/);
  });

  it('rejects excessively large transport session limits', () => {
    process.env.MCP_MAX_TRANSPORT_SESSIONS = '10001';
    assert.throws(() => getTransportConfig(), /MCP_MAX_TRANSPORT_SESSIONS/);
  });

  it('rejects invalid transport session ttl values', () => {
    process.env.MCP_TRANSPORT_SESSION_TTL_MS = 'abc';
    assert.throws(() => getTransportConfig(), /MCP_TRANSPORT_SESSION_TTL_MS/);
  });

  it('rejects invalid session retention limits', () => {
    process.env.MAX_SESSION_TRANSCRIPT_ENTRIES = '0';
    assert.throws(() => getSessionLimits(), /MAX_SESSION_TRANSCRIPT_ENTRIES/);
  });

  it('returns validated transport config values', () => {
    process.env.MCP_HTTP_PORT = '3100';
    process.env.MCP_MAX_TRANSPORT_SESSIONS = '12';
    process.env.MCP_STATELESS = 'true';
    process.env.MCP_TRANSPORT_SESSION_TTL_MS = '5000';

    assert.deepStrictEqual(getTransportConfig(), {
      corsOrigin: '',
      host: '127.0.0.1',
      isStateless: true,
      maxSessions: 12,
      port: 3100,
      sessionTtlMs: 5000,
    });
  });

  it('returns validated session limit values', () => {
    process.env.MAX_SESSIONS = '25';
    process.env.MAX_SESSION_EVENT_ENTRIES = '75';
    process.env.MAX_SESSION_TRANSCRIPT_ENTRIES = '50';
    process.env.SESSION_TTL_MS = '1000';

    assert.deepStrictEqual(getSessionLimits(), {
      maxEventEntries: 75,
      maxSessions: 25,
      maxTranscriptEntries: 50,
      ttlMs: 1000,
    });
  });
});
