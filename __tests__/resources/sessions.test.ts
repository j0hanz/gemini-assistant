import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import { registerSessionResources } from '../../src/resources/sessions.js';
import { SESSIONS_LIST_URI } from '../../src/resources/uris.js';
import { createSessionStore } from '../../src/sessions.js';

test('session resources — registers gemini:// session resources', () => {
  const mockSessionStore = createSessionStore();
  const mockServer = {
    setResourceContentsHandler: (_handler: (request: { uri: string }) => Promise<unknown>) => {
      // Mock implementation
    },
  };

  // Should not throw
  registerSessionResources(mockServer, { sessionStore: mockSessionStore });
  assert.ok(true);
});

test('session resources — reads sessions list', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('session-123', 'interaction-123');

  let capturedHandler: ((request: { uri: string }) => Promise<unknown>) | undefined;
  const mockServer = {
    setResourceContentsHandler: (handler: (request: { uri: string }) => Promise<unknown>) => {
      capturedHandler = handler;
    },
  };

  registerSessionResources(mockServer, { sessionStore: mockSessionStore });

  assert(capturedHandler);

  const result = (await capturedHandler({ uri: SESSIONS_LIST_URI })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert(result.contents.length > 0);

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart);
  assert(Array.isArray(content));
  assert(content.includes('session-123'));
});

test('session resources — reads session detail with template params', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('abc123', 'interaction-xyz');

  let capturedHandler: ((request: { uri: string }) => Promise<unknown>) | undefined;
  const mockServer = {
    setResourceContentsHandler: (handler: (request: { uri: string }) => Promise<unknown>) => {
      capturedHandler = handler;
    },
  };

  registerSessionResources(mockServer, { sessionStore: mockSessionStore });

  assert(capturedHandler);

  const result = (await capturedHandler({
    uri: 'gemini://session/abc123',
  })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart);
  assert.strictEqual(content.sessionId, 'abc123');
  assert.strictEqual(content.interactionId, 'interaction-xyz');
  assert(typeof content.createdAt === 'string');
  assert(typeof content.turnCount === 'number');
});

test('session resources — reads turn parts with invalid sessionId throws ProtocolError', async () => {
  const mockSessionStore = createSessionStore();

  let capturedHandler: ((request: { uri: string }) => Promise<unknown>) | undefined;
  const mockServer = {
    setResourceContentsHandler: (handler: (request: { uri: string }) => Promise<unknown>) => {
      capturedHandler = handler;
    },
  };

  registerSessionResources(mockServer, { sessionStore: mockSessionStore });

  assert(capturedHandler);

  try {
    await capturedHandler({
      uri: 'gemini://session/nonexistent/turn/0/parts',
    });
    assert.fail('Should have thrown ProtocolError');
  } catch (error) {
    assert(error instanceof ProtocolError);
    assert.strictEqual(error.code, ProtocolErrorCode.ResourceNotFound);
  }
});

test('session resources — reads session transcript', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('session-456', 'interaction-456');
  mockSessionStore.appendSessionTranscript('session-456', {
    role: 'user',
    text: 'Hello',
    timestamp: Date.now(),
  });

  let capturedHandler: ((request: { uri: string }) => Promise<unknown>) | undefined;
  const mockServer = {
    setResourceContentsHandler: (handler: (request: { uri: string }) => Promise<unknown>) => {
      capturedHandler = handler;
    },
  };

  registerSessionResources(mockServer, { sessionStore: mockSessionStore });

  assert(capturedHandler);

  const result = (await capturedHandler({
    uri: 'gemini://session/session-456/transcript',
  })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert.strictEqual(result.contents[0].mimeType, 'text/markdown');
  assert(result.contents[0].text.includes('# Transcript'));
  assert(result.contents[0].text.includes('Hello'));
});

test('session resources — reads session events', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('session-789', 'interaction-789');
  mockSessionStore.appendSessionEvent('session-789', {
    request: { message: 'test message' },
    response: { text: 'test response' },
    timestamp: Date.now(),
  });

  let capturedHandler: ((request: { uri: string }) => Promise<unknown>) | undefined;
  const mockServer = {
    setResourceContentsHandler: (handler: (request: { uri: string }) => Promise<unknown>) => {
      capturedHandler = handler;
    },
  };

  registerSessionResources(mockServer, { sessionStore: mockSessionStore });

  assert(capturedHandler);

  const result = (await capturedHandler({
    uri: 'gemini://session/session-789/events',
  })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert.strictEqual(result.contents[0].mimeType, 'application/json');

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart);
  assert(Array.isArray(content));
  assert.strictEqual(content.length, 1);
  assert.strictEqual(content[0].request.message, 'test message');
});

test('session resources — turn grounding returns not found for missing turn', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('session-000', 'interaction-000');

  let capturedHandler: ((request: { uri: string }) => Promise<unknown>) | undefined;
  const mockServer = {
    setResourceContentsHandler: (handler: (request: { uri: string }) => Promise<unknown>) => {
      capturedHandler = handler;
    },
  };

  registerSessionResources(mockServer, { sessionStore: mockSessionStore });

  assert(capturedHandler);

  try {
    await capturedHandler({
      uri: 'gemini://session/session-000/turn/0/grounding',
    });
    assert.fail('Should have thrown ProtocolError');
  } catch (error) {
    assert(error instanceof ProtocolError);
    assert.strictEqual(error.code, ProtocolErrorCode.ResourceNotFound);
  }
});
