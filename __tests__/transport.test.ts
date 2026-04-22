import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { createServer as createNodeServer, request as sendNodeRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { ScopedLogger } from '../src/lib/logger.js';
import { startHttpTransport, startWebStandardTransport } from '../src/transport.js';

const originalScopedLoggerError = Object.getOwnPropertyDescriptor(ScopedLogger.prototype, 'error')
  ?.value as typeof ScopedLogger.prototype.error;
const originalWebHandleRequest = Object.getOwnPropertyDescriptor(
  WebStandardStreamableHTTPServerTransport.prototype,
  'handleRequest',
)?.value as typeof WebStandardStreamableHTTPServerTransport.prototype.handleRequest;

interface ServerInstanceOptions {
  connectDelayMs?: number;
  failConnect?: boolean;
  onClose?: () => void;
  onCreate?: () => void;
}

function createServerInstance(options: ServerInstanceOptions = {}) {
  options.onCreate?.();
  const server = new McpServer(
    { name: 'transport-test', version: '0.0.1' },
    {
      capabilities: {
        logging: {},
        prompts: {},
        resources: { listChanged: true, subscribe: true },
        tasks: {
          requests: { tools: { call: {} } },
          taskStore: new InMemoryTaskStore(),
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
    },
  );

  if (options.failConnect || options.connectDelayMs) {
    const originalConnect = server.connect.bind(server);
    server.connect = async (transport) => {
      if (options.connectDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.connectDelayMs));
      }
      if (options.failConnect) {
        throw new Error('connect failed');
      }
      return await originalConnect(transport);
    };
  }

  return {
    server,
    close: async () => {
      options.onClose?.();
      await server.close();
    },
  };
}

function createRequest(
  body: unknown,
  sessionId?: string,
  options: { hostHeader?: string; requestUrl?: string } = {},
): Request {
  return new Request(options.requestUrl ?? 'http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: {
      host: options.hostHeader ?? '127.0.0.1:3000',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

async function withAvailablePort<T>(run: (port: number) => Promise<T>): Promise<T> {
  const probe = createNodeServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });

  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;

  await new Promise<void>((resolve, reject) => {
    probe.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return await run(port);
}

async function sendHttpRequest(options: {
  body?: string;
  headers?: Record<string, string>;
  method: 'OPTIONS' | 'POST';
  port: number;
}): Promise<{
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}> {
  return await new Promise((resolve, reject) => {
    const request = sendNodeRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        path: '/mcp',
        method: options.method,
        headers: options.headers,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            body,
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );

    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

async function initializeSession(
  transport: Awaited<ReturnType<typeof startWebStandardTransport>>,
): Promise<string> {
  const response = await transport.handler(
    createRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        capabilities: { roots: {} },
        clientInfo: { name: 'transport-test', version: '0.0.1' },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    }),
  );

  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId);
  return sessionId;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Bun;
  delete process.env.MCP_ALLOWED_HOSTS;
  delete process.env.MCP_CORS_ORIGIN;
  delete process.env.MCP_HTTP_HOST;
  delete process.env.MCP_MAX_TRANSPORT_SESSIONS;
  delete process.env.MCP_STATELESS;
  delete process.env.MCP_TRANSPORT_SESSION_TTL_MS;
  ScopedLogger.prototype.error = originalScopedLoggerError;
  WebStandardStreamableHTTPServerTransport.prototype.handleRequest = originalWebHandleRequest;
});

describe('startWebStandardTransport', () => {
  it('returns CORS preflight headers when enabled', async () => {
    process.env.MCP_STATELESS = 'true';
    process.env.MCP_CORS_ORIGIN = 'https://app.example.com';

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        new Request('http://127.0.0.1:3000/mcp', {
          method: 'OPTIONS',
          headers: {
            host: '127.0.0.1:3000',
            origin: 'https://app.example.com',
          },
        }),
      );

      assert.strictEqual(response.status, 204);
      assert.strictEqual(
        response.headers.get('Access-Control-Allow-Origin'),
        'https://app.example.com',
      );
      assert.match(response.headers.get('Vary') ?? '', /Origin/);
      assert.match(response.headers.get('Access-Control-Expose-Headers') ?? '', /mcp-session-id/);
    } finally {
      await transport.close();
    }
  });

  it('exposes MCP headers on normal responses when CORS is enabled', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_CORS_ORIGIN = 'https://app.example.com';

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            capabilities: { roots: {} },
            clientInfo: { name: 'transport-test', version: '0.0.1' },
            protocolVersion: LATEST_PROTOCOL_VERSION,
          },
        }),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers.get('Access-Control-Allow-Origin'),
        'https://app.example.com',
      );
      assert.match(response.headers.get('Vary') ?? '', /Origin/);
      assert.match(response.headers.get('Access-Control-Expose-Headers') ?? '', /mcp-session-id/);
      assert.ok(response.headers.get('mcp-session-id'));
    } finally {
      await transport.close();
    }
  });

  it('omits CORS headers when MCP_CORS_ORIGIN is unset', async () => {
    process.env.MCP_STATELESS = 'false';

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            capabilities: { roots: {} },
            clientInfo: { name: 'transport-test', version: '0.0.1' },
            protocolVersion: LATEST_PROTOCOL_VERSION,
          },
        }),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
      assert.strictEqual(response.headers.get('Vary'), null);
    } finally {
      await transport.close();
    }
  });

  it('does not include CORS headers on forbidden host mismatches', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.MCP_ALLOWED_HOSTS = '127.0.0.1';
    process.env.MCP_CORS_ORIGIN = 'https://app.example.com';

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, {
          hostHeader: 'evil.example.com',
        }),
      );

      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
    } finally {
      await transport.close();
    }
  });

  it('returns 404 for unknown stateful sessions', async () => {
    process.env.MCP_STATELESS = 'false';
    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'missing-session'),
      );

      assert.strictEqual(response.status, 404);
      assert.match(await response.text(), /Session not found/);
    } finally {
      await transport.close();
    }
  });

  it('accepts matching Host headers for specific non-local binds', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_HTTP_HOST = 'example.internal';
    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              capabilities: { roots: {} },
              clientInfo: { name: 'transport-test', version: '0.0.1' },
              protocolVersion: LATEST_PROTOCOL_VERSION,
            },
          },
          undefined,
          {
            hostHeader: 'example.internal:3000',
            requestUrl: 'http://example.internal:3000/mcp',
          },
        ),
      );

      assert.strictEqual(response.status, 200);
      assert.ok(response.headers.get('mcp-session-id'));
    } finally {
      await transport.close();
    }
  });

  it('accepts explicit allowed hosts that differ from the bind host', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_HTTP_HOST = '192.0.2.1';
    process.env.MCP_ALLOWED_HOSTS = 'mcp.internal';
    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              capabilities: { roots: {} },
              clientInfo: { name: 'transport-test', version: '0.0.1' },
              protocolVersion: LATEST_PROTOCOL_VERSION,
            },
          },
          undefined,
          {
            hostHeader: 'mcp.internal:3000',
            requestUrl: 'http://mcp.internal:3000/mcp',
          },
        ),
      );

      assert.strictEqual(response.status, 200);
      assert.ok(response.headers.get('mcp-session-id'));
    } finally {
      await transport.close();
    }
  });

  it('rejects mismatched Host headers for specific non-local binds', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_HTTP_HOST = 'example.internal';
    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, {
          hostHeader: 'other.internal:3000',
          requestUrl: 'http://example.internal:3000/mcp',
        }),
      );

      assert.strictEqual(response.status, 403);
    } finally {
      await transport.close();
    }
  });

  it('evicts the oldest stateful session when over capacity', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_MAX_TRANSPORT_SESSIONS = '1';

    let closeCalls = 0;
    const transport = await startWebStandardTransport(() =>
      createServerInstance({
        onClose: () => {
          closeCalls += 1;
        },
      }),
    );

    try {
      const firstSessionId = await initializeSession(transport);
      const secondSessionId = await initializeSession(transport);

      assert.notStrictEqual(firstSessionId, secondSessionId);
      assert.strictEqual(closeCalls, 1);

      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, firstSessionId),
      );

      assert.strictEqual(response.status, 404);
      assert.match(await response.text(), /Session not found/);
    } finally {
      await transport.close();
    }
  });

  it('expires idle stateful sessions', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_TRANSPORT_SESSION_TTL_MS = '1';

    let closeCalls = 0;
    const transport = await startWebStandardTransport(() =>
      createServerInstance({
        onClose: () => {
          closeCalls += 1;
        },
      }),
    );

    try {
      const sessionId = await initializeSession(transport);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, sessionId),
      );

      assert.strictEqual(response.status, 404);
      assert.match(await response.text(), /Session not found/);
      assert.strictEqual(closeCalls, 1);
    } finally {
      await transport.close();
    }
  });

  it('caps concurrent stateful session creation at the configured limit', async () => {
    process.env.MCP_STATELESS = 'false';
    process.env.MCP_MAX_TRANSPORT_SESSIONS = '1';

    let closeCalls = 0;
    let createCalls = 0;
    const transport = await startWebStandardTransport(() =>
      createServerInstance({
        connectDelayMs: 20,
        onClose: () => {
          closeCalls += 1;
        },
        onCreate: () => {
          createCalls += 1;
        },
      }),
    );

    try {
      const [firstSessionId, secondSessionId] = await Promise.all([
        initializeSession(transport),
        initializeSession(transport),
      ]);

      assert.strictEqual(createCalls, 2);
      assert.strictEqual(closeCalls, 1);

      const firstResponse = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, firstSessionId),
      );
      const secondResponse = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 3, method: 'ping' }, secondSessionId),
      );

      const statuses = [firstResponse.status, secondResponse.status].sort(
        (left, right) => left - right,
      );
      assert.deepStrictEqual(statuses, [200, 404]);
    } finally {
      await transport.close();
    }
  });

  it('closes created server instances when connect fails', async () => {
    process.env.MCP_STATELESS = 'false';

    let closeCalls = 0;
    const transport = await startWebStandardTransport(() =>
      createServerInstance({
        failConnect: true,
        onClose: () => {
          closeCalls += 1;
        },
      }),
    );

    try {
      const response = await transport.handler(
        createRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            capabilities: { roots: {} },
            clientInfo: { name: 'transport-test', version: '0.0.1' },
            protocolVersion: LATEST_PROTOCOL_VERSION,
          },
        }),
      );

      assert.strictEqual(response.status, 500);
      assert.strictEqual(closeCalls, 1);
    } finally {
      await transport.close();
    }
  });

  it('logs structured request failure metadata when a request fails with a session id', async () => {
    process.env.MCP_STATELESS = 'false';

    const logged: { data?: unknown; message: string }[] = [];
    ScopedLogger.prototype.error = function mockError(message: string, data?: unknown) {
      logged.push({ message, data });
    };

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const sessionId = await initializeSession(transport);
      WebStandardStreamableHTTPServerTransport.prototype.handleRequest = async function mockFail() {
        throw new Error('request boom');
      };

      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, sessionId),
      );

      assert.strictEqual(response.status, 500);
      const failure = logged.find((entry) => entry.message === 'request failed');
      assert.ok(failure);
      assert.deepStrictEqual(failure.data, {
        requestMethod: 'POST',
        sessionId,
        error: 'request boom',
        stack: (failure.data as { stack: string }).stack,
      });
      assert.match((failure.data as { stack: string }).stack, /request boom/);
    } finally {
      await transport.close();
    }
  });

  it('omits sessionId from structured request failure metadata when no session exists', async () => {
    process.env.MCP_STATELESS = 'false';

    const logged: { data?: unknown; message: string }[] = [];
    ScopedLogger.prototype.error = function mockError(message: string, data?: unknown) {
      logged.push({ message, data });
    };
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest = async function mockFail() {
      throw new Error('request boom');
    };

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const response = await transport.handler(
        createRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            capabilities: { roots: {} },
            clientInfo: { name: 'transport-test', version: '0.0.1' },
            protocolVersion: LATEST_PROTOCOL_VERSION,
          },
        }),
      );

      assert.strictEqual(response.status, 500);
      const failure = logged.find((entry) => entry.message === 'request failed');
      assert.ok(failure);
      assert.deepStrictEqual(failure.data, {
        requestMethod: 'POST',
        error: 'request boom',
        stack: (failure.data as { stack: string }).stack,
      });
      assert.ok(!('sessionId' in ((failure.data as Record<string, unknown>) ?? {})));
      assert.match((failure.data as { stack: string }).stack, /request boom/);
    } finally {
      await transport.close();
    }
  });

  it('closes the Bun runtime handle during shutdown', async () => {
    process.env.MCP_STATELESS = 'true';
    let stopCalls = 0;
    (globalThis as Record<string, unknown>).Bun = {
      serve: () => ({
        stop: async () => {
          stopCalls++;
        },
      }),
    };

    const transport = await startWebStandardTransport(() => createServerInstance());
    await transport.close();

    assert.strictEqual(stopCalls, 1);
  });
});

