import assert from 'node:assert';
import { test } from 'node:test';

import { ResourceNotifier } from '../src/lib/resource-notifier.js';
import { sessionResourceUri, turnPartsUri } from '../src/resources/uris.js';
import { createSessionStore } from '../src/sessions.js';

interface MockServer {
  sendResourceListChanged: () => void;
  sendResourceUpdated: (params: { uri: string }) => Promise<void>;
  listChangedCallCount: number;
  updatedUris: string[];
}

function createMockServer(): MockServer {
  return {
    listChangedCallCount: 0,
    updatedUris: [],
    sendResourceListChanged(): void {
      this.listChangedCallCount++;
    },
    async sendResourceUpdated(params: { uri: string }): Promise<void> {
      this.updatedUris.push(params.uri);
    },
  };
}

test('ResourceNotifier is wired for sessions list changes', () => {
  // This test verifies that the notifier infrastructure is in place
  // to handle session list change notifications
  const mockServer = createMockServer();
  const notifier = new ResourceNotifier(mockServer);

  // Simulate a session list change notification
  void notifier.notifyListChanged();

  assert.equal(mockServer.listChangedCallCount, 1, 'notifier should call sendResourceListChanged');
});

test('ResourceNotifier is wired for turn parts updates', async () => {
  // This test verifies that the notifier can send targeted updates
  // for specific turn parts URIs
  const mockServer = createMockServer();
  const notifier = new ResourceNotifier(mockServer);

  const sessionId = 'test-session';
  const turnIndex = 0;
  const uri = turnPartsUri(sessionId, turnIndex);

  await notifier.notifyUpdated(uri);

  assert.equal(mockServer.updatedUris.length, 1, 'notifier should send one update');
  assert.equal(mockServer.updatedUris[0], uri, 'update URI should match turn parts URI');
});

test('ResourceNotifier is wired for session detail updates', async () => {
  // This test verifies that the notifier can send updates
  // for session detail URIs
  const mockServer = createMockServer();
  const notifier = new ResourceNotifier(mockServer);

  const sessionId = 'test-session';
  const uri = sessionResourceUri(sessionId);

  await notifier.notifyUpdated(uri);

  assert.equal(mockServer.updatedUris.length, 1, 'notifier should send one update');
  assert.equal(mockServer.updatedUris[0], uri, 'update URI should match session detail URI');
});

test('SessionStore subscribe routing integration', () => {
  // This test verifies that the SessionStore correctly notifies subscribers
  // when new turns are added or the session list changes
  const sessionStore = createSessionStore({ ttlMs: 60_000 });
  let lastEvent: { listChanged: boolean; turnPartsAdded?: unknown } | null = null;

  const unsubscribe = sessionStore.subscribe((event) => {
    lastEvent = event;
  });

  // Initialize a session
  sessionStore.initializeSession('test-session', 'interaction-123');

  // Append turn parts to trigger notification
  const parts = [
    {
      role: 'model' as const,
      parts: [{ text: 'test' }],
    },
  ];
  sessionStore.appendTurnParts('test-session', 0, parts, parts);

  assert.ok(lastEvent, 'subscriber should receive event');
  assert.equal(lastEvent?.listChanged, false, 'listChanged should be false for turn update');
  assert.equal(lastEvent?.turnPartsAdded?.sessionId, 'test-session', 'sessionId should match');
  assert.equal(lastEvent?.turnPartsAdded?.turnIndex, 0, 'turnIndex should match');

  unsubscribe();
});
