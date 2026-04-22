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
  delete process.env.HOST;
  delete process.env.PORT;
  delete process.env.STATELESS;
  delete process.env.ALLOWED_HOSTS;
  ScopedLogger.prototype.error = originalScopedLoggerError;
  ScopedLogger.prototype.warn = originalScopedLoggerWarn;
  WebStandardStreamableHTTPServerTransport.prototype.handleRequest = originalWebHandleRequest;
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

  it('rejects mismatched Host headers for specific non-local binds', async () => {
    process.env.HOST = 'example.internal';
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

  it('warns when STATELESS=true is exposed without ALLOWED_HOSTS', async () => {
    const warnings: string[] = [];
    process.env.HOST = '0.0.0.0';
    process.env.STATELESS = 'true';
    ScopedLogger.prototype.warn = function mockWarn(message: string) {
      warnings.push(message);
    };

    const transport = await startWebStandardTransport(() => createServerInstance());

    try {
      assert.ok(warnings.some((message) => message.includes('without DNS rebinding protection')));
    } finally {
      await transport.close();
    }
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
        assert.strictEqual(firstHeaderValue(response.headers['access-control-allow-origin']), null);
      } finally {
        await transport.close();
      }
    });
  });
});
