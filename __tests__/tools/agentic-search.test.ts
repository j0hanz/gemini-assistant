import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { FinishReason, Outcome } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';

import { resetProgressThrottle } from '../../src/lib/errors.js';
import { handleToolExecution } from '../../src/lib/streaming.js';
import { buildAgenticSearchResult } from '../../src/tools/research-job.js';

interface AgenticSearchStructuredContent {
  report: string;
  sourceDetails?: { title?: string; url: string }[];
  sources: string[];
  toolEvents?: { kind: string }[];
  toolsUsed?: string[];
}

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

function makeMockContext(): {
  ctx: ServerContext;
  progressCalls: { progress: number; total?: number; message?: string }[];
} {
  const progressCalls: { progress: number; total?: number; message?: string }[] = [];

  const ctx = {
    mcpReq: {
      _meta: { progressToken: 'test-token' },
      signal: new AbortController().signal,
      log: Object.assign(async () => {}, {
        debug: async () => {},
        info: async () => {},
        warning: async () => {},
        error: async () => {},
      }),
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

describe('agentic_search result shaping', () => {
  beforeEach(() => {
    resetProgressThrottle();
  });

  it('preserves combined search and code-execution metadata', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const searchChunk = makeChunk([{ text: 'Researching...' }]);
    if (searchChunk.candidates?.[0]) {
      searchChunk.candidates[0].groundingMetadata = {
        groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com' } }],
      };
    }

    const result = await handleToolExecution(
      ctx,
      'agentic_search',
      'Agentic Search',
      async () =>
        fakeStream([
          searchChunk,
          makeChunk([{ executableCode: { code: 'print(2 + 2)' } }]),
          makeChunk([{ codeExecutionResult: { output: '4', outcome: Outcome.OUTCOME_OK } }]),
          makeChunk([{ text: '# Report\n\nFinal answer' }], FinishReason.STOP),
        ]),
      buildAgenticSearchResult,
    );
    const structured = result.structuredContent as unknown as AgenticSearchStructuredContent;

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(structured.report, 'Researching...# Report\n\nFinal answer');
    assert.deepStrictEqual(structured.sources, ['https://example.com']);
    assert.deepStrictEqual(structured.sourceDetails, [
      { title: 'Example', url: 'https://example.com' },
    ]);
    assert.deepStrictEqual(structured.toolsUsed, ['googleSearch', 'codeExecution']);
    assert.ok(structured.toolEvents?.some((event) => event.kind === 'executable_code'));
    assert.ok(structured.toolEvents?.some((event) => event.kind === 'code_execution_result'));
    assert.match((result.content[1] as { text?: string }).text ?? '', /Sources:/);

    const messages = progressCalls.map((call) => call.message);
    assert.ok(messages.includes('Agentic Search: Searching the web'));
    assert.ok(messages.includes('Agentic Search: Executing code'));
    assert.ok(messages.includes('Agentic Search: Code executed'));
    assert.ok(messages.includes('Agentic Search: Compiling results'));
  });
});
