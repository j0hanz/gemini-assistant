import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { startWebStandardTransport } from '../src/transport.js';

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
    server.connect = (async (transport) => {
      if (options.connectDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.connectDelayMs));
      }
      if (options.failConnect) {
        throw new Error('connect failed');
      }
      return await originalConnect(transport);
    }) as typeof server.connect;
  }

  return {
    server,
    close: async () => {
      options.onClose?.();
      await server.close();
    },
  };
}

function createRequest(body: unknown, sessionId?: string): Request {
  return new Request('http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
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
  delete process.env.MCP_MAX_TRANSPORT_SESSIONS;
  delete process.env.MCP_STATELESS;
  delete process.env.MCP_TRANSPORT_SESSION_TTL_MS;
});

describe('startWebStandardTransport', () => {
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
