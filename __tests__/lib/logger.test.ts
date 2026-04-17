import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { Logger, summarizeLogValue } from '../../src/lib/logger.js';

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

describe('ScopedLogger', () => {
  it('delegates all levels to the parent logger with a bound context', () => {
    const { logger, readEntries } = createBufferedLogger();
    const scoped = logger.child('ask');

    scoped.debug('debugging', { step: 1 });
    scoped.info('starting');
    scoped.warn('warning');
    scoped.error('failed');
    scoped.fatal('fatal');

    const entries = readEntries();
    assert.deepStrictEqual(
      entries.map((entry) => ({
        level: entry.level,
        context: entry.context,
        message: entry.message,
      })),
      [
        { level: 'debug', context: 'ask', message: 'debugging' },
        { level: 'info', context: 'ask', message: 'starting' },
        { level: 'warn', context: 'ask', message: 'warning' },
        { level: 'error', context: 'ask', message: 'failed' },
        { level: 'fatal', context: 'ask', message: 'fatal' },
      ],
    );
  });

  it('inherits verbose payload configuration through child()', () => {
    const { logger } = createBufferedLogger(true);
    const scoped = logger.child('ask');

    assert.strictEqual(scoped.getVerbosePayloads(), true);
  });
});
