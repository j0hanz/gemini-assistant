import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { FinishReason, Outcome } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';

import { resetProgressThrottle } from '../../src/lib/errors.js';
import {
  advanceProgress,
  consumeStreamWithProgress,
  extractUsage,
  handleToolExecution,
  PROGRESS_CAP,
  PROGRESS_TOTAL,
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
  beforeEach(() => {
    resetProgressThrottle();
  });

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

  it('returns empty toolsUsed for text-only stream', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([makeChunk([{ text: 'Hello' }], FinishReason.STOP)]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.deepStrictEqual(result.toolsUsed, []);
  });

  it('detects code execution parts and reports progress', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ executableCode: { code: 'print(1+1)' } }]),
      makeChunk([{ codeExecutionResult: { output: '2', outcome: Outcome.OUTCOME_OK } }]),
      makeChunk([{ text: 'The answer is 2' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.ok(result.toolsUsed.includes('codeExecution'));
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Executing code'));
    assert.ok(messages.includes('Code executed'));
    assert.ok(messages.includes('Compiling results'), 'should emit Compiling results after tools');
    assert.ok(
      !messages.includes('Generating response'),
      'should not emit Generating response after tools',
    );
  });

  it('detects grounding metadata and reports search tool', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const chunk = makeChunk([{ text: 'search result' }], FinishReason.STOP);
    const candidates = chunk.candidates ?? [];
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      firstCandidate.groundingMetadata = {
        groundingChunks: [{ web: { title: 'Test', uri: 'https://example.com' } }],
      };
    }
    const stream = fakeStream([chunk]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.ok(result.toolsUsed.includes('googleSearch'));
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Searching the web'));
    assert.ok(
      messages.includes('Compiling results'),
      'text after search should emit Compiling results',
    );
  });

  it('detects function calls and reports tool name', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ functionCall: { name: 'customTool', args: {} } }]),
      makeChunk([{ text: 'result' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.ok(result.toolsUsed.includes('customTool'));
    assert.deepStrictEqual(result.toolEvents, [
      { kind: 'function_call', name: 'customTool', args: {} },
    ]);
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Tool: customTool'));
  });

  it('captures tool call and tool response parts with ids and signatures', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk(
        [
          {
            toolCall: {
              toolType: 'GOOGLE_SEARCH_WEB',
              args: { queries: ['latest release'] },
              id: 'tool-1',
            },
            thoughtSignature: 'sig-tool-call',
          },
          {
            toolResponse: {
              toolType: 'GOOGLE_SEARCH_WEB',
              response: { search_suggestions: ['latest release notes'] },
              id: 'tool-1',
            },
            thoughtSignature: 'sig-tool-response',
          },
          { text: 'answer' },
        ],
        FinishReason.STOP,
      ),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.ok(result.toolsUsed.includes('googleSearch'));
    assert.deepStrictEqual(result.toolEvents.slice(0, 2), [
      {
        kind: 'tool_call',
        args: { queries: ['latest release'] },
        id: 'tool-1',
        thoughtSignature: 'sig-tool-call',
        toolType: 'GOOGLE_SEARCH_WEB',
      },
      {
        kind: 'tool_response',
        id: 'tool-1',
        response: { search_suggestions: ['latest release notes'] },
        thoughtSignature: 'sig-tool-response',
        toolType: 'GOOGLE_SEARCH_WEB',
      },
    ]);

    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Built-in tool: googleSearch'));
    assert.ok(messages.includes('Built-in result: googleSearch'));
  });

  it('captures signature-only parts even when they have no text', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'partial answer' }]),
      makeChunk([{ text: '', thoughtSignature: 'sig-final' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'partial answer');
    assert.deepStrictEqual(result.toolEvents.at(-1), {
      kind: 'part',
      text: '',
      thoughtSignature: 'sig-final',
    });
  });

  it('tracks multiple tool types in toolsUsed', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const searchChunk = makeChunk([{ text: 'found data' }]);
    const candidates = searchChunk.candidates ?? [];
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      firstCandidate.groundingMetadata = {
        groundingChunks: [{ web: { title: 'Test', uri: 'https://example.com' } }],
      };
    }
    const stream = fakeStream([
      searchChunk,
      makeChunk([{ executableCode: { code: 'x=1' } }]),
      makeChunk([{ codeExecutionResult: { output: '1', outcome: Outcome.OUTCOME_OK } }]),
      makeChunk([{ text: 'final' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.ok(result.toolsUsed.includes('googleSearch'));
    assert.ok(result.toolsUsed.includes('codeExecution'));
    assert.strictEqual(result.toolsUsed.length, 2);

    const messages = progressCalls.map((c) => c.message);
    assert.ok(
      messages.includes('Compiling results'),
      'text after tools should emit Compiling results',
    );
  });

  it('handles mixed Gemini-style chunk sequences while preserving metadata', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const researchChunk = makeChunk([{ text: '**Planning**\n\nInvestigating.', thought: true }]);
    const candidates = researchChunk.candidates ?? [];
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      firstCandidate.groundingMetadata = {
        groundingChunks: [{ web: { title: 'Docs', uri: 'https://example.com/docs' } }],
      };
    }

    const finalChunk = makeChunk([{ text: 'final answer' }], FinishReason.STOP);
    finalChunk.usageMetadata = {
      promptTokenCount: 12,
      candidatesTokenCount: 7,
      totalTokenCount: 19,
    } as GenerateContentResponse['usageMetadata'];

    const stream = fakeStream([
      researchChunk,
      makeChunk([{ functionCall: { name: 'fetchRepo', args: { repo: 'acme/app' } } }]),
      makeChunk([{ executableCode: { code: 'print(2 + 2)' } }]),
      makeChunk([{ codeExecutionResult: { output: '4', outcome: Outcome.OUTCOME_OK } }]),
      finalChunk,
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'final answer');
    assert.strictEqual(result.thoughtText, '**Planning**\n\nInvestigating.');
    assert.strictEqual(result.finishReason, FinishReason.STOP);
    assert.strictEqual(result.usageMetadata?.totalTokenCount, 19);
    assert.ok(result.toolsUsed.includes('googleSearch'));
    assert.ok(result.toolsUsed.includes('fetchRepo'));
    assert.ok(result.toolsUsed.includes('codeExecution'));
    assert.deepStrictEqual(result.functionCalls, [
      { name: 'fetchRepo', args: { repo: 'acme/app' } },
    ]);
    assert.ok(result.toolEvents.some((event) => event.kind === 'function_call'));
    assert.ok(result.toolEvents.some((event) => event.kind === 'executable_code'));
    assert.ok(result.toolEvents.some((event) => event.kind === 'code_execution_result'));

    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Searching the web'));
    assert.ok(messages.includes('Planning'));
    assert.ok(messages.includes('Tool: fetchRepo'));
    assert.ok(messages.includes('Executing code'));
    assert.ok(messages.includes('Code executed'));
    assert.ok(messages.includes('Compiling results'));
  });

  it('emits thought headers as progress notifications', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([
        {
          text: '**Defining Research Scope**\n\nSome reasoning.\n\n**Analyzing GitHub Trends**\n\nMore thoughts.',
          thought: true,
        },
      ]),
      makeChunk([{ text: 'final answer' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'final answer');
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Thinking'), 'should emit initial Thinking');
    assert.ok(messages.includes('Defining Research Scope'), 'should emit first thought header');
    assert.ok(messages.includes('Analyzing GitHub Trends'), 'should emit second thought header');
  });

  it('emits thought headers split across chunks', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'Reasoning start\n\n**Ana', thought: true }]),
      makeChunk([{ text: 'lyzing Trends**\n\nDetails here.', thought: true }]),
      makeChunk([{ text: 'done' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'done');
    const messages = progressCalls.map((c) => c.message);
    // Header should NOT appear after chunk 1 (incomplete)
    // Header SHOULD appear after chunk 2 (completed)
    assert.ok(
      messages.includes('Analyzing Trends'),
      'should emit header once both delimiters arrive',
    );
  });

  it('does not emit duplicate headers for already-scanned text', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: '**Step One**\n\nThinking...', thought: true }]),
      makeChunk([{ text: '\n\n**Step Two**\n\nMore thinking.', thought: true }]),
      makeChunk([{ text: 'answer' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'answer');
    const messages = progressCalls.map((c) => c.message);
    const stepOneCount = messages.filter((m) => m === 'Step One').length;
    const stepTwoCount = messages.filter((m) => m === 'Step Two').length;
    assert.strictEqual(stepOneCount, 1, 'Step One should appear exactly once');
    assert.strictEqual(stepTwoCount, 1, 'Step Two should appear exactly once');
  });

  it('emits only Thinking when thought text has no bold headers', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'Just plain reasoning without any headers.', thought: true }]),
      makeChunk([{ text: 'result' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'result');
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Thinking'), 'should still emit Thinking');
    // No additional thought-header messages beyond the standard phases
    const thinkingIndex = messages.indexOf('Thinking');
    const generatingIndex = messages.indexOf('Generating response');
    // Between Thinking and Generating, there should be no extra messages
    assert.strictEqual(
      generatingIndex,
      thinkingIndex + 1,
      'no extra messages between Thinking and Generating',
    );
  });

  it('emits fallback thinking progress after several headerless thought chunks', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'one', thought: true }]),
      makeChunk([{ text: ' two', thought: true }]),
      makeChunk([{ text: ' three', thought: true }]),
      makeChunk([{ text: ' four', thought: true }]),
      makeChunk([{ text: ' five', thought: true }]),
      makeChunk([{ text: 'answer' }], FinishReason.STOP),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'answer');
    assert.match(result.thoughtText, /one two three four five/);
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Still thinking…'));
  });

  it('emits thought headers with toolLabel prefix', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: '**Planning**\n\nDetails.', thought: true }]),
      makeChunk([{ text: 'answer' }], FinishReason.STOP),
    ]);

    await consumeStreamWithProgress(stream, ctx, 'Agentic Search');

    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Agentic Search: Planning'), 'should include toolLabel prefix');
  });

  it('sends asymptotic progress with total=100', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'Hello ' }]),
      makeChunk([{ text: 'world' }], FinishReason.STOP),
    ]);

    await consumeStreamWithProgress(stream, ctx);

    // Every progress call should include total=PROGRESS_TOTAL
    for (const call of progressCalls) {
      assert.strictEqual(call.total, PROGRESS_TOTAL, `expected total=${PROGRESS_TOTAL}`);
    }

    // Progress values should be monotonically increasing
    for (let i = 1; i < progressCalls.length; i++) {
      const prev = progressCalls[i - 1]?.progress ?? 0;
      const curr = progressCalls[i]?.progress ?? 0;
      assert.ok(curr >= prev, `progress should increase: ${prev} -> ${curr}`);
    }

    // Progress should never exceed PROGRESS_CAP
    for (const call of progressCalls) {
      assert.ok(
        call.progress <= PROGRESS_CAP,
        `progress ${call.progress} exceeds cap ${PROGRESS_CAP}`,
      );
    }
  });

  it('advanceProgress never exceeds cap', () => {
    let current = 0;
    for (let i = 0; i < 50; i++) {
      current = advanceProgress(current);
      assert.ok(current <= PROGRESS_CAP, `step ${i}: ${current} > ${PROGRESS_CAP}`);
    }
    // After many steps, should be at the cap
    assert.strictEqual(current, PROGRESS_CAP);
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

describe('handleToolExecution', () => {
  beforeEach(() => {
    resetProgressThrottle();
  });

  it('reports failure once when resultMod converts success into an error', async () => {
    const { ctx, progressCalls } = makeMockContext();

    const result = await handleToolExecution(
      ctx,
      'execute_code',
      'Execute Code',
      async () => fakeStream([makeChunk([{ text: 'partial output' }], FinishReason.STOP)]),
      () => ({
        resultMod: () => ({
          isError: true,
          content: [{ type: 'text', text: 'execution failed' }],
        }),
      }),
    );

    assert.strictEqual(result.isError, true);
    const terminalMessages = progressCalls
      .filter((call) => call.progress === PROGRESS_TOTAL)
      .map((call) => call.message);
    assert.deepStrictEqual(terminalMessages, ['Execute Code: failed — execution failed']);
  });

  it('reports failure once for stream validation errors', async () => {
    const { ctx, progressCalls } = makeMockContext();

    const result = await handleToolExecution(ctx, 'search', 'Web Search', async () =>
      fakeStream([makeChunk([], FinishReason.SAFETY)]),
    );

    assert.strictEqual(result.isError, true);
    const terminalMessages = progressCalls
      .filter((call) => call.progress === PROGRESS_TOTAL)
      .map((call) => call.message);
    assert.deepStrictEqual(terminalMessages, [
      'Web Search: failed — search: response blocked by safety filter',
    ]);
  });
});
