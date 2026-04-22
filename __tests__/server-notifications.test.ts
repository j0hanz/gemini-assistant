import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ScopedLogger } from '../src/lib/logger.js';
import { isKnownResourceUri, sendResourceChangedForServer } from '../src/server.js';

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

  it('drops unregistered resource notifications and logs a warning', async () => {
    const warnings: string[] = [];
    ScopedLogger.prototype.warn = function warn(message: string): void {
      warnings.push(message);
    };

    const updatedUris: string[] = [];
    let listChangedCalls = 0;
    const server = {
      isConnected: () => true,
      sendResourceListChanged: () => {
        listChangedCalls += 1;
      },
      server: {
        sendResourceUpdated: async ({ uri }: { uri: string }) => {
          updatedUris.push(uri);
        },
      },
    } as unknown as McpServer;

    sendResourceChangedForServer(server, 'memory://unknown', ['memory://sessions/session-1']);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(listChangedCalls, 0);
    assert.deepStrictEqual(updatedUris, []);
    assert.deepStrictEqual(warnings, [
      'Blocked resource notification with unregistered URI: memory://unknown',
    ]);
  });

  it('emits list_changed and never updated for a known listUri', async () => {
    const updatedUris: string[] = [];
    let listChangedCalls = 0;
    const server = {
      isConnected: () => true,
      sendResourceListChanged: () => {
        listChangedCalls += 1;
      },
      server: {
        sendResourceUpdated: async ({ uri }: { uri: string }) => {
          updatedUris.push(uri);
        },
      },
    } as unknown as McpServer;

    sendResourceChangedForServer(server, 'memory://sessions', [
      'memory://sessions/session-1',
      'memory://sessions/session-1/transcript',
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(listChangedCalls, 1);
    assert.deepStrictEqual(
      updatedUris,
      [],
      'resources/updated must never be emitted without resources.subscribe capability',
    );
  });
});
