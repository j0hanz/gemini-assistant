import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Interactions } from '@google/genai';

import {
  builtInsToInteractionTools,
  createBackgroundInteraction,
  extractTextFromInteraction,
  interactionToStreamResult,
  pollUntilComplete,
} from '../../src/lib/interactions.js';
import { MockGeminiEnvironment } from './mock-gemini-environment.js';

function makeInteraction(
  id: string,
  status: Interactions.Interaction['status'],
  outputs: Interactions.Content[] = [],
): Interactions.Interaction {
  return {
    id,
    status,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    outputs,
  };
}

function makeTextContent(text: string): Interactions.TextContent {
  return { type: 'text', text };
}

describe('builtInsToInteractionTools', () => {
  it('maps known built-ins to tool objects', () => {
    const tools = builtInsToInteractionTools(['googleSearch', 'urlContext', 'codeExecution']);

    assert.deepStrictEqual(tools, [
      { type: 'google_search' },
      { type: 'url_context' },
      { type: 'code_execution' },
    ]);
  });

  it('silently ignores unknown built-in names', () => {
    const tools = builtInsToInteractionTools(['unknown', 'googleSearch']);

    assert.deepStrictEqual(tools, [{ type: 'google_search' }]);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(builtInsToInteractionTools([]), []);
  });
});

describe('createBackgroundInteraction', () => {
  const env = new MockGeminiEnvironment();

  before(() => env.install());
  after(() => env.restore());

  it('calls interactions.create and returns the queued interaction', async () => {
    const expected = makeInteraction('ia-1', 'in_progress');
    env.queueInteraction(expected);

    const result = await createBackgroundInteraction({
      model: 'gemini-3-flash-preview',
      input: 'test input',
    });

    assert.strictEqual(result.id, 'ia-1');
    assert.strictEqual(result.status, 'in_progress');
  });
});

describe('pollUntilComplete', () => {
  const env = new MockGeminiEnvironment();

  before(() => env.install());
  after(() => env.restore());

  it('returns immediately when the first poll returns completed', async () => {
    const initial = makeInteraction('ia-2', 'in_progress');
    const done = makeInteraction('ia-2', 'completed', [makeTextContent('result')]);
    env.queueInteraction(initial);
    env.queuePollResponses('ia-2', done);

    await createBackgroundInteraction({ model: 'gemini-3-flash-preview', input: 'q' });
    const result = await pollUntilComplete('ia-2');

    assert.strictEqual(result.status, 'completed');
  });

  it('cancels and throws when the abort signal is already set', async () => {
    const initial = makeInteraction('ia-3', 'in_progress');
    env.queueInteraction(initial);
    env.queuePollResponses('ia-3', initial);

    const ac = new AbortController();
    ac.abort();

    await createBackgroundInteraction({ model: 'gemini-3-flash-preview', input: 'q' });
    await assert.rejects(
      () => pollUntilComplete('ia-3', ac.signal),
      (err: Error) => err.message.includes('cancelled'),
    );
    assert.ok(env.cancelledInteractionIds.includes('ia-3'));
  });
});

describe('extractTextFromInteraction', () => {
  it('joins text outputs', () => {
    const interaction = makeInteraction('ia-4', 'completed', [
      makeTextContent('hello '),
      makeTextContent('world'),
    ]);

    assert.strictEqual(extractTextFromInteraction(interaction), 'hello world');
  });

  it('returns empty string when outputs are empty', () => {
    const interaction = makeInteraction('ia-5', 'completed', []);

    assert.strictEqual(extractTextFromInteraction(interaction), '');
  });

  it('ignores non-text outputs', () => {
    const interaction = makeInteraction('ia-6', 'completed', [
      { type: 'google_search_call', arguments: {}, id: 'call-1' },
      makeTextContent('answer'),
    ]);

    assert.strictEqual(extractTextFromInteraction(interaction), 'answer');
  });
});

describe('interactionToStreamResult', () => {
  it('produces a StreamResult with text and hadCandidate true', () => {
    const interaction = makeInteraction('ia-7', 'completed', [makeTextContent('output')]);
    const result = interactionToStreamResult(interaction);

    assert.strictEqual(result.text, 'output');
    assert.strictEqual(result.hadCandidate, true);
    assert.deepStrictEqual(result.toolsUsed, []);
    assert.deepStrictEqual(result.functionCalls, []);
  });

  it('produces empty parts when text is empty', () => {
    const interaction = makeInteraction('ia-8', 'completed', []);
    const result = interactionToStreamResult(interaction);

    assert.deepStrictEqual(result.parts, []);
  });
});
