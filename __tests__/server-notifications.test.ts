import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getAI } from '../src/client.js';
import { ScopedLogger } from '../src/lib/logger.js';
import {
  createServerInstance,
  isKnownResourceUri,
  sendResourceChangedForServer,
} from '../src/server.js';
import { buildCreateCacheWork } from '../src/tools/memory.js';

const originalScopedLoggerWarn = Object.getOwnPropertyDescriptor(ScopedLogger.prototype, 'warn')
  ?.value as typeof ScopedLogger.prototype.warn;

afterEach(() => {
  ScopedLogger.prototype.warn = originalScopedLoggerWarn;
});

describe('server resource notifications', () => {
  it('recognizes registered static and dynamic resource URIs only', () => {
    assert.equal(isKnownResourceUri('discover://catalog'), true);
    assert.equal(isKnownResourceUri('memory://sessions'), true);
    assert.equal(isKnownResourceUri('memory://sessions/session-1'), true);
    assert.equal(isKnownResourceUri('memory://sessions/session-1/transcript'), true);
    assert.equal(isKnownResourceUri('memory://sessions/session-1/events'), true);
    assert.equal(isKnownResourceUri('memory://caches/cachedContents%2Fabc'), true);
    assert.equal(isKnownResourceUri('memory://sessions/session-1/unknown'), false);
    assert.equal(isKnownResourceUri('memory://bogus'), false);
    assert.equal(isKnownResourceUri('discover://unknown'), false);
  });

  it('drops unregistered resource notifications and logs a warning', () => {
    const warnings: string[] = [];
    ScopedLogger.prototype.warn = function warn(message: string): void {
      warnings.push(message);
    };

    let listChangedCalls = 0;
    const server = {
      isConnected: () => true,
      sendResourceListChanged: () => {
        listChangedCalls += 1;
      },
    } as unknown as McpServer;

    sendResourceChangedForServer(server, 'memory://unknown');

    assert.equal(listChangedCalls, 0);
    assert.deepStrictEqual(warnings, [
      'Blocked resource notification with unregistered URI: memory://unknown',
    ]);
  });

  it('emits list_changed for a known listUri', () => {
    let listChangedCalls = 0;
    const server = {
      isConnected: () => true,
      sendResourceListChanged: () => {
        listChangedCalls += 1;
      },
    } as unknown as McpServer;

    sendResourceChangedForServer(server, 'memory://sessions');

    assert.equal(listChangedCalls, 1);
  });

  it('is a no-op when listUri is undefined', () => {
    const warnings: string[] = [];
    ScopedLogger.prototype.warn = function warn(message: string): void {
      warnings.push(message);
    };

    let listChangedCalls = 0;
    const server = {
      isConnected: () => true,
      sendResourceListChanged: () => {
        listChangedCalls += 1;
      },
    } as unknown as McpServer;

    sendResourceChangedForServer(server, undefined);

    assert.equal(listChangedCalls, 0);
    assert.deepStrictEqual(warnings, []);
  });

  it('fans out one cache change notification per connected server instance', async () => {
    process.env.API_KEY ??= 'test-key-for-notifications';

    const first = createServerInstance();
    const second = createServerInstance();
    const firstServer = first.server as unknown as McpServer & {
      isConnected: () => boolean;
      sendResourceListChanged: () => void;
    };
    const secondServer = second.server as unknown as McpServer & {
      isConnected: () => boolean;
      sendResourceListChanged: () => void;
    };

    let firstCalls = 0;
    let secondCalls = 0;
    firstServer.isConnected = () => true;
    secondServer.isConnected = () => true;
    firstServer.sendResourceListChanged = () => {
      firstCalls += 1;
    };
    secondServer.sendResourceListChanged = () => {
      secondCalls += 1;
    };

    const client = getAI();
    const originalCreate = client.caches.create.bind(client.caches);
    client.caches.create = async () => ({
      name: 'cachedContents/fanout-test',
    });

    const createCacheWork = buildCreateCacheWork(async () => []);

    try {
      await createCacheWork(
        {
          systemInstruction: 'Notify connected servers.',
        },
        {
          mcpReq: {
            _meta: {},
            elicitInput: async () => ({ action: 'decline' }),
            log: async () => undefined,
            notify: async () => undefined,
            signal: new AbortController().signal,
          },
        } as never,
      );

      assert.strictEqual(firstCalls, 1);
      assert.strictEqual(secondCalls, 1);
    } finally {
      client.caches.create = originalCreate;
      await first.close();
      await second.close();
    }
  });
});
