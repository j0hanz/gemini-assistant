import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

import { FinishReason, FunctionCallingConfigMode } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';
import { z } from 'zod/v4';

import { getAI } from '../../src/client.js';
import { getGeminiModel } from '../../src/config.js';
import { Logger } from '../../src/lib/logger.js';
import { resetProgressThrottle } from '../../src/lib/progress.js';
import { validateStructuredToolResult } from '../../src/lib/response.js';
import { registerTaskTool } from '../../src/lib/tasks.js';
import { ToolExecutor } from '../../src/lib/tool-executor.js';

process.env.API_KEY ??= 'test-key-for-tool-executor';

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

function makeMockTaskStore(): RequestTaskStore & {
  stored: { taskId: string; status: string; result: { isError?: boolean } }[];
} {
  const stored: { taskId: string; status: string; result: { isError?: boolean } }[] = [];

  return {
    stored,
    createTask: async () => ({ taskId: 'task-1' }) as Task,
    getTask: async (taskId: string) => ({ taskId, status: 'completed' }) as Task,
    getTaskResult: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    storeTaskResult: async (taskId: string, status: string, result) => {
      stored.push({ taskId, status, result });
    },
    updateTaskStatus: async () => undefined,
    listTasks: async () => ({ tasks: [] }),
  };
}

function makeMockTaskContext(store: RequestTaskStore): {
  ctx: ServerContext;
  progressCalls: { progress: number; total?: number; message?: string }[];
} {
  const { ctx, progressCalls } = makeMockContext();
  return {
    ctx: {
      ...ctx,
      task: {
        store,
        requestedTtl: undefined,
        id: undefined,
      },
    } as unknown as ServerContext,
    progressCalls,
  };
}

function makeMockTaskToolServer() {
  let capturedHandler:
    | {
        createTask: (args: { input: string }, ctx: ServerContext) => Promise<{ task: Task }>;
      }
    | undefined;

  const server = {
    experimental: {
      tasks: {
        registerToolTask: (_name: string, _config: unknown, handler: typeof capturedHandler) => {
          capturedHandler = handler;
        },
      },
    },
  } as unknown as { experimental: { tasks: { registerToolTask: typeof Function } } };

  return {
    server: server as never,
    getHandler: () => {
      assert.ok(capturedHandler);
      return capturedHandler;
    },
  };
}

