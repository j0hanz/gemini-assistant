import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import { registerSessionResources } from '../../src/resources/sessions.js';
import { SESSIONS_LIST_URI } from '../../src/resources/uris.js';
import { createSessionStore } from '../../src/sessions.js';

type ReadCallback = (
  uri: URL,
) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>;

interface ResourceEntry {
  uriOrTemplate: string;
  callback: ReadCallback;
}

function makeMockServer() {
  const entries: ResourceEntry[] = [];
  return {
    registerResource: (
      _name: string,
      uriOrTemplate: unknown,
      _config: unknown,
      callback: ReadCallback,
    ) => {
      // Static resource: plain string. Template resource: ResourceTemplate with .uriTemplate.template
      const template =
        typeof uriOrTemplate === 'string'
          ? uriOrTemplate
          : (uriOrTemplate as { uriTemplate: { template: string } }).uriTemplate.template;
      entries.push({ uriOrTemplate: template, callback });
    },
    async read(uri: string) {
      // Try exact match first, then template match
      const exact = entries.find((e) => e.uriOrTemplate === uri);
      if (exact) return exact.callback(new URL(uri));

      // Template match: convert {var} placeholders to regex
      for (const entry of entries) {
        const pattern = entry.uriOrTemplate.replace(/\{[^}]+\}/g, '[^/]+');
        if (new RegExp(`^${pattern}$`).exec(uri)) {
          return entry.callback(new URL(uri));
        }
      }
      throw new Error(`No resource registered for ${uri}`);
    },
    size() {
      return entries.length;
    },
  };
}

test('session resources — registers gemini:// session resources', () => {
  const mockSessionStore = createSessionStore();
  const mockServer = makeMockServer();

  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });
  assert(mockServer.size() > 0);
});

test('session resources — reads sessions list', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('session-123', 'interaction-123');

  const mockServer = makeMockServer();
  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });

  const result = await mockServer.read(SESSIONS_LIST_URI);

  assert(result.contents);
  assert(result.contents.length > 0);

  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart);
  assert(Array.isArray(content));
  assert(content.includes('session-123'));
});

test('session resources — reads session detail with template param', async () => {
  const mockSessionStore = createSessionStore();
  mockSessionStore.initializeSession('abc123', 'interaction-xyz');

  const mockServer = makeMockServer();
  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });

  const result = await mockServer.read('gemini://session/abc123');

  assert(result.contents);

  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart);
  assert.strictEqual(content.sessionId, 'abc123');
  assert.strictEqual(content.interactionId, 'interaction-xyz');
  assert(typeof content.createdAt === 'string');
  assert(typeof content.turnCount === 'number');
});

test('session resources — reads turn parts with invalid sessionId', async () => {
  const mockSessionStore = createSessionStore();

  const mockServer = makeMockServer();
  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });

  try {
    await mockServer.read('gemini://session/nonexistent/turn/0/parts');
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

  const mockServer = makeMockServer();
  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });

  const result = await mockServer.read('gemini://session/session-456/transcript');

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

  const mockServer = makeMockServer();
  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });

  const result = await mockServer.read('gemini://session/session-789/events');

  assert(result.contents);
  assert.strictEqual(result.contents[0].mimeType, 'application/json');

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

  const mockServer = makeMockServer();
  registerSessionResources(mockServer as never, { sessionStore: mockSessionStore });

  try {
    await mockServer.read('gemini://session/session-000/turn/0/grounding');
    assert.fail('Should have thrown ProtocolError');
  } catch (error) {
    assert(error instanceof ProtocolError);
    assert.strictEqual(error.code, ProtocolErrorCode.ResourceNotFound);
  }
});
