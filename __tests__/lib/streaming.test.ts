import type { ServerContext } from '@modelcontextprotocol/server';
import type { QueuedMessage } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { FinishReason, Outcome } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';

import { resetProgressThrottle } from '../../src/lib/errors.js';
import {
  advanceProgress,
  consumeStreamWithProgress,
  extractUsage,
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

function makePromptBlockedChunk(blockReason = 'SAFETY'): GenerateContentResponse {
  return {
    candidates: [],
    promptFeedback: { blockReason } as GenerateContentResponse['promptFeedback'],
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
    // Consecutive plain-text parts are coalesced into a single Part by
    // `appendStreamPart` to keep token accounting stable on replay.
    assert.strictEqual(result.parts.length, 1);
    assert.strictEqual(result.parts[0]?.text, 'Hello world');
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

    it('keeps thought header parsing isolated across concurrent streams', async () => {
      let releaseAlphaHeader: (() => void) | undefined;
      const alphaHeaderBlocked = new Promise<void>((resolve) => {
        releaseAlphaHeader = resolve;
      });
      let alphaHeaderSeen = false;

      function makeConcurrentContext() {
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
              const message = n.params.message;

              progressCalls.push({
                progress: n.params.progress,
                ...(n.params.total !== undefined ? { total: n.params.total } : {}),
                ...(message ? { message } : {}),
              });

              if (message === 'Alpha') {
                alphaHeaderSeen = true;
                await alphaHeaderBlocked;
              }
            },
          },
        } as unknown as ServerContext;

        return { ctx, progressCalls };
      }

      const first = makeConcurrentContext();
      const second = makeConcurrentContext();

      const firstRun = consumeStreamWithProgress(
        fakeStream([
          makeChunk([{ text: '**Alpha**\n\nfirst\n\n**Beta**\n\nsecond', thought: true }]),
          makeChunk([{ text: 'done one' }], FinishReason.STOP),
        ]),
        first.ctx,
      );

      await new Promise<void>((resolve) => {
        const check = () => {
          if (alphaHeaderSeen) {
            resolve();
            return;
          }

          queueMicrotask(check);
        };

        check();
      });

      const secondRun = await consumeStreamWithProgress(
        fakeStream([
          makeChunk([{ text: '**Gamma**\n\nthird\n\n**Delta**\n\nfourth', thought: true }]),
          makeChunk([{ text: 'done two' }], FinishReason.STOP),
        ]),
        second.ctx,
      );

      releaseAlphaHeader?.();
      const firstRunResult = await firstRun;

      assert.strictEqual(firstRunResult.text, 'done one');
      assert.strictEqual(secondRun.text, 'done two');
      assert.ok(first.progressCalls.some((call) => call.message === 'Alpha'));
      assert.ok(first.progressCalls.some((call) => call.message === 'Beta'));
      assert.ok(second.progressCalls.some((call) => call.message === 'Gamma'));
      assert.ok(second.progressCalls.some((call) => call.message === 'Delta'));
    });
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Evaluating prompt'));
    assert.ok(!messages.includes('Complete'));
  });

  it('captures promptFeedback block reason when no candidates are returned', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(fakeStream([makePromptBlockedChunk()]), ctx);

    assert.strictEqual(result.hadCandidate, false);
    assert.strictEqual(result.promptBlockReason, 'SAFETY');
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
    chunk.usageMetadata = usage;

    const stream = fakeStream([chunk]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.usageMetadata?.promptTokenCount, 10);
    assert.strictEqual(result.usageMetadata?.candidatesTokenCount, 5);
    assert.strictEqual(result.usageMetadata?.totalTokenCount, 15);
  });

  it('captures candidate observability metadata and expanded usage details', async () => {
    const { ctx } = makeMockContext();
    const usage = {
      promptTokenCount: 10,
      toolUsePromptTokenCount: 3,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 4 }],
      candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 5 }],
      candidatesTokenCount: 5,
      totalTokenCount: 18,
    };
    const chunk = makeChunk([{ text: 'result' }], FinishReason.STOP);
    chunk.usageMetadata = usage;
    const candidate = chunk.candidates?.[0] as Record<string, unknown> | undefined;
    if (candidate) {
      candidate['safetyRatings'] = [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT' }];
      candidate['finishMessage'] = 'done';
      candidate['citationMetadata'] = { citationSources: [{ startIndex: 0, endIndex: 6 }] };
    }

    const result = await consumeStreamWithProgress(fakeStream([chunk]), ctx);
    const extracted = extractUsage(result.usageMetadata);

    assert.deepStrictEqual(result.safetyRatings, [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT' }]);
    assert.strictEqual(result.finishMessage, 'done');
    assert.deepStrictEqual(result.citationMetadata, {
      citationSources: [{ startIndex: 0, endIndex: 6 }],
    });
    assert.deepStrictEqual(extracted, usage);
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
    assert.strictEqual(result.hadCandidate, true);
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

  it('preserves empty string fields in tool events', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([{ codeExecutionResult: { output: '', outcome: Outcome.OUTCOME_OK } }]),
      ]),
      ctx,
    );

    assert.deepStrictEqual(result.toolEvents, [
      { kind: 'code_execution_result', outcome: Outcome.OUTCOME_OK, output: '' },
    ]);
  });

  it('captures executable-code language', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([makeChunk([{ executableCode: { code: 'print(1)', language: 'PYTHON' } }])]),
      ctx,
    );

    assert.deepStrictEqual(result.toolEvents[0], {
      kind: 'executable_code',
      code: 'print(1)',
      language: 'PYTHON',
    });
  });

  it('reports grounding metadata without attributing googleSearch', async () => {
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

    assert.deepStrictEqual(result.toolsUsed, []);
    const messages = progressCalls.map((c) => c.message);
    assert.ok(messages.includes('Retrieving grounded sources'));
    assert.ok(
      messages.includes('Compiling results'),
      'text after grounded retrieval should emit Compiling results',
    );
  });

  it('normalizes CODE_EXECUTION tool calls', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ toolCall: { id: 'tool-1', toolType: 'CODE_EXECUTION' } } as Part]),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.deepStrictEqual(result.toolsUsed, ['codeExecution']);
    assert.deepStrictEqual(result.toolsUsedOccurrences, ['codeExecution']);
  });

  it('passes unknown tool types through verbatim', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ toolCall: { id: 'tool-1', toolType: 'UNKNOWN_TOOL' } } as Part]),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.deepStrictEqual(result.toolsUsed, ['UNKNOWN_TOOL']);
    assert.deepStrictEqual(result.toolsUsedOccurrences, ['UNKNOWN_TOOL']);
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

  it('captures function call thought signatures and dedupes structured function calls', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([
        {
          functionCall: { id: 'fn-1', name: 'customTool', args: { q: 'x' } },
          thoughtSignature: 'sig-fn',
        },
        {
          functionCall: { id: 'fn-1', name: 'customTool', args: { q: 'x' } },
          thoughtSignature: 'sig-fn-repeat',
        },
      ]),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.deepStrictEqual(result.functionCalls, [
      { id: 'fn-1', name: 'customTool', args: { q: 'x' }, thoughtSignature: 'sig-fn' },
    ]);
    assert.strictEqual(
      result.toolEvents.filter((event) => event.kind === 'function_call').length,
      2,
    );
  });

  it('omits nameless function calls from rollups and logs a warning', async () => {
    const logCalls: { level: string; message: string }[] = [];
    const { ctx } = makeMockContext();
    ctx.mcpReq.log = Object.assign(
      async (level: string, message: string) => {
        logCalls.push({ level, message });
      },
      {
        debug: async (message: string) => {
          logCalls.push({ level: 'debug', message });
        },
        info: async () => {},
        warning: async (message: string) => {
          logCalls.push({ level: 'warning', message });
        },
        error: async () => {},
      },
    ) as never;

    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([{ functionCall: { args: { q: 'x' } }, thoughtSignature: 'sig-missing' }]),
      ]),
      ctx,
    );

    assert.deepStrictEqual(result.functionCalls, []);
    assert.deepStrictEqual(result.toolsUsed, []);
    assert.deepStrictEqual(result.toolsUsedOccurrences, []);
    assert.strictEqual(result.namelessFunctionCallCount, 1);
    assert.deepStrictEqual(result.toolEvents, [
      { kind: 'function_call', args: { q: 'x' }, thoughtSignature: 'sig-missing' },
    ]);
    assert.ok(
      logCalls.some(
        (call) =>
          call.level === 'warning' &&
          call.message.includes('functionCall part(s) with missing name'),
      ),
    );
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
    assert.ok(!messages.includes('Built-in result: googleSearch'));
  });

  it('captures function responses as tool events without adding toolsUsed entries', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk(
        [
          {
            functionResponse: {
              id: 'fn-1',
              name: 'lookupWeather',
              response: { forecast: 'sunny' },
            },
            thoughtSignature: 'sig-function-response',
          },
          { text: 'done' },
        ],
        FinishReason.STOP,
      ),
    ]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.deepStrictEqual(result.toolEvents[0], {
      kind: 'function_response',
      id: 'fn-1',
      name: 'lookupWeather',
      response: { forecast: 'sunny' },
      thoughtSignature: 'sig-function-response',
    });
    assert.deepStrictEqual(result.toolsUsed, ['lookupWeather']);
    assert.strictEqual(result.text, 'done');
  });

  it('captures thought signatures on thought parts while accumulating thought text', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([{ text: 'private reasoning', thought: true, thoughtSignature: 'sig-thought' }]),
      ]),
      ctx,
    );

    assert.strictEqual(result.thoughtText, 'private reasoning');
    assert.deepStrictEqual(result.toolEvents[0], {
      kind: 'thought',
      text: 'private reasoning',
      thoughtSignature: 'sig-thought',
    });
  });

  it('keeps thought events distinct from signature-only parts', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([
          { text: 'private reasoning', thought: true, thoughtSignature: 'sig-thought' },
          { thoughtSignature: 'sig-carrier' },
        ]),
      ]),
      ctx,
    );

    assert.deepStrictEqual(
      result.toolEvents.map((event) => event.kind),
      ['thought', 'part'],
    );
  });

  it('captures model text signatures without dropping visible text', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([makeChunk([{ text: 'visible', thoughtSignature: 'sig-visible' }])]),
      ctx,
    );

    assert.strictEqual(result.text, 'visible');
    assert.deepStrictEqual(result.toolEvents, [
      { kind: 'model_text', text: 'visible', thoughtSignature: 'sig-visible' },
    ]);
  });

  it('preserves model text and function call event ordering', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([
          { text: 'before', thoughtSignature: 'sig-before' },
          { functionCall: { name: 'lookup', args: { q: 'x' } } },
          { text: 'after', thoughtSignature: 'sig-after' },
        ]),
      ]),
      ctx,
    );

    assert.deepStrictEqual(
      result.toolEvents.map((event) => event.kind),
      ['model_text', 'function_call', 'model_text'],
    );
  });

  it('does not double-advance progress for grounding metadata plus matching toolCall', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const chunk = makeChunk([
      {
        toolCall: {
          toolType: 'GOOGLE_SEARCH_WEB',
          args: { queries: ['query'] },
          id: 'tool-1',
        },
      },
      { text: 'answer' },
    ]);
    const candidate = chunk.candidates?.[0];
    if (candidate) {
      candidate.groundingMetadata = {
        groundingChunks: [{ web: { title: 'Test', uri: 'https://example.com' } }],
      };
    }

    await consumeStreamWithProgress(fakeStream([chunk]), ctx);

    const messages = progressCalls.map((call) => call.message);
    assert.strictEqual(
      messages.filter((message) => message === 'Built-in tool: googleSearch').length,
      1,
    );
    assert.strictEqual(
      messages.filter((message) => message === 'Retrieving grounded sources').length,
      0,
    );
  });

  it('emits compiling progress for each tool wave after visible text', async () => {
    const { ctx, progressCalls } = makeMockContext();
    await consumeStreamWithProgress(
      fakeStream([
        makeChunk([{ text: 'intro' }]),
        makeChunk([{ functionCall: { name: 'firstTool', args: {} } }]),
        makeChunk([{ text: 'middle' }]),
        makeChunk([{ functionCall: { name: 'secondTool', args: {} } }]),
        makeChunk([{ text: 'final' }]),
      ]),
      ctx,
    );

    const compileCount = progressCalls.filter(
      (call) => call.message === 'Compiling results',
    ).length;
    assert.strictEqual(compileCount, 2);
  });

  it('tracks text by tool wave', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([{ text: 'intro' }]),
        makeChunk([{ functionCall: { name: 'lookup', args: {} } }]),
        makeChunk([{ text: 'final' }]),
      ]),
      ctx,
    );

    assert.strictEqual(result.text, 'introfinal');
    assert.deepStrictEqual(result.textByWave, ['intro', 'final']);
  });

  it('captures toolsUsedOccurrences in event order with duplicates', async () => {
    const { ctx } = makeMockContext();
    const result = await consumeStreamWithProgress(
      fakeStream([
        makeChunk([
          { functionCall: { name: 'lookup', args: {} } },
          { functionResponse: { name: 'lookup', response: {} } },
          { executableCode: { code: 'print(1)' } },
          { codeExecutionResult: { output: '1', outcome: Outcome.OUTCOME_OK } },
        ]),
      ]),
      ctx,
    );

    assert.deepStrictEqual(result.toolsUsedOccurrences, [
      'lookup',
      'lookup',
      'codeExecution',
      'codeExecution',
    ]);
  });

  it('does not enqueue streaming text on the logging channel', async () => {
    const queued: QueuedMessage[] = [];
    const notifications: { method: string }[] = [];
    const ctx = {
      mcpReq: {
        _meta: { progressToken: 'queue-token' },
        signal: new AbortController().signal,
        log: Object.assign(async () => {}, {
          debug: async () => {},
          info: async () => {},
          warning: async () => {},
          error: async () => {},
        }),
        notify: async (notification: { method: string }) => {
          notifications.push(notification);
        },
      },
      task: {
        id: 'task-queue',
        queue: {
          enqueue: (_taskId: string, message: QueuedMessage) => {
            queued.push(message);
          },
        },
      },
    } as unknown as ServerContext;

    const stream = fakeStream([makeChunk([{ text: 'stream me' }], FinishReason.STOP)]);

    const result = await consumeStreamWithProgress(stream, ctx);

    assert.strictEqual(result.text, 'stream me');
    assert.strictEqual(queued.length, 0);
    assert.ok(
      !notifications.some((n) => n.method === 'notifications/message'),
      'Streaming text must not be emitted on the notifications/message channel',
    );
  });

  it('does not surface queue failures as warnings when streaming (enqueue is a no-op)', async () => {
    const logCalls: { level: string; message: string }[] = [];
    const log = Object.assign(
      async (level: string, message: string) => {
        logCalls.push({ level, message });
      },
      {
        debug: async () => {},
        info: async () => {},
        warning: async () => {},
        error: async () => {},
      },
    );

    const ctx = {
      mcpReq: {
        _meta: { progressToken: 'queue-token' },
        signal: new AbortController().signal,
        log,
        notify: async () => {},
      },
      task: {
        id: 'task-queue',
        queue: {
          enqueue: async () => {
            throw new Error('queue full');
          },
        },
      },
    } as unknown as ServerContext;

    const result = await consumeStreamWithProgress(
      fakeStream([makeChunk([{ text: 'stream me' }], FinishReason.STOP)]),
      ctx,
    );

    assert.strictEqual(result.text, 'stream me');
    assert.ok(
      !logCalls.some((call) => call.message.includes('Dropped streamed chunk')),
      'No dropped-chunk warning should fire because no enqueue is attempted',
    );
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

  it('does not transition to generating or enqueue queue messages for empty signature-only parts', async () => {
    const queued: QueuedMessage[] = [];
    const { ctx, progressCalls } = makeMockContext();
    (ctx as unknown as Record<string, unknown>).task = {
      id: 'task-signature-only',
      queue: {
        enqueue: (_taskId: string, message: QueuedMessage) => {
          queued.push(message);
        },
      },
    };

    const result = await consumeStreamWithProgress(
      fakeStream([makeChunk([{ text: '', thoughtSignature: 'sig-empty' }], FinishReason.STOP)]),
      ctx,
    );

    assert.strictEqual(result.text, '');
    assert.deepStrictEqual(result.toolEvents, [
      { kind: 'part', text: '', thoughtSignature: 'sig-empty' },
    ]);
    assert.strictEqual(queued.length, 0);
    const messages = progressCalls.map((call) => call.message);
    assert.ok(!messages.includes('Generating response'));
  });

  it('does not transition to generating for undefined-text signature-only parts', async () => {
    const { ctx, progressCalls } = makeMockContext();

    const result = await consumeStreamWithProgress(
      fakeStream([makeChunk([{ thoughtSignature: 'sig-undefined' }], FinishReason.STOP)]),
      ctx,
    );

    assert.strictEqual(result.text, '');
    assert.deepStrictEqual(result.toolEvents, [
      { kind: 'part', thoughtSignature: 'sig-undefined' },
    ]);
    const messages = progressCalls.map((call) => call.message);
    assert.ok(!messages.includes('Generating response'));
  });

  it('does not transition to generating for empty text without a thought signature', async () => {
    const { ctx, progressCalls } = makeMockContext();

    const result = await consumeStreamWithProgress(
      fakeStream([makeChunk([{ text: '' }], FinishReason.STOP)]),
      ctx,
    );

    assert.strictEqual(result.text, '');
    assert.deepStrictEqual(result.textByWave, ['']);
    const messages = progressCalls.map((call) => call.message);
    assert.ok(!messages.includes('Generating response'));
  });

  it('tracks multiple tool types in toolsUsed', async () => {
    const { ctx, progressCalls } = makeMockContext();
    const searchChunk = makeChunk([
      { toolCall: { id: 'search-1', toolType: 'GOOGLE_SEARCH_WEB' } },
      { text: 'found data' },
    ] as Part[]);
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
    const researchChunk = makeChunk([
      { toolCall: { id: 'search-1', toolType: 'GOOGLE_SEARCH_WEB' } },
      { text: '**Planning**\n\nInvestigating.', thought: true },
    ] as Part[]);
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
    };

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
    assert.ok(messages.includes('Built-in tool: googleSearch'));
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

  it('coalesces three consecutive plain-text parts into a single Part', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'a' }]),
      makeChunk([{ text: 'b' }]),
      makeChunk([{ text: 'c' }], FinishReason.STOP),
    ]);
    const result = await consumeStreamWithProgress(stream, ctx);
    assert.strictEqual(result.text, 'abc');
    assert.strictEqual(result.parts.length, 1);
    assert.strictEqual(result.parts[0]?.text, 'abc');
  });

  it('does NOT coalesce plain-text parts when either carries a thoughtSignature', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ text: 'a', thoughtSignature: 'sig-1' }]),
      makeChunk([{ text: 'b' }], FinishReason.STOP),
    ]);
    const result = await consumeStreamWithProgress(stream, ctx);
    assert.strictEqual(result.parts.length, 2);
    assert.strictEqual(result.parts[0]?.text, 'a');
    assert.strictEqual(result.parts[0]?.thoughtSignature, 'sig-1');
    assert.strictEqual(result.parts[1]?.text, 'b');
  });

  it('counts nameless functionCall parts and surfaces anomalies.namelessFunctionCalls', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([
      makeChunk([{ functionCall: { args: { a: 1 } } }]),
      makeChunk([{ functionCall: { args: { b: 2 } } }], FinishReason.STOP),
    ]);
    const result = await consumeStreamWithProgress(stream, ctx);
    assert.strictEqual(result.namelessFunctionCallCount, 2);
    assert.deepStrictEqual(result.anomalies, { namelessFunctionCalls: 2 });
    // Raw parts are preserved verbatim so downstream sanitizers can filter.
    assert.strictEqual(result.parts.length, 2);
    // The deduped `functionCalls` list drops nameless entries entirely.
    assert.strictEqual(result.functionCalls.length, 0);
  });

  it('omits anomalies when no anomaly conditions triggered', async () => {
    const { ctx } = makeMockContext();
    const stream = fakeStream([makeChunk([{ text: 'ok' }], FinishReason.STOP)]);
    const result = await consumeStreamWithProgress(stream, ctx);
    assert.strictEqual(result.anomalies, undefined);
  });

  it('captures full promptFeedback object alongside promptBlockReason', async () => {
    const { ctx } = makeMockContext();
    const fullFeedback = {
      blockReason: 'SAFETY',
      safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH' }],
    } as unknown as GenerateContentResponse['promptFeedback'];
    const chunkWithFeedback: GenerateContentResponse = {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: FinishReason.STOP }],
      promptFeedback: fullFeedback,
    } as GenerateContentResponse;
    const stream = fakeStream([chunkWithFeedback]);
    const result = await consumeStreamWithProgress(stream, ctx);
    assert.deepStrictEqual(result.promptFeedback, fullFeedback);
    assert.strictEqual(result.promptBlockReason, 'SAFETY');
  });
});

