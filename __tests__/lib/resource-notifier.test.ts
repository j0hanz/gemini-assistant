import assert from 'node:assert';
import { test } from 'node:test';

import { ResourceNotifier } from '../../src/lib/resource-notifier.js';

interface MockNotifierServer {
  sendResourceListChanged: () => void;
  sendResourceUpdated: (params: { uri: string }) => Promise<void>;
  listChangedCallCount: number;
  updatedCalls: { uri: string }[];
}

function createMockServer(): MockNotifierServer {
  return {
    listChangedCallCount: 0,
    updatedCalls: [],
    sendResourceListChanged(): void {
      this.listChangedCallCount++;
    },
    async sendResourceUpdated(params: { uri: string }): Promise<void> {
      this.updatedCalls.push(params);
    },
  };
}

test('notifyUpdated emits per-URI', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  await notifier.notifyUpdated('gemini://workspace/files/foo.ts');

  assert.strictEqual(server.listChangedCallCount, 0);
  assert.strictEqual(server.updatedCalls.length, 1);
  assert.strictEqual(server.updatedCalls[0]?.uri, 'gemini://workspace/files/foo.ts');
});

test('notifyListChanged emits collection notification', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  await notifier.notifyListChanged();

  assert.strictEqual(server.listChangedCallCount, 1);
  assert.strictEqual(server.updatedCalls.length, 0);
});

test('notifyFilesChanged storm-caps at >50 paths', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  const paths = Array.from({ length: 51 }, (_, i) => `file${i}.ts`);
  await notifier.notifyFilesChanged(paths);

  assert.strictEqual(server.listChangedCallCount, 1);
  assert.strictEqual(server.updatedCalls.length, 0);
});

test('notifyFilesChanged under cap emits per-path updates', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  const paths = Array.from({ length: 5 }, (_, i) => `file${i}.ts`);
  await notifier.notifyFilesChanged(paths);

  assert.strictEqual(server.listChangedCallCount, 0);
  assert.strictEqual(server.updatedCalls.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(server.updatedCalls[i]?.uri, `gemini://workspace/files/file${i}.ts`);
  }
});

test('dispose makes subsequent notifications no-op', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  notifier.dispose();
  await notifier.notifyUpdated('gemini://workspace/files/foo.ts');
  await notifier.notifyListChanged();
  await notifier.notifyFilesChanged(['bar.ts']);

  assert.strictEqual(server.listChangedCallCount, 0);
  assert.strictEqual(server.updatedCalls.length, 0);
});

test('notifyFilesChanged with empty paths array', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  await notifier.notifyFilesChanged([]);

  assert.strictEqual(server.listChangedCallCount, 0);
  assert.strictEqual(server.updatedCalls.length, 0);
});

test('notifyFilesChanged at exactly 50 paths does not storm-cap', async () => {
  const server = createMockServer();
  const notifier = new ResourceNotifier(server);

  const paths = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
  await notifier.notifyFilesChanged(paths);

  assert.strictEqual(server.listChangedCallCount, 0);
  assert.strictEqual(server.updatedCalls.length, 50);
});

test('notifyUpdated with error swallows exception', async () => {
  const server = createMockServer();
  server.sendResourceUpdated = async () => {
    throw new Error('Network error');
  };
  const notifier = new ResourceNotifier(server);

  // Should not throw
  await notifier.notifyUpdated('gemini://workspace/files/foo.ts');
});

test('notifyListChanged with error swallows exception', async () => {
  const server = createMockServer();
  server.sendResourceListChanged = () => {
    throw new Error('Network error');
  };
  const notifier = new ResourceNotifier(server);

  // Should not throw
  await notifier.notifyListChanged();
});
