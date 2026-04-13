import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';

import {
  consumeStreamWithProgress,
  extractUsage,
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

function makeMockContext(overrides?: { aborted?: boolean }): {
  ctx: ServerContext;
  progressCalls: { progress: number; total?: number; message?: string }[];
} {
  const controller = new AbortController();
  if (overrides?.aborted) controller.abort();
  const progressCalls: { progress: number; total?: number; message?: string }[] = [];

  const ctx = {
    mcpReq: {
      _meta: { progressToken: 'test-token' },
      signal: controller.signal,
      log: Object.assign(
        async () => {
          /* noop */
        },
        {
          debug: async () => {},
          info: async () => {},
          warning: async () => {},
          error: async () => {},
        },
      ),
      notify: async (notification: unknown) => {
        const n = notification as {
          params: { progress: number; total?: number; message?: string };
        };
        progressCalls.push({
          progress: n.params.progress,
          ...(n.params.total !== undefined ? { total: n.params.total } : {}),
          ...(n.params.message ? { message: n.params.message } : {}),
        });
      },
    },
  } as unknown as ServerContext;

  return { ctx, progressCalls };
}

describe('consumeStreamWithProgress', () => {
  it('reports progress phases for text-only stream', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'Hello ' }]),
      makeChunk([{ text: 'world' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'Hello world');
    assert.strictEqual(result.parts.length, 2);
    assert.strictEqual(result.finishReason, FinishReason.STOP);

    // Should have: Evaluating prompt, Generating response (no terminal 'Complete' — callers own that)
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(messages.includes('Generating response'));
    assert.ok(!messages.includes('Complete'));
  });

  it('reports thinking phase when thought parts present', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'reasoning...', thought: true }]),
      makeChunk([{ text: 'answer' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    // Thought text should NOT be included in accumulated text
    assert.strictEqual(result.text, 'answer');
    // But thought parts should be in the parts array
    assert.strictEqual(result.parts.length, 2);

    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(messages.includes('Thinking'));
    assert.ok(messages.includes('Generating response'));
    assert.ok(!messages.includes('Complete'));
  });

  it('keeps thought text separate from visible output', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'chain-of-thought', thought: true }]),
      makeChunk([{ text: 'final answer' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.thoughtText, 'chain-of-thought');
    assert.strictEqual(result.text, 'final answer');
  });

  it('handles empty stream', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, '');
    assert.strictEqual(result.parts.length, 0);
    assert.strictEqual(result.finishReason, undefined);

    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(!messages.includes('Complete'));
  });

  it('captures finishReason from last chunk', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'partial' }]),
      makeChunk([{ text: '' }], FinishReason.MAX_TOKENS),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.finishReason, FinishReason.MAX_TOKENS);
  });

  it('captures groundingMetadata from chunks', async () => {
    const { ctx } = makeMockContext();
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

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.deepStrictEqual(result.groundingMetadata, metadata);
  });

  it('captures usageMetadata from chunks', async () => {
    const { ctx } = makeMockContext();
    const usage = {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    };
    const chunk = makeChunk([{ text: 'result' }], FinishReason.STOP);
    chunk.usageMetadata = usage as GenerateContentResponse['usageMetadata'];

    const stream = fakeStream([chunk]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.usageMetadata?.promptTokenCount, 10);
    assert.strictEqual(result.usageMetadata?.candidatesTokenCount, 5);
    assert.strictEqual(result.usageMetadata?.totalTokenCount, 15);
  });

  it('stops consuming when signal is aborted', async () => {
    const controller = new AbortController();
    const ctx = {
      mcpReq: {
        _meta: { progressToken: 'test-token' },
        signal: controller.signal,
        log: Object.assign(async () => {}, {
          debug: async () => {},
          info: async () => {},
          warning: async () => {},
          error: async () => {},
        }),
        notify: async () => {},
      },
    } as unknown as ServerContext;

    async function* abortingStream(): AsyncGenerator<GenerateContentResponse> {
      yield makeChunk([{ text: 'first' }]);
      controller.abort();
      yield makeChunk([{ text: 'second' }]);
    }

    const result = await consumeStreamWithProgress(abortingStream(), ctx);

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

describe('extractUsage', () => {
  it('returns undefined for undefined input', () => {
    assert.strictEqual(extractUsage(undefined), undefined);
  });

  it('extracts token counts from usage metadata', () => {
    const meta = {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
      totalTokenCount: 170,
    };
    const result = extractUsage(meta as Parameters<typeof extractUsage>[0]);
    assert.deepStrictEqual(result, {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
      totalTokenCount: 170,
    });
  });

  it('omits undefined fields', () => {
    const meta = { promptTokenCount: 42 };
    const result = extractUsage(meta as Parameters<typeof extractUsage>[0]);
    assert.strictEqual(result?.promptTokenCount, 42);
    assert.strictEqual('candidatesTokenCount' in (result ?? {}), false);
  });
});
