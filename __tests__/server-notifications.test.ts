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
    assert.equal(isKnownResourceUri('session://'), true);
    assert.equal(isKnownResourceUri('session://session-1'), true);
    assert.equal(isKnownResourceUri('session://session-1/transcript'), true);
    assert.equal(isKnownResourceUri('session://session-1/events'), true);
    assert.equal(isKnownResourceUri('gemini://sessions/session-1/turns/0/parts'), true);
    assert.equal(isKnownResourceUri('session://session-1/unknown'), false);
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

    sendResourceChangedForServer(server, 'session://');

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
});
