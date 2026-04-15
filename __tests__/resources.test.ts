import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';
import {
  getSessionTranscriptResourceData,
  readSessionTranscriptResource,
  readToolsListResource,
  readWorkflowsListResource,
} from '../src/server-content.js';
import {
  appendSessionTranscript,
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
