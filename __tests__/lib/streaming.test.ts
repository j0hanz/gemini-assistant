import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';

import {
  consumeStreamWithProgress,
  type StreamResult,
  validateStreamResult,
} from '../../src/lib/streaming.js';

function makeChunk(parts: Part[], finishReason?: FinishReason): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { parts },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  } as GenerateContentResponse;
}

async function* fakeStream(
  chunks: GenerateContentResponse[],
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeProgressTracker(): {
  calls: { progress: number; total: number; message?: string }[];
  fn: (progress: number, total: number, message?: string) => Promise<void>;
} {
  const calls: { progress: number; total: number; message?: string }[] = [];
  return {
    calls,
    fn: async (progress, total, message) => {
      calls.push({ progress, total, ...(message ? { message } : {}) });
    },
  };
}

describe('consumeStreamWithProgress', () => {
  it('reports progress phases for text-only stream', async () => {
    const tracker = makeProgressTracker();
    const stream = fakeStream([
      makeChunk([{ text: 'Hello ' }]),
      makeChunk([{ text: 'world' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, tracker.fn);

    assert.strictEqual(result.text, 'Hello world');
    assert.strictEqual(result.parts.length, 2);
    assert.strictEqual(result.finishReason, FinishReason.STOP);

    // Should have: Evaluating prompt, Generating response, Complete
    const messages = tracker.calls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(messages.includes('Generating response'));
    assert.ok(messages.includes('Complete'));
  });

  it('reports thinking phase when thought parts present', async () => {
    const tracker = makeProgressTracker();
    const stream = fakeStream([
      makeChunk([{ text: 'reasoning...', thought: true }]),
      makeChunk([{ text: 'answer' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, tracker.fn);

    // Thought text should NOT be included in accumulated text
    assert.strictEqual(result.text, 'answer');
    // But thought parts should be in the parts array
    assert.strictEqual(result.parts.length, 2);

    const messages = tracker.calls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(messages.includes('Thinking'));
    assert.ok(messages.includes('Generating response'));
    assert.ok(messages.includes('Complete'));
  });

  it('handles empty stream', async () => {
    const tracker = makeProgressTracker();
    const stream = fakeStream([]);

    const result = await consumeStreamWithProgress(stream, tracker.fn);

    assert.strictEqual(result.text, '');
    assert.strictEqual(result.parts.length, 0);
    assert.strictEqual(result.finishReason, undefined);

    const messages = tracker.calls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(messages.includes('Complete'));
  });

  it('captures finishReason from last chunk', async () => {
    const tracker = makeProgressTracker();
    const stream = fakeStream([
      makeChunk([{ text: 'partial' }]),
      makeChunk([{ text: '' }], FinishReason.MAX_TOKENS),
    ]);

    const result = await consumeStreamWithProgress(stream, tracker.fn);

    assert.strictEqual(result.finishReason, FinishReason.MAX_TOKENS);
  });

  it('captures groundingMetadata from chunks', async () => {
    const tracker = makeProgressTracker();
    const metadata = {
      groundingChunks: [{ web: { title: 'Test', uri: 'https://example.com' } }],
    };
    const chunk = makeChunk([{ text: 'result' }], FinishReason.STOP);
    const candidates = chunk.candidates ?? [];
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      firstCandidate.groundingMetadata = metadata;
    }

    const stream = fakeStream([chunk]);

    const result = await consumeStreamWithProgress(stream, tracker.fn);

    assert.deepStrictEqual(result.groundingMetadata, metadata);
  });

  it('stops consuming when signal is aborted', async () => {
    const tracker = makeProgressTracker();
    const controller = new AbortController();

    async function* abortingStream(): AsyncGenerator<GenerateContentResponse> {
      yield makeChunk([{ text: 'first' }]);
      controller.abort();
      yield makeChunk([{ text: 'second' }]);
    }

    const result = await consumeStreamWithProgress(abortingStream(), tracker.fn, controller.signal);

    assert.strictEqual(result.text, 'first');
  });
});

describe('validateStreamResult', () => {
  it('returns text for normal result', () => {
    const result = validateStreamResult(
      { text: 'Hello', parts: [{ text: 'Hello' }], finishReason: FinishReason.STOP },
      'test',
    );
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, 'Hello');
  });

  it('returns error for SAFETY finish reason', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.SAFETY },
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /safety filter/);
  });

  it('returns error for RECITATION finish reason', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.RECITATION },
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /recitation/);
  });

  it('returns error for MAX_TOKENS with no text', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.MAX_TOKENS },
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /max tokens/);
  });

  it('returns text when MAX_TOKENS but text exists', () => {
    const result = validateStreamResult(
      { text: 'partial', parts: [{ text: 'partial' }], finishReason: FinishReason.MAX_TOKENS },
      'test',
    );
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, 'partial');
  });

  it('returns empty text for result with no finishReason', () => {
    const result = validateStreamResult({ text: '', parts: [] } as StreamResult, 'test');
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, '');
  });

  it('includes tool name in error messages', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.SAFETY },
      'my_tool',
    );
    assert.match(result.content[0]?.text ?? '', /my_tool/);
  });
});
