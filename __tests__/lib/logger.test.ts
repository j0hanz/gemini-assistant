import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { Logger, summarizeLogValue, withToolLogging } from '../../src/lib/logger.js';

interface MockServer {
  messages: unknown[];
  server: McpServer;
  setConnected: (connected: boolean) => void;
}

function createMockServer(): MockServer {
  const messages: unknown[] = [];
  const state = { connected: true, messages };

  return {
    messages,
    server: {
      isConnected: () => state.connected,
      sendLoggingMessage: async (message: unknown) => {
        messages.push(message);
      },
    } as unknown as McpServer,
    setConnected: (connected: boolean) => {
      state.connected = connected;
    },
  };
}

function createBufferedLogger(verbosePayloads = false) {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += String(chunk);
  });

  return {
    logger: new Logger({ logStream: stream, verbosePayloads }),
    readEntries: () =>
      buffer
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

afterEach(() => {
  delete process.env.LOG_VERBOSE_PAYLOADS;
});

describe('summarizeLogValue', () => {
  it('summarizes strings, arrays, and objects deterministically', () => {
    assert.deepStrictEqual(summarizeLogValue('secret'), { type: 'string', length: 6 });
    assert.deepStrictEqual(summarizeLogValue([1, 2, 3]), { type: 'array', length: 3 });
    assert.deepStrictEqual(summarizeLogValue({ zebra: 1, alpha: 2 }), {
      type: 'object',
      keys: ['alpha', 'zebra'],
    });
  });

  it('summarizes only top-level keys for nested objects', () => {
    const summary = summarizeLogValue({
      nested: { secret: 'value' },
      user: { email: 'user@example.com' },
    });

    assert.deepStrictEqual(summary, {
      type: 'object',
      keys: ['nested', 'user'],
    });
    assert.doesNotMatch(JSON.stringify(summary), /secret|value|email|user@example.com/);
  });
});

describe('Logger forwarding', () => {
  it('forwards entries to all attached connected servers and detaches cleanly', async () => {
    const { logger } = createBufferedLogger();
    const serverA = createMockServer();
    const serverB = createMockServer();

    const detachA = logger.attachServer(serverA.server);
    logger.attachServer(serverB.server);

    logger.info('system', 'hello');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(serverA.messages.length, 1);
    assert.strictEqual(serverB.messages.length, 1);

    detachA();
    logger.info('system', 'again');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(serverA.messages.length, 1);
    assert.strictEqual(serverB.messages.length, 2);
  });

  it('skips disconnected servers', async () => {
    const { logger } = createBufferedLogger();
    const server = createMockServer();
    logger.attachServer(server.server);
    server.setConnected(false);

    logger.info('system', 'hello');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(server.messages.length, 0);
  });
});

describe('withToolLogging', () => {
  it('redacts args and results by default', async () => {
    const { logger, readEntries } = createBufferedLogger(false);
    const handler = withToolLogging(
      'ask',
      async (args: { prompt: string }) => ({ answer: `reply:${args.prompt}` }),
      { loggerInstance: logger },
    );

    await handler({ prompt: 'super-secret' });
    const entries = readEntries();
    const successData = entries[1]?.data as Record<string, unknown>;

    assert.deepStrictEqual(entries[0]?.data, {
      args: { type: 'object', keys: ['prompt'] },
    });
    assert.strictEqual(typeof successData?.durationMs, 'number');
    assert.deepStrictEqual(successData?.result, { type: 'object', keys: ['answer'] });
    assert.ok(!JSON.stringify(entries).includes('super-secret'));
  });

  it('logs raw args and results when verbose payload logging is enabled', async () => {
    const { logger, readEntries } = createBufferedLogger(true);
    const handler = withToolLogging(
      'ask',
      async (args: { prompt: string }) => ({ answer: `reply:${args.prompt}` }),
      { loggerInstance: logger },
    );

    await handler({ prompt: 'super-secret' });
    const entries = readEntries();
    const successData = entries[1]?.data as Record<string, unknown>;

    assert.deepStrictEqual(entries[0]?.data, {
      args: { prompt: 'super-secret' },
    });
    assert.strictEqual(typeof successData?.durationMs, 'number');
    assert.deepStrictEqual(successData?.result, { answer: 'reply:super-secret' });
  });
});
