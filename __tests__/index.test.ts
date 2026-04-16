import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeStartedRuntime, main, type MainDependencies, startCli } from '../src/index.js';
import type {
  HttpTransportResult,
  ServerInstance,
  WebStandardTransportResult,
} from '../src/transport.js';

interface MockProcess {
  argv: string[];
  exitCodes: number[];
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
}

function createMockProcess(): MockProcess & MainDependencies['process'] {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  return {
    argv: [],
    exitCodes: [],
    listeners,
    exit(code: number) {
      this.exitCodes.push(code);
    },
    off(event, listener) {
      const current = listeners.get(event) ?? [];
      listeners.set(
        event,
        current.filter((entry) => entry !== listener),
      );
      return this;
    },
    on(event, listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return this;
    },
  };
}

function createStdioServerInstance(
  options: {
    close?: () => Promise<void>;
    connect?: () => Promise<void>;
  } = {},
): ServerInstance {
  return {
    server: {
      connect: async () => {
        await options.connect?.();
      },
    },
    close: async () => {
      await options.close?.();
    },
  } as unknown as ServerInstance;
}

function getListenerCount(processLike: MockProcess, event: string): number {
  return processLike.listeners.get(event)?.length ?? 0;
}

async function emitProcessEvent(processLike: MockProcess, event: string, ...args: unknown[]) {
  const listeners = [...(processLike.listeners.get(event) ?? [])];
  for (const listener of listeners) {
    listener(...args);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

describe('startCli', () => {
  it('routes startup failures through fatal logging and exit', async () => {
    const processLike = createMockProcess();
    const fatalCalls: string[] = [];
    const deps: MainDependencies = {
      createEventStore: createEventStoreStub,
      createServerInstance: createServerInstanceStub,
      createStdioTransport: createStdioTransportStub,
      getTransportMode: () => 'http',
      logger: {
        info: () => undefined,
        fatal: (_context, message) => {
          fatalCalls.push(message);
        },
      },
      process: processLike,
      startHttpTransport: async () => {
        throw new Error('bind failed');
      },
      startWebStandardTransport: async () => {
        throw new Error('not used');
      },
    };

    await startCli(deps);

    assert.deepStrictEqual(processLike.exitCodes, [1]);
    assert.match(fatalCalls[0] ?? '', /Failed to start server: bind failed/);
  });
});

describe('closeStartedRuntime', () => {
  it('attempts every runtime close before failing', async () => {
    const calls: string[] = [];

    try {
      await closeStartedRuntime({
        stdioInstance: createStdioServerInstance({
          close: async () => {
            calls.push('stdio');
            throw new Error('stdio failed');
          },
        }),
        httpResult: {
          close: async () => {
            calls.push('http');
          },
        } as HttpTransportResult,
        webStandardResult: {
          close: async () => {
            calls.push('web');
            throw new Error('web failed');
          },
        } as WebStandardTransportResult,
      });
      assert.fail('Expected shutdown to fail');
    } catch (err) {
      assert.match(String(err), /Multiple shutdown failures/);
    }

    assert.deepStrictEqual(calls, ['stdio', 'http', 'web']);
  });
});

describe('main', () => {
  it('removes process handlers during shutdown so sequential startups do not accumulate listeners', async () => {
    const processLike = createMockProcess();
    const deps: MainDependencies = {
      createEventStore: createEventStoreStub,
      createServerInstance: () => createStdioServerInstance(),
      createStdioTransport: createStdioTransportStub,
      getTransportMode: () => 'stdio',
      logger: {
        info: () => undefined,
        fatal: () => undefined,
      },
      process: processLike,
      startHttpTransport: async () => {
        throw new Error('not used');
      },
      startWebStandardTransport: async () => {
        throw new Error('not used');
      },
    };

    await main(deps);

    assert.strictEqual(getListenerCount(processLike, 'SIGINT'), 1);
    assert.strictEqual(getListenerCount(processLike, 'SIGTERM'), 1);
    assert.strictEqual(getListenerCount(processLike, 'uncaughtException'), 1);
    assert.strictEqual(getListenerCount(processLike, 'unhandledRejection'), 1);

    await emitProcessEvent(processLike, 'SIGINT');

    assert.deepStrictEqual(processLike.exitCodes, [0]);
    assert.strictEqual(getListenerCount(processLike, 'SIGINT'), 0);
    assert.strictEqual(getListenerCount(processLike, 'SIGTERM'), 0);
    assert.strictEqual(getListenerCount(processLike, 'uncaughtException'), 0);
    assert.strictEqual(getListenerCount(processLike, 'unhandledRejection'), 0);

    processLike.exitCodes.length = 0;

    await main(deps);

    assert.strictEqual(getListenerCount(processLike, 'SIGINT'), 1);
    assert.strictEqual(getListenerCount(processLike, 'SIGTERM'), 1);
    assert.strictEqual(getListenerCount(processLike, 'uncaughtException'), 1);
    assert.strictEqual(getListenerCount(processLike, 'unhandledRejection'), 1);
  });
});

function createEventStoreStub() {
  throw new Error('not used');
}

function createServerInstanceStub() {
  throw new Error('not used');
}

function createStdioTransportStub() {
  return {} as MainDependencies['createStdioTransport'] extends () => infer T ? T : never;
}