describe('validateStreamResult', () => {
  it('returns text for normal result', () => {
    const result = validateStreamResult(
      {
        text: 'Hello',
        parts: [{ text: 'Hello' }],
        finishReason: FinishReason.STOP,
        hadCandidate: true,
      },
      'test',
    );
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, 'Hello');
  });

  it('renders code execution events into content blocks', () => {
    const result = validateStreamResult(
      {
        text: 'The answer is 2',
        parts: [{ text: 'The answer is 2' }],
        finishReason: FinishReason.STOP,
        hadCandidate: true,
        toolEvents: [
          { kind: 'executable_code', code: 'print(1 + 1)', language: 'PYTHON' },
          {
            kind: 'code_execution_result',
            outcome: Outcome.OUTCOME_OK,
            output: '2',
          },
        ],
      } as StreamResult,
      'test',
    );

    assert.deepStrictEqual(
      result.content.map((entry) => (entry.type === 'text' ? entry.text : '')),
      ['The answer is 2', '```PYTHON\nprint(1 + 1)\n```', 'Output (OUTCOME_OK):\n```\n2\n```'],
    );
  });

  it('returns error for SAFETY finish reason', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.SAFETY, hadCandidate: true },
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /safety filter/);
  });

  it('returns error for RECITATION finish reason', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.RECITATION, hadCandidate: true },
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /recitation/);
  });

  it('returns error for MAX_TOKENS with no text', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.MAX_TOKENS, hadCandidate: true },
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /max tokens/);
  });

  it('returns errors for additional terminal finish reasons', () => {
    const cases: [FinishReason, RegExp][] = [
      [FinishReason.MALFORMED_FUNCTION_CALL, /malformed_function_call/],
      [FinishReason.BLOCKLIST, /blocklist/],
      [FinishReason.PROHIBITED_CONTENT, /prohibited_content/],
      [FinishReason.SPII, /spii/],
      [FinishReason.OTHER, /finish_other/],
    ];

    for (const [finishReason, pattern] of cases) {
      const result = validateStreamResult(
        { text: 'partial', parts: [], finishReason, hadCandidate: true } as StreamResult,
        'test',
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0]?.text ?? '', pattern);
    }
  });

  it('returns aborted errors before candidate validation', () => {
    const result = validateStreamResult(
      { text: '', parts: [], hadCandidate: false, aborted: true } as StreamResult,
      'test',
    );

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /aborted/);
  });

  it('returns text when MAX_TOKENS but text exists', () => {
    const result = validateStreamResult(
      {
        text: 'partial',
        parts: [{ text: 'partial' }],
        finishReason: FinishReason.MAX_TOKENS,
        hadCandidate: true,
      },
      'test',
    );
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, 'partial');
  });

  it('returns error for candidate-less results', () => {
    const result = validateStreamResult(
      { text: '', parts: [], hadCandidate: false } as StreamResult,
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /empty_stream/);
  });

  it('returns error for prompt-blocked results', () => {
    const result = validateStreamResult(
      { text: '', parts: [], hadCandidate: false, promptBlockReason: 'SAFETY' } as StreamResult,
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /prompt blocked.*SAFETY/);
  });

  it('includes tool name in error messages', () => {
    const result = validateStreamResult(
      { text: '', parts: [], finishReason: FinishReason.SAFETY, hadCandidate: true },
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
      toolUsePromptTokenCount: 5,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
      candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 50 }],
      totalTokenCount: 170,
    };
    const result = extractUsage(meta);
    assert.deepStrictEqual(result, {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
      toolUsePromptTokenCount: 5,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
      candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 50 }],
      totalTokenCount: 170,
    });
  });

  it('omits undefined fields', () => {
    const meta = { promptTokenCount: 42 };
    const result = extractUsage(meta);
    assert.strictEqual(result?.promptTokenCount, 42);
    assert.strictEqual('candidatesTokenCount' in (result ?? {}), false);
  });
});
