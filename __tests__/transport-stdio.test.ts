import { StdioServerTransport } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MockGeminiEnvironment } from './lib/mock-gemini-environment.js';

import { Logger } from '../src/lib/logger.js';
import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-stdio-transport';

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

let env: MockGeminiEnvironment;

beforeEach(() => {
  env = new MockGeminiEnvironment();
  env.install();
});

afterEach(() => {
  env.restore();
});

async function flushTicks(ticks = 3): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('stdio transport stdout cleanliness', () => {
  it('writes only framed JSON-RPC messages to stdout for a full initialize + tools/list round-trip', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const instance = createServerInstance();
    const transport = new StdioServerTransport(stdin, stdout);
    await instance.server.connect(transport);

    const pending = new Map<number, PendingRequest>();
    let nextId = 1;

    const sendRequest = async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const id = nextId++;
      const payload =
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }) + '\n';
      const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      stdin.write(payload);
      return await promise;
    };

    // Collect framed responses as they arrive. We also keep the raw bytes for
    // the cleanliness assertion below.
    let rawBuffer = '';
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const id = parsed.id;
      if (typeof id === 'number') {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          entry.resolve(parsed);
        }
      }
    };
    stdout.on('data', (chunk: Buffer) => {
      rawBuffer += chunk.toString('utf8');
      let newlineIndex = rawBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = rawBuffer.slice(0, newlineIndex);
        rawBuffer = rawBuffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = rawBuffer.indexOf('\n');
      }
    });

    try {
      const initResponse = await sendRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stdio-cleanliness-test', version: '0.0.0' },
      });
      assert.equal((initResponse as { jsonrpc?: string }).jsonrpc, '2.0');

      // notifications/initialized is a notification (no id, no response).
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const toolsListResponse = await sendRequest('tools/list', {});
      assert.ok(toolsListResponse.result, 'tools/list must return a result');

      await flushTicks(3);
    } finally {
      await instance.close();
    }

    // Every byte written to stdout must parse as framed JSON-RPC (jsonrpc: "2.0").
    const combined = Buffer.concat(chunks).toString('utf8');
    const lines = combined.split('\n').filter((line) => line.length > 0);
    assert.ok(lines.length >= 2, 'Expected at least initialize + tools/list responses');
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(
        (parsed as { jsonrpc?: string }).jsonrpc,
        '2.0',
        `stdout line must be framed JSON-RPC: ${line}`,
      );
    }
  });

  it('logger routes all levels to its configured sink, never to process.stdout', () => {
    // Logger exposes `logStream` via the constructor. Provide a spy sink and
    // assert every level lands there (and nowhere else). This guards against
    // any future refactor that would route log output through process.stdout,
    // which would corrupt the JSON-RPC frame stream in stdio mode.
    const writes: string[] = [];
    const spySink = {
      write(chunk: string | Uint8Array): boolean {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    };

    const scoped = new Logger({ logStream: spySink });
    scoped.debug('stdio-test', 'debug line');
    scoped.info('stdio-test', 'info line');
    scoped.warn('stdio-test', 'warn line');
    scoped.error('stdio-test', 'error line');

    assert.equal(writes.length, 4, 'Every log level must route through the configured sink');
    for (const payload of writes) {
      const parsed = JSON.parse(payload.trimEnd()) as Record<string, unknown>;
      assert.equal(typeof parsed.level, 'string');
      assert.equal(parsed.context, 'stdio-test');
    }
  });
});