describe('startHttpTransport', () => {
  it('returns CORS preflight headers with Vary: Origin when enabled', async () => {
    await withAvailablePort(async (port) => {
      process.env.MCP_HTTP_HOST = '127.0.0.1';
      process.env.MCP_HTTP_PORT = String(port);
      process.env.MCP_CORS_ORIGIN = 'https://app.example.com';
      process.env.MCP_STATELESS = 'true';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'OPTIONS',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            origin: 'https://app.example.com',
          },
        });

        assert.strictEqual(response.status, 204);
        assert.strictEqual(
          firstHeaderValue(response.headers['access-control-allow-origin']),
          'https://app.example.com',
        );
        assert.match(firstHeaderValue(response.headers.vary) ?? '', /Origin/);
      } finally {
        await transport.close();
      }
    });
  });

  it('rejects mismatched Host headers before CORS headers are applied', async () => {
    await withAvailablePort(async (port) => {
      process.env.MCP_HTTP_HOST = '127.0.0.1';
      process.env.MCP_HTTP_PORT = String(port);
      process.env.MCP_CORS_ORIGIN = 'https://app.example.com';
      process.env.MCP_STATELESS = 'false';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'POST',
          port,
          headers: {
            host: 'evil.example.com',
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        });

        assert.strictEqual(response.status, 403);
        assert.strictEqual(firstHeaderValue(response.headers['access-control-allow-origin']), null);
        assert.match(response.body, /(Forbidden|Invalid Host)/);
      } finally {
        await transport.close();
      }
    });
  });

  it('accepts explicit allowed hosts that differ from the bind host', async () => {
    await withAvailablePort(async (port) => {
      process.env.MCP_HTTP_HOST = '127.0.0.1';
      process.env.MCP_HTTP_PORT = String(port);
      process.env.MCP_ALLOWED_HOSTS = 'app.example.com';
      process.env.MCP_STATELESS = 'false';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'POST',
          port,
          headers: {
            host: 'app.example.com',
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              capabilities: { roots: {} },
              clientInfo: { name: 'transport-test', version: '0.0.1' },
              protocolVersion: LATEST_PROTOCOL_VERSION,
            },
          }),
        });

        assert.strictEqual(response.status, 200);
        assert.match(response.body, /"result"/);
      } finally {
        await transport.close();
      }
    });
  });

  it('rejects bind conflicts during startup', async () => {
    const occupiedServer = createNodeServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = occupiedServer.address();
    assert.ok(address && typeof address === 'object');
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.MCP_HTTP_PORT = String(address.port);

    try {
      await assert.rejects(
        () => startHttpTransport(() => createServerInstance()),
        (err: unknown) =>
          err instanceof Error && ('code' in err || /listen|EADDRINUSE/i.test(err.message)),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      delete process.env.MCP_HTTP_HOST;
      delete process.env.MCP_HTTP_PORT;
    }
  });
});
