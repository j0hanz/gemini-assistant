import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import {
  logContext,
  Logger,
  maybeSummarizePayload,
  summarizeLogValue,
} from '../../src/lib/logger.js';

interface MockServer {
  failSend?: (enabled: boolean) => void;
  messages: unknown[];
  server: McpServer;
  setConnected: (connected: boolean) => void;
}

function createMockServer(): MockServer {
  const messages: unknown[] = [];
  const state = { connected: true, failSend: false, messages };

  return {
    messages,
    server: {
      isConnected: () => state.connected,
      sendLoggingMessage: async (message: unknown) => {
        if (state.failSend) {
          throw new Error('broadcast failed');
        }
        messages.push(message);
      },
    } as unknown as McpServer,
    failSend: (enabled: boolean) => {
      state.failSend = enabled;
    },
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
  delete process.env.LOG_PAYLOADS;
  delete process.env.LOG_DIR;
  delete process.env.LOG_TO_STDERR;
});

describe('Logger sink setup', () => {
  it('writes to stderr by default when LOG_DIR is unset', () => {
    delete process.env.LOG_DIR;
    delete process.env.LOG_TO_STDERR;
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-assistant-logger-'));

    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const logger = new Logger();
      logger.info('system', 'hello');
      assert.strictEqual(
        existsSync(join(tempDir, 'logs')),
        false,
        'no logs directory should be created when LOG_DIR is unset',
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('creates the configured LOG_DIR lazily on first write', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-assistant-logger-'));
    const targetDir = join(tempDir, 'logs');

    try {
      process.env.LOG_DIR = targetDir;
      const logger = new Logger();

      assert.strictEqual(existsSync(targetDir), false);

      logger.info('system', 'hello');
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(existsSync(targetDir), true);
      assert.match(readFileSync(join(targetDir, 'app.log'), 'utf8'), /"message":"hello"/);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('honours LOG_TO_STDERR=true even when LOG_DIR is set', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-assistant-logger-'));
    const targetDir = join(tempDir, 'logs');

    try {
      process.env.LOG_DIR = targetDir;
      process.env.LOG_TO_STDERR = 'true';
      const logger = new Logger();
      logger.info('system', 'hello');
      assert.strictEqual(
        existsSync(targetDir),
        false,
        'LOG_TO_STDERR should suppress LOG_DIR file sink',
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
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

describe('maybeSummarizePayload', () => {
  it('redacts sensitive keys and bounds verbose payloads', () => {
    const payload = {
      apiKey: 'secret-key',
      nested: {
        accessToken: 'secret-token',
        message: 'x'.repeat(2_100),
        promptTokenCount: 42,
      },
    };

    const sanitized = maybeSummarizePayload(payload, true) as {
      apiKey: string;
      nested: {
        accessToken: string;
        message: { truncated: boolean; type: string };
        promptTokenCount: number;
      };
    };

    assert.strictEqual(sanitized.apiKey, '[redacted]');
    assert.strictEqual(sanitized.nested.accessToken, '[redacted]');
    assert.strictEqual(sanitized.nested.promptTokenCount, 42);
    assert.deepStrictEqual(
      {
        truncated: sanitized.nested.message.truncated,
        type: sanitized.nested.message.type,
      },
      { truncated: true, type: 'string' },
    );
    assert.doesNotMatch(JSON.stringify(sanitized), /secret-key|secret-token/);
  });
});

describe('Logger forwarding', () => {
  it('redacts persisted and broadcast payload data at the logger chokepoint', async () => {
    const { logger, readEntries } = createBufferedLogger(true);
    const server = createMockServer();
    logger.attachServer(server.server);

    logger.info('system', 'hello', {
      api_key: 'secret-key',
      authorization: 'Bearer secret-token',
      nested: { cookie: 'session-cookie', ok: true },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const entry = readEntries()[0] as { data?: Record<string, unknown> } | undefined;
    assert.deepStrictEqual(entry?.data, {
      api_key: '[redacted]',
      authorization: '[redacted]',
      nested: { cookie: '[redacted]', ok: true },
    });
    assert.deepStrictEqual(server.messages[0], {
      level: 'info',
      logger: 'system',
      data: readEntries()[0],
    });
  });

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

  it('logs one local warning when broadcast delivery fails for attached servers', async () => {
    const { logger, readEntries } = createBufferedLogger();
    const healthyServer = createMockServer();
    const failingServer = createMockServer();
    failingServer.failSend?.(true);
    logger.attachServer(healthyServer.server);
    logger.attachServer(failingServer.server);

    logger.info('system', 'hello');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const entries = readEntries();
    const failureWarnings = entries.filter(
      (entry) =>
        entry.level === 'warn' &&
        entry.context === 'logger' &&
        entry.message === 'broadcast to 1 server(s) failed',
    );

    assert.strictEqual(healthyServer.messages.length, 1);
    assert.strictEqual(failureWarnings.length, 1);
    assert.deepStrictEqual(failureWarnings[0]?.data, { type: 'object', keys: ['count'] });
  });

  it('does not broadcast request-traced entries to attached servers', async () => {
    const { logger, readEntries } = createBufferedLogger();
    const server = createMockServer();
    logger.attachServer(server.server);

    logContext.run('trace-1', () => {
      logger.info('executor', 'Execution started', { args: { message: 'private' } });
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(server.messages.length, 0);
    assert.strictEqual(readEntries()[0]?.traceId, 'trace-1');
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
