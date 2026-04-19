import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';
import { z } from 'zod/v4';

import { resetProgressThrottle } from '../../src/lib/errors.js';
import { Logger } from '../../src/lib/logger.js';
import { validateStructuredToolResult } from '../../src/lib/response.js';
import { ToolExecutor } from '../../src/lib/tool-executor.js';

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

function createExecutor(): ToolExecutor {
  const stream = new PassThrough();
  return new ToolExecutor(new Logger({ logStream: stream }).child('executor-test'));
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

describe('ToolExecutor', () => {
  beforeEach(() => {
    resetProgressThrottle();
  });

  it('run returns success results and reports completion', async () => {
    const executor = createExecutor();
    const { ctx, progressCalls } = makeMockContext();

    const result = await executor.run(ctx, 'discover', 'Discover', { job: 'chat' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    assert.strictEqual(result.isError, undefined);
    assert.deepStrictEqual(progressCalls.at(-1), {
      progress: 100,
      total: 100,
      message: 'Discover: completed',
    });
  });

  it('run catches thrown errors and returns AppError results', async () => {
    const executor = createExecutor();
    const { ctx, progressCalls } = makeMockContext();

    const result = await executor.run(ctx, 'discover', 'Discover', {}, async () => {
      throw new Error('boom');
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'discover failed: boom');
    assert.deepStrictEqual(progressCalls.at(-1), {
      progress: 100,
      total: 100,
      message: 'Discover: failed — discover failed: boom',
    });
  });

  it('runStream reports failure once when resultMod converts success into an error', async () => {
    const executor = createExecutor();
    const { ctx, progressCalls } = makeMockContext();

    const result = await executor.runStream(
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
    assert.deepStrictEqual(progressCalls.at(-1), {
      progress: 100,
      total: 100,
      message: 'Execute Code: failed — execution failed',
    });
  });

  it('runStream reports prompt-blocked stream failures', async () => {
    const executor = createExecutor();
    const { ctx, progressCalls } = makeMockContext();

    const result = await executor.runStream(ctx, 'search', 'Web Search', async () =>
      fakeStream([makePromptBlockedChunk('SAFETY')]),
    );

    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(progressCalls.at(-1), {
      progress: 100,
      total: 100,
      message: 'Web Search: failed — search: prompt blocked by safety filter (SAFETY)',
    });
  });

  it('runStream merges shared structured metadata including functionCalls', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();

    const result = await executor.runStream(
      ctx,
      'search',
      'Web Search',
      async () =>
        fakeStream([
          makeChunk([{ functionCall: { name: 'lookupDocs', args: { topic: 'mcp' } } }]),
          makeChunk([{ text: 'answer' }], FinishReason.STOP),
        ]),
      (_streamResult, text) => ({
        structuredContent: {
          answer: text,
        },
      }),
    );

    assert.deepStrictEqual(result.structuredContent, {
      answer: 'answer',
      functionCalls: [{ name: 'lookupDocs', args: { topic: 'mcp' } }],
      toolEvents: [{ kind: 'function_call', name: 'lookupDocs', args: { topic: 'mcp' } }],
    });
  });

  it('runStream merged metadata remains valid for central output enforcement', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();

    const result = await executor.runStream(
      ctx,
      'search',
      'Web Search',
      async () =>
        fakeStream([
          makeChunk([{ functionCall: { name: 'lookupDocs', args: { topic: 'mcp' } } }]),
          makeChunk([{ text: 'answer' }], FinishReason.STOP),
        ]),
      (_streamResult, text) => ({
        structuredContent: {
          answer: text,
          usage: {
            candidatesTokenCount: 2,
            promptTokenCount: 1,
            totalTokenCount: 3,
          },
        },
      }),
    );

    const validated = validateStructuredToolResult(
      'search',
      z.strictObject({
        answer: z.string(),
        functionCalls: z
          .array(
            z.strictObject({
              name: z.string(),
              args: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        toolEvents: z
          .array(
            z.strictObject({
              kind: z.literal('function_call'),
              name: z.string(),
              args: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        usage: z
          .strictObject({
            candidatesTokenCount: z.number().optional(),
            promptTokenCount: z.number().optional(),
            totalTokenCount: z.number().optional(),
          })
          .optional(),
      }),
      result,
    );

    assert.strictEqual(validated.isError, undefined);
    assert.deepStrictEqual(validated.structuredContent, {
      answer: 'answer',
      functionCalls: [{ name: 'lookupDocs', args: { topic: 'mcp' } }],
      toolEvents: [{ kind: 'function_call', name: 'lookupDocs', args: { topic: 'mcp' } }],
      usage: {
        candidatesTokenCount: 2,
        promptTokenCount: 1,
        totalTokenCount: 3,
      },
    });
  });
});
