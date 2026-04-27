import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { createServer as createNodeServer, request as sendNodeRequest } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ScopedLogger } from '../src/lib/logger.js';
import { startHttpTransport, startWebStandardTransport } from '../src/transport.js';

const VALID_TOKEN = 'token-1234567890abcdef-token-123456';

const originalScopedLoggerError = Object.getOwnPropertyDescriptor(ScopedLogger.prototype, 'error')
  ?.value as typeof ScopedLogger.prototype.error;
const originalScopedLoggerInfo = Object.getOwnPropertyDescriptor(ScopedLogger.prototype, 'info')
  ?.value as typeof ScopedLogger.prototype.info;
const originalScopedLoggerWarn = Object.getOwnPropertyDescriptor(ScopedLogger.prototype, 'warn')
  ?.value as typeof ScopedLogger.prototype.warn;
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
  options: {
    authorization?: string;
    hostHeader?: string;
    method?: 'DELETE' | 'GET' | 'OPTIONS' | 'POST' | 'PUT';
    requestUrl?: string;
  } = {},
): Request {
  const method = options.method ?? 'POST';
  return new Request(options.requestUrl ?? 'http://127.0.0.1:3000/mcp', {
    method,
    headers: {
      host: options.hostHeader ?? '127.0.0.1:3000',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) }),
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
  method: 'DELETE' | 'GET' | 'OPTIONS' | 'POST';
  port: number;
  readBody?: boolean;
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
        if (options.readBody === false) {
          response.resume();
          response.destroy();
          resolve({
            body: '',
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
          return;
        }

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

function createInitializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      capabilities: { roots: {} },
      clientInfo: { name: 'transport-test', version: '0.0.1' },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  });
}

