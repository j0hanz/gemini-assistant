import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';

import { consumeStreamWithProgress } from '../../src/lib/streaming.js';

function makeContext(): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      signal: new AbortController().signal,
      log: async () => undefined,
      notify: async () => undefined,
    },
  } as unknown as ServerContext;
}

async function* fakeStream(
  chunks: GenerateContentResponse[],
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('streaming Gemini metadata preservation', () => {
  it('round-trips tool, grounding, URL context, usage, and finish metadata', async () => {
    const chunk: GenerateContentResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'lookup',
                  args: { q: 'mcp' },
                },
                thoughtSignature: 'sig-function-call',
              },
              {
                toolCall: {
                  id: 'tool-1',
                  toolType: 'GOOGLE_SEARCH',
                  args: { query: 'mcp' },
                },
                thoughtSignature: 'sig-tool-call',
              },
              { text: 'done' },
            ],
          },
          finishReason: FinishReason.STOP,
          groundingMetadata: {
            webSearchQueries: ['mcp server'],
            groundingChunks: [{ web: { title: 'MCP', uri: 'https://example.test/mcp' } }],
          },
          urlContextMetadata: {
            urlMetadata: [
              {
                retrievedUrl: 'https://example.test/mcp',
                urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 7,
        cachedContentTokenCount: 11,
        totalTokenCount: 15,
      },
    };

    const result = await consumeStreamWithProgress(fakeStream([chunk]), makeContext(), 'Test');

    assert.strictEqual(result.finishReason, FinishReason.STOP);
    assert.deepStrictEqual(result.functionCalls, [
      { id: 'call-1', name: 'lookup', args: { q: 'mcp' } },
    ]);
    assert.deepStrictEqual(result.toolEvents.slice(0, 2), [
      {
        kind: 'function_call',
        id: 'call-1',
        name: 'lookup',
        args: { q: 'mcp' },
        thoughtSignature: 'sig-function-call',
      },
      {
        kind: 'tool_call',
        id: 'tool-1',
        toolType: 'GOOGLE_SEARCH',
        args: { query: 'mcp' },
        thoughtSignature: 'sig-tool-call',
      },
    ]);
    assert.deepStrictEqual(result.groundingMetadata?.webSearchQueries, ['mcp server']);
    assert.deepStrictEqual(result.groundingMetadata?.groundingChunks, [
      { web: { title: 'MCP', uri: 'https://example.test/mcp' } },
    ]);
    assert.deepStrictEqual(result.urlContextMetadata?.urlMetadata, [
      {
        retrievedUrl: 'https://example.test/mcp',
        urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
      },
    ]);
    assert.strictEqual(result.usageMetadata?.thoughtsTokenCount, 7);
    assert.strictEqual(result.usageMetadata?.candidatesTokenCount, 5);
    assert.strictEqual(result.usageMetadata?.cachedContentTokenCount, 11);
  });
});
