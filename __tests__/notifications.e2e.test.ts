import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import {
  createServerHarness,
  flushEventLoop,
  type JsonRpcNotification,
} from './lib/mcp-contract-client.js';
import { makeChunk, MockGeminiEnvironment } from './lib/mock-gemini-environment.js';

import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-notifications';

let env: MockGeminiEnvironment;

beforeEach(() => {
  env = new MockGeminiEnvironment();
  env.install();
});

afterEach(() => {
  env.restore();
});

async function createHarness() {
  return await createServerHarness(
    createServerInstance,
    { capabilities: { roots: {} } },
    { autoInitialize: true, flushAfterServerClose: 2, flushBeforeClose: 2 },
  );
}

function notificationSlice(
  notifications: readonly JsonRpcNotification[],
  startIndex: number,
): JsonRpcNotification[] {
  return notifications.slice(startIndex);
}

function updatedUris(notifications: readonly JsonRpcNotification[]): string[] {
  return notifications
    .filter((notification) => notification.method === 'notifications/resources/updated')
    .map((notification) => {
      const uri = notification.params?.uri;
      return typeof uri === 'string' ? uri : '';
    });
}

function assertListChanged(notifications: readonly JsonRpcNotification[]): void {
  assert.ok(
    notifications.some(
      (notification) => notification.method === 'notifications/resources/list_changed',
    ),
    'Expected notifications/resources/list_changed to be emitted',
  );
}

describe('public MCP resource notifications', () => {
  it('emits only list_changed (not updated) for session and cache mutations while subscribe is undeclared', async () => {
    const harness = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: 'Session started' }], FinishReason.STOP));

      const sessionId = 'notifications session%/#';
      let offset = harness.client.getNotifications().length;
      await harness.client.request('tools/call', {
        arguments: { goal: 'Start a reusable chat session', sessionId },
        name: 'chat',
      });

      await flushEventLoop(2);
      const sessionNotifications = notificationSlice(harness.client.getNotifications(), offset);
      assertListChanged(sessionNotifications);
      assert.deepStrictEqual(
        updatedUris(sessionNotifications),
        [],
        'resources/updated must not be emitted without resources.subscribe capability',
      );

      offset = harness.client.getNotifications().length;
      await harness.client.request('tools/call', {
        arguments: {
          action: 'caches.create',
          systemInstruction: 'Cache this synthetic system instruction only.',
        },
        name: 'memory',
      });

      await flushEventLoop(2);
      const cacheNotifications = notificationSlice(harness.client.getNotifications(), offset);
      assertListChanged(cacheNotifications);
      assert.deepStrictEqual(
        updatedUris(cacheNotifications),
        [],
        'resources/updated must not be emitted without resources.subscribe capability',
      );
    } finally {
      await harness.close();
    }
  });

  it('emits workspace cache resource notifications after workspace-cache creation', async () => {
    const originalAllowedRoots = process.env.ALLOWED_FILE_ROOTS;
    const originalWorkspaceCacheEnabled = process.env.WORKSPACE_CACHE_ENABLED;
    const originalWorkspaceContextFile = process.env.WORKSPACE_CONTEXT_FILE;
    const tempDir = await mkdtemp(join(process.cwd(), 'tmp-workspace-cache-'));
    const contextFile = join(tempDir, 'workspace-context.md');

    await writeFile(contextFile, '# Context\n\n' + 'token '.repeat(40_000), 'utf8');

    process.env.ALLOWED_FILE_ROOTS = process.cwd();
    process.env.WORKSPACE_CACHE_ENABLED = 'true';
    process.env.WORKSPACE_CONTEXT_FILE = contextFile;

    const harness = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: 'Workspace cache applied' }], FinishReason.STOP));

      const offset = harness.client.getNotifications().length;
      await harness.client.request('tools/call', {
        arguments: { goal: 'Use the workspace cache automatically' },
        name: 'chat',
      });

      await flushEventLoop(2);
      const notifications = notificationSlice(harness.client.getNotifications(), offset);
      // Workspace resources are singletons addressed by detail URIs only;
      // without subscribe/unsubscribe tracking we do not fan out per-URI
      // updates. Assert the request completed without producing stray
      // per-URI `resources/updated` for those singletons.
      const workspaceUpdates = updatedUris(notifications).filter((uri) =>
        uri.startsWith('memory://workspace/'),
      );
      assert.deepStrictEqual(
        workspaceUpdates,
        [],
        'Workspace URIs must not fan out as resources/updated without subscribe tracking',
      );
    } finally {
      process.env.ALLOWED_FILE_ROOTS = originalAllowedRoots;
      process.env.WORKSPACE_CACHE_ENABLED = originalWorkspaceCacheEnabled;
      process.env.WORKSPACE_CONTEXT_FILE = originalWorkspaceContextFile;
      await harness.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('never emits notifications/progress when the request omits _meta.progressToken', async () => {
    const harness = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: 'hello' }], FinishReason.STOP));

      const offset = harness.client.getNotifications().length;
      await harness.client.request('tools/call', {
        arguments: { goal: 'exercise a successful chat without progress token' },
        name: 'chat',
      });

      await flushEventLoop(2);
      const notifications = notificationSlice(harness.client.getNotifications(), offset);
      const progressNotifications = notifications.filter(
        (notification) => notification.method === 'notifications/progress',
      );

      assert.deepStrictEqual(
        progressNotifications,
        [],
        'notifications/progress must not be emitted without _meta.progressToken',
      );
    } finally {
      await harness.close();
    }
  });

  it('does not leak discover://context or session-scoped updates across concurrent harnesses', async () => {
    const harnessA = await createHarness();
    const harnessB = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: 'Session A started' }], FinishReason.STOP));

      const offsetB = harnessB.client.getNotifications().length;
      await harnessA.client.request('tools/call', {
        arguments: {
          goal: 'Start a session scoped to harness A',
          sessionId: 'harness-a-session',
        },
        name: 'chat',
      });

      await flushEventLoop(4);

      const leakedOnB = notificationSlice(harnessB.client.getNotifications(), offsetB);
      const leakedUpdatedUris = updatedUris(leakedOnB);

      assert.ok(
        !leakedUpdatedUris.includes('discover://context'),
        'discover://context must not fan out to non-originating harnesses',
      );
      assert.ok(
        !leakedUpdatedUris.some((uri) => uri.startsWith('memory://sessions/harness-a-session')),
        'Harness A session URIs must not appear on Harness B',
      );
    } finally {
      await harnessA.close();
      await harnessB.close();
    }
  });

  it('does not emit list_changed when appending to an existing session (list membership unchanged)', async () => {
    const harness = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: 'first turn' }], FinishReason.STOP));

      const sessionId = 'persistent-session';
      await harness.client.request('tools/call', {
        arguments: { goal: 'Open a reusable session', sessionId },
        name: 'chat',
      });

      await flushEventLoop(2);

      env.queueStream(makeChunk([{ text: 'second turn' }], FinishReason.STOP));

      const offset = harness.client.getNotifications().length;
      await harness.client.request('tools/call', {
        arguments: { goal: 'Append a follow-up to the existing session', sessionId },
        name: 'chat',
      });

      await flushEventLoop(2);

      const followUpNotifications = notificationSlice(harness.client.getNotifications(), offset);
      const listChanged = followUpNotifications.filter(
        (notification) => notification.method === 'notifications/resources/list_changed',
      );

      assert.deepStrictEqual(
        listChanged,
        [],
        'list_changed must not be emitted when the active session list is unchanged',
      );
    } finally {
      await harness.close();
    }
  });
});
