import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeStartedRuntime, main, type MainDependencies, startCli } from '../src/index.js';
import { logger } from '../src/lib/logger.js';
import { createServerInstance } from '../src/server.js';
import type {
  HttpTransportResult,
  ServerInstance,
  WebStandardTransportResult,
} from '../src/transport.js';

const originalAttachServer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(logger),
  'attachServer',
)?.value as typeof logger.attachServer;
const originalServerClose = Object.getOwnPropertyDescriptor(McpServer.prototype, 'close')
  ?.value as typeof McpServer.prototype.close;

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

afterEach(() => {
  logger.attachServer = function restoreAttachServer(server) {
    return originalAttachServer.call(this, server);
  };
  McpServer.prototype.close = originalServerClose;
});

describe('startCli', () => {
  it('routes startup failures through fatal logging and exit', async () => {
    const processLike = createMockProcess();
    const fatalCalls: string[] = [];
    const deps: MainDependencies = {
      createEventStore: createEventStoreStub,
      createServerInstance: createServerInstanceStub,
      createStdioTransport: createStdioTransportStub,
      getApiKey: () => 'test-key',
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
        } as unknown as WebStandardTransportResult,
      });
      assert.fail('Expected shutdown to fail');
    } catch (err) {
      assert.match(String(err), /Multiple shutdown failures/);
    }

    assert.deepStrictEqual(calls, ['stdio', 'http', 'web']);
  });

  it('propagates a single createServerInstance close failure through runtime shutdown wrapping', async () => {
    McpServer.prototype.close = async function mockClose() {
      throw new Error('close boom');
    };

    const directInstance = createServerInstance();
    const runtimeInstance = createServerInstance();

    await assert.rejects(() => directInstance.close(), /close: server\.close failed: close boom/);
    await assert.rejects(
      () => closeStartedRuntime({ stdioInstance: runtimeInstance }),
      /stdio transport shutdown failed: close: server\.close failed: close boom/,
    );
  });

  it('rethrows AggregateError when both cleanup and server.close fail', async () => {
    logger.attachServer = () => {
      return () => {
        throw new Error('detach boom');
      };
    };
    McpServer.prototype.close = async function mockClose() {
      throw new Error('close boom');
    };

    const instance = createServerInstance();

    await assert.rejects(
      () => instance.close(),
      (err: unknown) =>
        err instanceof AggregateError &&
        err.message === 'Server instance shutdown failed' &&
        err.errors.length === 2,
    );
  });
});

describe('main', () => {
  it('exits before transport startup when API_KEY is missing', async () => {
    const processLike = createMockProcess();
    const fatalCalls: { context: string; message: string }[] = [];
    let transportStarted = false;
    const deps: MainDependencies = {
      createEventStore: createEventStoreStub,
      createServerInstance: createServerInstanceStub,
      createStdioTransport: createStdioTransportStub,
      getApiKey: () => {
        throw new Error('API_KEY is required');
      },
      getTransportMode: () => 'http',
      logger: {
        info: () => undefined,
        fatal: (context, message) => {
          fatalCalls.push({ context, message });
        },
      },
      process: processLike,
      startHttpTransport: async () => {
        transportStarted = true;
        throw new Error('not used');
      },
      startWebStandardTransport: async () => {
        throw new Error('not used');
      },
    };

    await main(deps);

    assert.strictEqual(transportStarted, false);
    assert.deepStrictEqual(processLike.exitCodes, [1]);
    assert.deepStrictEqual(fatalCalls, [
      { context: 'system', message: 'Configuration: API_KEY is required' },
    ]);
  });

  it('closes the stdio server instance when connect fails', async () => {
    const processLike = createMockProcess();
    let closeCalls = 0;
    const deps: MainDependencies = {
      createEventStore: createEventStoreStub,
      createServerInstance: () =>
        createStdioServerInstance({
          connect: async () => {
            throw new Error('connect failed');
          },
          close: async () => {
            closeCalls++;
          },
        }),
      createStdioTransport: createStdioTransportStub,
      getApiKey: () => 'test-key',
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

    await assert.rejects(() => main(deps), /connect failed/);
    assert.strictEqual(closeCalls, 1);
    assert.deepStrictEqual(processLike.exitCodes, []);
  });

  it('removes process handlers during shutdown so sequential startups do not accumulate listeners', async () => {
    const processLike = createMockProcess();
    const deps: MainDependencies = {
      createEventStore: createEventStoreStub,
      createServerInstance: () => createStdioServerInstance(),
      createStdioTransport: createStdioTransportStub,
      getApiKey: () => 'test-key',
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
  return {} as ReturnType<MainDependencies['createEventStore']>;
}

function createServerInstanceStub() {
  return {} as ServerInstance;
}

function createStdioTransportStub() {
  return {} as MainDependencies['createStdioTransport'] extends () => infer T ? T : never;
}
