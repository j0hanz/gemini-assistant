import type { ServerContext } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAutoDerivedAllowedHosts,
  resolveAllowedHosts,
  validateHostHeader,
} from '../src/lib/validation.js';
import { startWebStandardTransport } from '../src/transport.js';

function createNoopServerInstance() {
  const server = new McpServer({ name: 'transport-auth-test', version: '0.0.1' });
  server.registerTool(
    'ping',
    {
      description: 'Ping',
      inputSchema: undefined,
    },
    async (_args: unknown, _ctx: ServerContext) => ({
      content: [{ type: 'text', text: 'pong' }],
    }),
  );
  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://0.0.0.0:3000/mcp', {
    method: 'POST',
    headers: {
      host: '0.0.0.0:3000',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
}

describe('transport host validation helpers', () => {
  it('resolves identical default host policies for localhost, broad, and specific binds', () => {
    const cases = [
      {
        bindHost: '127.0.0.1',
        expectedAllowedHosts: ['localhost', '127.0.0.1', '[::1]'],
        acceptedHostHeader: '127.0.0.1:3000',
        rejectedHostHeader: 'evil.example.com:3000',
        autoDerived: false,
      },
      {
        bindHost: '0.0.0.0',
        expectedAllowedHosts: undefined,
        acceptedHostHeader: null,
        rejectedHostHeader: null,
        autoDerived: false,
      },
      {
        bindHost: '192.0.2.1',
        expectedAllowedHosts: ['192.0.2.1'],
        acceptedHostHeader: '192.0.2.1:3000',
        rejectedHostHeader: 'evil.example.com:3000',
        autoDerived: true,
      },
    ] as const;

    for (const testCase of cases) {
      const allowedHosts = resolveAllowedHosts(testCase.bindHost);
      assert.deepStrictEqual(allowedHosts, testCase.expectedAllowedHosts);
      assert.equal(isAutoDerivedAllowedHosts(testCase.bindHost), testCase.autoDerived);

      if (allowedHosts && testCase.acceptedHostHeader && testCase.rejectedHostHeader) {
        assert.equal(validateHostHeader(testCase.acceptedHostHeader, allowedHosts), true);
        assert.equal(validateHostHeader(testCase.rejectedHostHeader, allowedHosts), false);
      }
    }
  });
});

describe('transport HTTP protection', () => {
  it('throws for non-loopback binds without MCP_HTTP_TOKEN', async () => {
    process.env.HOST = '0.0.0.0';
    try {
      assert.throws(
        () => startWebStandardTransport(() => createNoopServerInstance()),
        /requires MCP_HTTP_TOKEN/,
      );
    } finally {
      delete process.env.HOST;
    }
  });

  it('returns 401 for missing bearer token on protected binds', async () => {
    process.env.HOST = '0.0.0.0';
    process.env.MCP_HTTP_TOKEN = 'x'.repeat(32);
    const transport = await startWebStandardTransport(() => createNoopServerInstance());
    try {
      const response = await transport.handler(request());
      assert.strictEqual(response.status, 401);
    } finally {
      await transport.close();
      delete process.env.HOST;
      delete process.env.MCP_HTTP_TOKEN;
    }
  });

  it('returns 429 with Retry-After when the burst is exhausted', async () => {
    const token = 'x'.repeat(32);
    process.env.HOST = '0.0.0.0';
    process.env.MCP_HTTP_TOKEN = token;
    process.env.MCP_HTTP_RATE_LIMIT_RPS = '1';
    process.env.MCP_HTTP_RATE_LIMIT_BURST = '1';
    const transport = await startWebStandardTransport(() => createNoopServerInstance());
    try {
      await transport.handler(request({ authorization: `Bearer ${token}` }));
      const response = await transport.handler(request({ authorization: `Bearer ${token}` }));
      assert.strictEqual(response.status, 429);
      assert.strictEqual(response.headers.get('retry-after'), '1');
    } finally {
      await transport.close();
      delete process.env.HOST;
      delete process.env.MCP_HTTP_TOKEN;
      delete process.env.MCP_HTTP_RATE_LIMIT_RPS;
      delete process.env.MCP_HTTP_RATE_LIMIT_BURST;
    }
  });

  it('does not trust x-forwarded-for to bypass web-standard rate limiting', async () => {
    const token = 'x'.repeat(32);
    process.env.HOST = '0.0.0.0';
    process.env.MCP_HTTP_TOKEN = token;
    process.env.MCP_HTTP_RATE_LIMIT_RPS = '1';
    process.env.MCP_HTTP_RATE_LIMIT_BURST = '1';
    const transport = await startWebStandardTransport(() => createNoopServerInstance());
    try {
      await transport.handler(
        request({ authorization: `Bearer ${token}`, 'x-forwarded-for': '192.0.2.1' }),
      );
      const response = await transport.handler(
        request({ authorization: `Bearer ${token}`, 'x-forwarded-for': '192.0.2.2' }),
      );
      assert.strictEqual(response.status, 429);
      assert.strictEqual(response.headers.get('retry-after'), '1');
    } finally {
      await transport.close();
      delete process.env.HOST;
      delete process.env.MCP_HTTP_TOKEN;
      delete process.env.MCP_HTTP_RATE_LIMIT_RPS;
      delete process.env.MCP_HTTP_RATE_LIMIT_BURST;
    }
  });

  it('allows loopback binds without MCP_HTTP_TOKEN', async () => {
    process.env.HOST = '127.0.0.1';
    const transport = await startWebStandardTransport(() => createNoopServerInstance());
    try {
      const response = await transport.handler(
        new Request('http://127.0.0.1:3000/not-found', { headers: { host: '127.0.0.1:3000' } }),
      );
      assert.strictEqual(response.status, 404);
    } finally {
      await transport.close();
      delete process.env.HOST;
    }
  });

  it('normalizes explicit ALLOWED_HOSTS entries with ports', async () => {
    process.env.HOST = '127.0.0.1';
    process.env.ALLOWED_HOSTS = 'localhost:3000';
    const transport = await startWebStandardTransport(() => createNoopServerInstance());
    try {
      const accepted = await transport.handler(request({ host: 'localhost:3000' }));
      const rejected = await transport.handler(request({ host: 'evil.example' }));

      assert.notStrictEqual(accepted.status, 403);
      assert.strictEqual(rejected.status, 403);
    } finally {
      await transport.close();
      delete process.env.HOST;
      delete process.env.ALLOWED_HOSTS;
    }
  });
});