async function initializeHttpSession(port: number): Promise<string> {
  const response = await sendHttpRequest({
    method: 'POST',
    port,
    headers: {
      host: `127.0.0.1:${String(port)}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: createInitializeBody(),
  });

  assert.strictEqual(response.status, 200);
  const sessionId = firstHeaderValue(response.headers['mcp-session-id']);
  assert.ok(sessionId);
  return sessionId;
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
  delete process.env.HOST;
  delete process.env.PORT;
  delete process.env.CORS_ORIGIN;
  delete process.env.STATELESS;
  delete process.env.ALLOWED_HOSTS;
  delete process.env.MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP;
  delete process.env.MAX_TRANSPORT_SESSIONS;
  delete process.env.MCP_HTTP_TOKEN;
  delete process.env.MCP_HTTP_RATE_LIMIT_RPS;
  delete process.env.MCP_HTTP_RATE_LIMIT_BURST;
  delete process.env.MCP_TRUST_PROXY;
  ScopedLogger.prototype.error = originalScopedLoggerError;
  ScopedLogger.prototype.info = originalScopedLoggerInfo;
  ScopedLogger.prototype.warn = originalScopedLoggerWarn;
  WebStandardStreamableHTTPServerTransport.prototype.handleRequest = originalWebHandleRequest;
});

beforeEach(() => {
  process.env.MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP = 'true';
});

describe('startWebStandardTransport', () => {
  it('returns 404 for unknown stateful sessions', async () => {
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
    process.env.HOST = 'example.internal';
    process.env.MCP_HTTP_TOKEN = VALID_TOKEN;
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
            authorization: `Bearer ${VALID_TOKEN}`,
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
    process.env.HOST = 'example.internal';
    process.env.MCP_HTTP_TOKEN = VALID_TOKEN;
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

  it('closes created server instances when connect fails', async () => {
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

  it('keeps stateful sessions up to the configured capacity', async () => {
    process.env.MAX_TRANSPORT_SESSIONS = '2';
    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const firstSessionId = await initializeSession(transport);
      await initializeSession(transport);

      const response = await transport.handler(
        createRequest({ jsonrpc: '2.0', id: 3, method: 'ping' }, firstSessionId),
      );

      assert.strictEqual(response.status, 200);
    } finally {
      await transport.close();
    }
  });

  it('returns 405 with Allow header for non-POST methods in stateless mode', async () => {
    process.env.STATELESS = 'true';
    process.env.CORS_ORIGIN = 'https://example.test';
    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      for (const method of ['GET', 'DELETE', 'PUT'] as const) {
        const response = await transport.handler(
          createRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, { method }),
        );

        assert.strictEqual(response.status, 405);
        assert.strictEqual(response.headers.get('Allow'), 'POST, OPTIONS');
      }

      const optionsResponse = await transport.handler(
        createRequest({}, undefined, { method: 'OPTIONS' }),
      );
      assert.strictEqual(optionsResponse.status, 204);

      const postResponse = await transport.handler(
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
      assert.strictEqual(postResponse.status, 200);
    } finally {
      await transport.close();
    }
  });

  it('logs session events with hashed sessionRef instead of raw session ids', async () => {
    const logged: { data?: unknown; message: string }[] = [];
    ScopedLogger.prototype.info = function mockInfo(message: string, data?: unknown) {
      logged.push({ message, data });
    };

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      const sessionId = await initializeSession(transport);
      const sessionEvent = logged.find((entry) => entry.message === 'transport session event');

      assert.ok(sessionEvent);
      assert.deepStrictEqual(sessionEvent.data, {
        event: 'open',
        sessionRef: (sessionEvent.data as { sessionRef: string }).sessionRef,
      });
      assert.match((sessionEvent.data as { sessionRef: string }).sessionRef, /^[a-f0-9]{12}$/);
      assert.doesNotMatch(JSON.stringify(sessionEvent.data), new RegExp(sessionId, 'u'));
    } finally {
      await transport.close();
    }
  });

  it('logs structured request failure metadata when a request fails with a session id', async () => {
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

  it('rejects exposed binds without MCP_HTTP_TOKEN', async () => {
    process.env.HOST = '0.0.0.0';
    process.env.STATELESS = 'true';
    assert.throws(
      () => startWebStandardTransport(() => createServerInstance()),
      /requires MCP_HTTP_TOKEN/,
    );
  });
});

describe('startHttpTransport', () => {
  it('rejects bind conflicts during startup', async () => {
    const occupiedServer = createNodeServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = occupiedServer.address();
    assert.ok(address && typeof address === 'object');
    process.env.HOST = '127.0.0.1';
    process.env.PORT = String(address.port);

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
      delete process.env.HOST;
      delete process.env.PORT;
    }
  });

  it('starts and stops cleanly on an available port', async () => {
    await withAvailablePort(async (port) => {
      process.env.HOST = '127.0.0.1';
      process.env.PORT = String(port);

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'POST',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: createInitializeBody(),
        });

        assert.strictEqual(response.status, 200);
        assert.match(response.body, /"result"/);
        assert.strictEqual(firstHeaderValue(response.headers['access-control-allow-origin']), null);
      } finally {
        await transport.close();
      }
    });
  });

  it('rejects stateless GET requests with 405 and Allow header', async () => {
    await withAvailablePort(async (port) => {
      process.env.HOST = '127.0.0.1';
      process.env.PORT = String(port);
      process.env.STATELESS = 'true';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'GET',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'application/json, text/event-stream',
          },
        });

        assert.strictEqual(response.status, 405);
        assert.strictEqual(firstHeaderValue(response.headers.allow), 'POST, OPTIONS');
        assert.match(response.body, /Method Not Allowed/);
      } finally {
        await transport.close();
      }
    });
  });

  it('rejects stateless DELETE requests with 405', async () => {
    await withAvailablePort(async (port) => {
      process.env.HOST = '127.0.0.1';
      process.env.PORT = String(port);
      process.env.STATELESS = 'true';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'DELETE',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'application/json, text/event-stream',
          },
        });

        assert.strictEqual(response.status, 405);
        assert.strictEqual(firstHeaderValue(response.headers.allow), 'POST, OPTIONS');
        assert.match(response.body, /Method Not Allowed/);
      } finally {
        await transport.close();
      }
    });
  });

  it('accepts stateless POST initialize requests', async () => {
    await withAvailablePort(async (port) => {
      process.env.HOST = '127.0.0.1';
      process.env.PORT = String(port);
      process.env.STATELESS = 'true';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const response = await sendHttpRequest({
          method: 'POST',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: createInitializeBody(),
        });

        assert.strictEqual(response.status, 200);
        assert.match(response.body, /"result"/);
      } finally {
        await transport.close();
      }
    });
  });

  it('keeps stateful GET requests available', async () => {
    await withAvailablePort(async (port) => {
      process.env.HOST = '127.0.0.1';
      process.env.PORT = String(port);

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const sessionId = await initializeHttpSession(port);
        const response = await sendHttpRequest({
          method: 'GET',
          port,
          readBody: false,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'text/event-stream',
            'mcp-session-id': sessionId,
          },
        });

        assert.notStrictEqual(response.status, 405);
      } finally {
        await transport.close();
      }
    });
  });

  it('ignores invalid x-forwarded-for values when trust proxy is enabled', async () => {
    await withAvailablePort(async (port) => {
      process.env.HOST = '127.0.0.1';
      process.env.PORT = String(port);
      process.env.MCP_TRUST_PROXY = 'true';
      process.env.MCP_HTTP_RATE_LIMIT_RPS = '1';
      process.env.MCP_HTTP_RATE_LIMIT_BURST = '1';

      const transport = await startHttpTransport(() => createServerInstance());

      try {
        const first = await sendHttpRequest({
          method: 'POST',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'x-forwarded-for': 'junk-spoofed-a',
          },
          body: createInitializeBody(),
        });
        const second = await sendHttpRequest({
          method: 'POST',
          port,
          headers: {
            host: `127.0.0.1:${String(port)}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'x-forwarded-for': 'junk-spoofed-b',
          },
          body: createInitializeBody(),
        });

        assert.strictEqual(first.status, 200);
        assert.strictEqual(second.status, 429);
      } finally {
        await transport.close();
      }
    });
  });
});
