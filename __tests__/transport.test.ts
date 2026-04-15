import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { startWebStandardTransport } from '../src/transport.js';

function createServerInstance() {
  const server = new McpServer(
    { name: 'transport-test', version: '0.0.1' },
    {
      capabilities: {
        logging: {},
        tasks: {
          requests: { tools: { call: {} } },
          taskStore: new InMemoryTaskStore(),
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
    },
  );

  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Bun;
  delete process.env.MCP_STATELESS;
});

describe('startWebStandardTransport', () => {
  it('returns 404 for unknown stateful sessions', async () => {
    process.env.MCP_STATELESS = 'false';
    const transport = await startWebStandardTransport(createServerInstance);

    try {
      const response = await transport.handler(
        new Request('http://127.0.0.1:3000/mcp', {
          method: 'POST',
          headers: {
            host: '127.0.0.1:3000',
            'mcp-session-id': 'missing-session',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        }),
      );

      assert.strictEqual(response.status, 404);
      assert.match(await response.text(), /Session not found/);
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

    const transport = await startWebStandardTransport(createServerInstance);
    await transport.close();

    assert.strictEqual(stopCalls, 1);
  });
});
