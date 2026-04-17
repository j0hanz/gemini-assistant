import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';
import {
  getSessionEventsResourceData,
  getSessionTranscriptResourceData,
  readDiscoverCatalogResource,
  readDiscoverWorkflowsResource,
  readSessionEventsResource,
  readSessionTranscriptResource,
  readWorkspaceContextResource,
  renderWorkspaceContextMarkdown,
} from '../src/resources.js';
import { createSessionStore, type SessionStore } from '../src/sessions.js';

function parseResourceText(result: { contents: { text: string }[] }) {
  return JSON.parse(result.contents[0]?.text ?? 'null') as unknown;
}

function mockChat(label = 'chat') {
  return { _label: label } as unknown as never;
}

function createStore(): SessionStore {
  return createSessionStore();
}

describe('discovery resources', () => {
  it('reads discover://catalog with deterministic catalog contents and markdown rendering', () => {
    const result = readDiscoverCatalogResource('discover://catalog');
    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(parseResourceText(result), listDiscoveryEntries());
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /^# Discovery Catalog/m);
    assert.match(result.contents[1]?.text ?? '', /## Tools/);
  });

  it('reads discover://workflows with start-here first and markdown rendering', () => {
    const result = readDiscoverWorkflowsResource('discover://workflows');
    const data = parseResourceText(result) as ReturnType<typeof listWorkflowEntries>;

    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(data, listWorkflowEntries());
    assert.strictEqual(data[0]?.name, 'start-here');
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /^# Workflow Catalog/m);
    assert.match(result.contents[1]?.text ?? '', /### start-here/);
  });
});

describe('workspace context resource', () => {
  it('renders markdown with token count, sources, and content', () => {
    const markdown = renderWorkspaceContextMarkdown({
      content: '## Project\n\nSome assembled context.',
      estimatedTokens: 123,
      sources: ['C:/repo/README.md', 'C:/repo/src/index.ts'],
    });

    assert.match(markdown, /^# Workspace Context/m);
    assert.match(markdown, /Estimated tokens: 123/);
    assert.match(markdown, /## Sources/);
    assert.match(markdown, /- C:\/repo\/README\.md/);
    assert.match(markdown, /- C:\/repo\/src\/index\.ts/);
    assert.match(markdown, /## Content/);
    assert.match(markdown, /Some assembled context\./);
  });

  it('returns workspace context as markdown text content', () => {
    const result = readWorkspaceContextResource('memory://workspace/context', {
      content: 'Workspace body',
      estimatedTokens: 42,
      sources: [],
    });

    assert.strictEqual(result.contents[0]?.uri, 'memory://workspace/context');
    assert.match(result.contents[0]?.text ?? '', /^# Workspace Context/m);
    assert.throws(() => {
      JSON.parse(result.contents[0]?.text ?? '');
    });
  });
});

describe('session transcript resource', () => {
  it('reads transcript entries for an active session', () => {
    const store = createStore();
    store.setSession('sess-resource-transcript', mockChat('resource-transcript'));
    store.appendSessionTranscript('sess-resource-transcript', {
      role: 'user',
      text: 'Hello',
      timestamp: 1,
    });
    store.appendSessionTranscript('sess-resource-transcript', {
      role: 'assistant',
      text: 'Hi there',
      timestamp: 2,
    });

    const result = readSessionTranscriptResource(
      store,
      'memory://sessions/sess-resource-transcript/transcript',
      'sess-resource-transcript',
    );
    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(
      parseResourceText(result),
      store.listSessionTranscriptEntries('sess-resource-transcript'),
    );
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /# Session Transcript `sess-resource-transcript`/);
    assert.match(result.contents[1]?.text ?? '', /## user/);
    assert.match(result.contents[1]?.text ?? '', /## assistant/);
  });

  it('renders a not-found error for a missing session transcript', () => {
    const store = createStore();
    assert.throws(
      () => readSessionTranscriptResource(store, 'memory://sessions/missing/transcript', 'missing'),
      { message: /not found/i },
    );
  });

  it('throws ProtocolError for a missing session transcript', () => {
    const store = createStore();
    assert.throws(() => getSessionTranscriptResourceData(store, 'missing-session'), {
      message: /not found/i,
    });
  });
});

describe('session events resource', () => {
  it('reads event entries for an active session with JSON and markdown renderings', () => {
    const store = createStore();
    store.setSession('sess-resource-events', mockChat('resource-events'));
    store.appendSessionEvent('sess-resource-events', {
      request: { message: 'Hello', toolProfile: 'search' },
      response: {
        text: 'Hi there',
        data: { status: 'ok' },
        schemaWarnings: ['normalized inspection summary'],
        thoughts: 'Reasoning summary',
        toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
        usage: { totalTokenCount: 12 },
      },
      timestamp: 1,
    });

    const result = readSessionEventsResource(
      store,
      'memory://sessions/sess-resource-events/events',
      'sess-resource-events',
    );
    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(
      parseResourceText(result),
      store.listSessionEventEntries('sess-resource-events'),
    );
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /# Session Events `sess-resource-events`/);
    assert.match(result.contents[1]?.text ?? '', /- Message: Hello/);
    assert.match(result.contents[1]?.text ?? '', /### Response/);
    assert.match(result.contents[1]?.text ?? '', /- tool_call \(GOOGLE_SEARCH_WEB\)/);
  });

  it('throws ProtocolError for a missing session events resource', () => {
    const store = createStore();
    assert.throws(
      () => readSessionEventsResource(store, 'memory://sessions/missing/events', 'missing'),
      { message: /not found/i },
    );
  });

  it('throws ProtocolError for a missing session events data', () => {
    const store = createStore();
    assert.throws(() => getSessionEventsResourceData(store, 'missing-session'), {
      message: /not found/i,
    });
  });
});