async function flushTaskWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
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

  it('run rethrows ProtocolError instances unchanged', async () => {
    const executor = createExecutor();
    const { ctx, progressCalls } = makeMockContext();

    await assert.rejects(
      () =>
        executor.run(ctx, 'discover', 'Discover', {}, async () => {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad');
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.strictEqual(error.message, 'bad');
        return true;
      },
    );

    assert.deepStrictEqual(progressCalls, []);
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

  it('runStream does not synthesize structuredContent when the caller does not provide it', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();

    const result = await executor.runStream(ctx, 'search', 'Web Search', async () =>
      fakeStream([makeChunk([{ text: 'answer' }], FinishReason.STOP)]),
    );

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.structuredContent, undefined);
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
      diagnostics: {
        toolEvents: [{ kind: 'function_call', name: 'lookupDocs', args: { topic: 'mcp' } }],
      },
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
          diagnostics: {
            usage: {
              candidatesTokenCount: 2,
              promptTokenCount: 1,
              totalTokenCount: 3,
            },
          },
        },
      }),
    );

    const validated = validateStructuredToolResult(
      'search',
      z.strictObject({
        answer: z.string(),
        diagnostics: z
          .strictObject({
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
          })
          .optional(),
      }),
      result,
    );

    assert.strictEqual(validated.isError, undefined);
    assert.deepStrictEqual(validated.structuredContent, {
      answer: 'answer',
      diagnostics: {
        toolEvents: [{ kind: 'function_call', name: 'lookupDocs', args: { topic: 'mcp' } }],
        usage: {
          candidatesTokenCount: 2,
          promptTokenCount: 1,
          totalTokenCount: 3,
        },
      },
    });
  });

  it('runStream merges result overlays and structured content exactly once', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();

    const result = await executor.runStream(
      ctx,
      'search',
      'Web Search',
      async () => fakeStream([makeChunk([{ text: 'answer' }], FinishReason.STOP)]),
      (_streamResult, text) => ({
        resultMod: () => ({
          structuredContent: {
            answer: text,
            overlayOnly: true,
          },
        }),
        structuredContent: {
          builtOnly: true,
        },
      }),
    );

    assert.deepStrictEqual(result.structuredContent, {
      answer: 'answer',
      overlayOnly: true,
      builtOnly: true,
    });
  });

  it('runGeminiStream resolves orchestration and forwards generation config fields', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);
    let capturedRequest: Record<string, unknown> | undefined;

    // @ts-expect-error test override
    client.models.generateContentStream = async (request: Record<string, unknown>) => {
      capturedRequest = request;
      return fakeStream([makeChunk([{ text: 'answer' }], FinishReason.STOP)]);
    };

    try {
      const result = await executor.runGeminiStream(ctx, {
        toolName: 'search',
        label: 'Web Search',
        orchestration: {
          builtInToolNames: ['urlContext'],
          urls: ['https://example.com/docs'],
        },
        buildContents: (activeCapabilities) => {
          assert.strictEqual(activeCapabilities.has('urlContext'), true);
          return {
            contents: 'prompt text',
            systemInstruction: 'system text',
          };
        },
        config: {
          costProfile: 'research.quick',
          thinkingBudget: 32,
          maxOutputTokens: 123,
        },
        responseBuilder: (_streamResult, text) => ({ structuredContent: { answer: text } }),
      });

      assert.strictEqual(result.isError, undefined);
      assert.deepStrictEqual(result.structuredContent, { answer: 'answer' });
      assert.strictEqual(capturedRequest?.model, getGeminiModel());
      assert.strictEqual(capturedRequest?.contents, 'prompt text');
      const config = capturedRequest?.config as {
        abortSignal?: AbortSignal;
        maxOutputTokens?: number;
        systemInstruction?: string;
        tools?: unknown[];
      };
      assert.strictEqual(config.systemInstruction, 'system text');
      assert.strictEqual(config.maxOutputTokens, 123);
      assert.strictEqual(config.abortSignal, ctx.mcpReq.signal);
      assert.deepStrictEqual(config.tools, [{ urlContext: {} }]);
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('runGeminiStream forwards resolved functionCallingMode into generateContent config', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);
    let capturedRequest: Record<string, unknown> | undefined;

    // @ts-expect-error test override
    client.models.generateContentStream = async (request: Record<string, unknown>) => {
      capturedRequest = request;
      return fakeStream([makeChunk([{ text: 'answer' }], FinishReason.STOP)]);
    };

    try {
      const result = await executor.runGeminiStream(ctx, {
        toolName: 'search',
        label: 'Web Search',
        orchestration: {
          builtInToolNames: ['googleSearch'],
          functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }],
        },
        buildContents: () => ({ contents: 'prompt text' }),
        config: {
          costProfile: 'research.quick',
        },
      });

      assert.strictEqual(result.isError, undefined);
      const config = capturedRequest?.config as {
        toolConfig?: {
          functionCallingConfig?: { mode?: FunctionCallingConfigMode };
          includeServerSideToolInvocations?: boolean;
        };
      };
      assert.strictEqual(
        config.toolConfig?.functionCallingConfig?.mode,
        FunctionCallingConfigMode.VALIDATED,
      );
      assert.strictEqual(config.toolConfig?.includeServerSideToolInvocations, true);
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('runGeminiStream returns URL validation errors before model calls', async () => {
    const executor = createExecutor();
    const { ctx, progressCalls } = makeMockContext();
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);
    let modelCalled = false;

    // @ts-expect-error test override
    client.models.generateContentStream = async () => {
      modelCalled = true;
      return fakeStream([makeChunk([{ text: 'unexpected' }], FinishReason.STOP)]);
    };

    try {
      const result = await executor.runGeminiStream(ctx, {
        toolName: 'search',
        label: 'Web Search',
        orchestration: { builtInToolNames: ['urlContext'], urls: ['http://localhost:3000'] },
        buildContents: () => ({ contents: 'prompt' }),
        config: { costProfile: 'research.quick' },
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(modelCalled, false);
      assert.match(String(result.content[0]?.text ?? ''), /Private, loopback, and localhost URLs/);
      assert.deepStrictEqual(progressCalls.at(-1), {
        progress: 100,
        total: 100,
        message: `Web Search: failed — ${String(result.content[0]?.text ?? '')}`,
      });
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('runGeminiStream runs Gemini preflight before model calls', async () => {
    const executor = createExecutor();
    const { ctx } = makeMockContext();
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);
    let modelCalled = false;

    // @ts-expect-error test override
    client.models.generateContentStream = async () => {
      modelCalled = true;
      return fakeStream([makeChunk([{ text: 'unexpected' }], FinishReason.STOP)]);
    };

    try {
      const result = await executor.runGeminiStream(ctx, {
        toolName: 'search',
        label: 'Web Search',
        orchestration: { builtInToolNames: ['codeExecution'] },
        buildContents: () => ({ contents: 'prompt' }),
        config: {
          costProfile: 'research.quick',
          responseSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
        },
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(modelCalled, false);
      assert.strictEqual(
        result.content[0]?.type === 'text' ? result.content[0].text : '',
        'chat: responseSchema cannot be combined with codeExecution',
      );
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('registerTaskTool emits a single terminal completion from the inner stream executor', async () => {
    const store = makeMockTaskStore();
    const { ctx, progressCalls } = makeMockTaskContext(store);
    const { server, getHandler } = makeMockTaskToolServer();
    const executor = createExecutor();

    registerTaskTool(
      server,
      'test_stream',
      {
        title: 'Test Stream',
        description: 'test',
        inputSchema: z.strictObject({ input: z.string() }),
        outputSchema: z.strictObject({ answer: z.string() }),
        annotations: {},
      },
      async (_args, taskCtx) =>
        executor.runStream(
          taskCtx,
          'inner_stream',
          'Inner Stream',
          async () => fakeStream([makeChunk([{ text: 'stream answer' }], FinishReason.STOP)]),
          (_streamResult, text) => ({
            structuredContent: { answer: text },
            reportMessage: '3 sources found',
          }),
        ),
    );

    await getHandler().createTask({ input: 'ok' }, ctx);
    await flushTaskWork();

    assert.strictEqual(store.stored[0]?.status, 'completed');
    const terminalCalls = progressCalls.filter(
      (call) => call.progress === 100 && call.total === 100,
    );
    assert.deepStrictEqual(terminalCalls, [
      {
        progress: 100,
        total: 100,
        message: 'Inner Stream: 3 sources found',
      },
    ]);
  });

  it('registerTaskTool emits a single terminal failure from the inner stream executor', async () => {
    const store = makeMockTaskStore();
    const { ctx, progressCalls } = makeMockTaskContext(store);
    const { server, getHandler } = makeMockTaskToolServer();
    const executor = createExecutor();

    registerTaskTool(
      server,
      'test_stream',
      {
        title: 'Test Stream',
        description: 'test',
        inputSchema: z.strictObject({ input: z.string() }),
        outputSchema: z.strictObject({ answer: z.string() }),
        annotations: {},
      },
      async (_args, taskCtx) =>
        executor.runStream(taskCtx, 'inner_stream', 'Inner Stream', async () => {
          throw new Error('boom');
        }),
    );

    await getHandler().createTask({ input: 'ok' }, ctx);
    await flushTaskWork();

    assert.strictEqual(store.stored[0]?.status, 'failed');
    const terminalCalls = progressCalls.filter(
      (call) => call.progress === 100 && call.total === 100,
    );
    assert.deepStrictEqual(terminalCalls, [
      {
        progress: 100,
        total: 100,
        message: 'Inner Stream: failed — inner_stream failed: boom',
      },
    ]);
  });
});
