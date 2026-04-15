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
} from '../src/resources.js';
import {
  appendSessionEvent,
  appendSessionTranscript,
  listSessionEventEntries,
  listSessionTranscriptEntries,
  setSession,
} from '../src/sessions.js';

function parseResourceText(result: { contents: { text: string }[] }) {
  return JSON.parse(result.contents[0]?.text ?? 'null') as unknown;
}

function mockChat(label = 'chat') {
  return { _label: label } as unknown as never;
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

describe('session transcript resource', () => {
  it('reads transcript entries for an active session', () => {
    setSession('sess-resource-transcript', mockChat('resource-transcript'));
    appendSessionTranscript('sess-resource-transcript', {
      role: 'user',
      text: 'Hello',
      timestamp: 1,
    });
    appendSessionTranscript('sess-resource-transcript', {
      role: 'assistant',
      text: 'Hi there',
      timestamp: 2,
    });

    const result = readSessionTranscriptResource(
      'sessions://sess-resource-transcript/transcript',
      'sess-resource-transcript',
    );
    assert.deepStrictEqual(
      parseResourceText(result),
      listSessionTranscriptEntries('sess-resource-transcript'),
    );
  });

  it('returns a stable error payload for a missing session transcript', () => {
    assert.deepStrictEqual(getSessionTranscriptResourceData('missing-session'), {
      error: 'Session not found',
    });
  });
});

describe('session events resource', () => {
  it('reads event entries for an active session', () => {
    setSession('sess-resource-events', mockChat('resource-events'));
    appendSessionEvent('sess-resource-events', {
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
      'sessions://sess-resource-events/events',
      'sess-resource-events',
    );
    assert.deepStrictEqual(
      parseResourceText(result),
      listSessionEventEntries('sess-resource-events'),
    );
  });

  it('returns a stable error payload for a missing session events resource', () => {
    assert.deepStrictEqual(getSessionEventsResourceData('missing-session'), {
      error: 'Session not found',
    });
  });
});
