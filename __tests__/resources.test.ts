import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';
import {
  getSessionEventsResourceData,
  getSessionTranscriptResourceData,
  readSessionEventsResource,
  readSessionTranscriptResource,
  readToolsListResource,
  readWorkflowsListResource,
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
  it('reads tools://list with deterministic catalog contents', () => {
    const result = readToolsListResource('tools://list');
    assert.deepStrictEqual(parseResourceText(result), listDiscoveryEntries());
  });

  it('reads workflows://list with getting-started first', () => {
    const result = readWorkflowsListResource('workflows://list');
    const data = parseResourceText(result) as ReturnType<typeof listWorkflowEntries>;

    assert.deepStrictEqual(data, listWorkflowEntries());
    assert.strictEqual(data[0]?.name, 'getting-started');
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
    const result = readWorkspaceContextResource('workspace://context', {
      content: 'Workspace body',
      estimatedTokens: 42,
      sources: [],
    });

    assert.strictEqual(result.contents[0]?.uri, 'workspace://context');
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
      'sessions://sess-resource-transcript/transcript',
      'sess-resource-transcript',
    );
    assert.deepStrictEqual(
      parseResourceText(result),
      store.listSessionTranscriptEntries('sess-resource-transcript'),
    );
  });

  it('returns a stable error payload for a missing session transcript', () => {
    const store = createStore();
    assert.deepStrictEqual(getSessionTranscriptResourceData(store, 'missing-session'), {
      error: 'Session not found',
    });
  });
});

describe('session events resource', () => {
  it('reads event entries for an active session', () => {
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
      'sessions://sess-resource-events/events',
      'sess-resource-events',
    );
    assert.deepStrictEqual(
      parseResourceText(result),
      store.listSessionEventEntries('sess-resource-events'),
    );
  });

  it('returns a stable error payload for a missing session events resource', () => {
    const store = createStore();
    assert.deepStrictEqual(getSessionEventsResourceData(store, 'missing-session'), {
      error: 'Session not found',
    });
  });
});
