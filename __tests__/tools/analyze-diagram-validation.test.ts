import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';

import { getAI } from '../../src/client.js';
import { AnalyzeOutputSchema } from '../../src/schemas/outputs.js';
import { registerAnalyzeTool } from '../../src/tools/analyze.js';

process.env.API_KEY ??= 'test-key-for-analyze-validation';

let originalCacheEnv: string | undefined;

interface ToolTaskHandler<TArgs> {
  createTask: (args: TArgs, ctx: ServerContext) => Promise<{ task: Task }>;
}

function makeMockStore(): RequestTaskStore & {
  stored: {
    result: {
      content: { text?: string; type: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    status: string;
    taskId: string;
  }[];
} {
  const stored: {
    result: {
      content: { text?: string; type: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    status: string;
    taskId: string;
  }[] = [];

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

function makeMockContext(store: RequestTaskStore): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      signal: new AbortController().signal,
      log: Object.assign(async () => undefined, {
        debug: async () => undefined,
        info: async () => undefined,
        warning: async () => undefined,
        error: async () => undefined,
      }),
      notify: async () => undefined,
    },
    task: {
      store,
      requestedTtl: undefined,
      id: undefined,
    },
  } as unknown as ServerContext;
}

function getHandlers() {
  const handlers: Record<string, ToolTaskHandler<Record<string, unknown>> | undefined> = {};

  const server = {
    experimental: {
      tasks: {
        registerToolTask: (
          name: string,
          _config: unknown,
          handler: ToolTaskHandler<Record<string, unknown>>,
        ) => {
          handlers[name] = handler;
        },
      },
    },
  } as never;

  registerAnalyzeTool(server);

  const analyze = handlers.analyze;
  assert.ok(analyze);
  return { analyze };
}

async function flushTaskWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function* fakeStream(
  chunks: GenerateContentResponse[],
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('analyze diagram validation', () => {
  beforeEach(() => {
    originalCacheEnv = process.env.CACHE;
    process.env.CACHE = 'false';
  });

  afterEach(() => {
    if (originalCacheEnv === undefined) {
      delete process.env.CACHE;
    } else {
      process.env.CACHE = originalCacheEnv;
    }
  });

  it('populates syntaxValid when code execution succeeds', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    codeExecutionResult: {
                      id: 'code-1',
                      outcome: 'OUTCOME_OK',
                    },
                  },
                  { text: '```mermaid\nflowchart TD\nA-->B\n```' },
                ],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]);

    try {
      await analyze.createTask(
        {
          goal: 'Generate a diagram',
          outputKind: 'diagram',
          diagramType: 'mermaid',
          targetKind: 'url',
          urls: ['https://example.com'],
          validateSyntax: true,
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const structured = store.stored[0]?.result.structuredContent;
      const parsed = AnalyzeOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.strictEqual(parsed.data.syntaxValid, true);
      assert.strictEqual(parsed.data.syntaxErrors, undefined);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('populates syntaxErrors when code execution reports a failure', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    codeExecutionResult: {
                      id: 'code-1',
                      outcome: 'OUTCOME_ERROR',
                      output: 'Parse error on line 1',
                    },
                  },
                  { text: '```mermaid\nflowchart TD\nA-->B\n```' },
                ],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]);

    try {
      await analyze.createTask(
        {
          goal: 'Generate a diagram',
          outputKind: 'diagram',
          diagramType: 'mermaid',
          targetKind: 'url',
          urls: ['https://example.com'],
          validateSyntax: true,
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const structured = store.stored[0]?.result.structuredContent;
      const parsed = AnalyzeOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.strictEqual(parsed.data.syntaxValid, false);
      assert.deepStrictEqual(parsed.data.syntaxErrors, ['Parse error on line 1']);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('emits a warning when validation was requested but code execution was not invoked', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: '```mermaid\nflowchart TD\nA-->B\n```' }] },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]);

    try {
      await analyze.createTask(
        {
          goal: 'Generate a diagram',
          outputKind: 'diagram',
          diagramType: 'mermaid',
          targetKind: 'url',
          urls: ['https://example.com'],
          validateSyntax: true,
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const structured = store.stored[0]?.result.structuredContent;
      const parsed = AnalyzeOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.strictEqual(parsed.data.syntaxValid, undefined);
      assert.strictEqual(parsed.data.syntaxErrors, undefined);
      assert.deepStrictEqual(parsed.data.warnings, [
        'diagram syntax validation requested but Code Execution was not invoked',
      ]);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('leaves syntax fields absent when validation was not requested', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: '```mermaid\nflowchart TD\nA-->B\n```' }] },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]);

    try {
      await analyze.createTask(
        {
          goal: 'Generate a diagram',
          outputKind: 'diagram',
          diagramType: 'mermaid',
          targetKind: 'url',
          urls: ['https://example.com'],
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const structured = store.stored[0]?.result.structuredContent;
      const parsed = AnalyzeOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.strictEqual(parsed.data.syntaxValid, undefined);
      assert.strictEqual(parsed.data.syntaxErrors, undefined);
      assert.strictEqual(parsed.data.warnings, undefined);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('marks unlabeled fences as syntax invalid instead of silently accepting them', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: '```\nflowchart TD\nA-->B\n```' }] },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]);

    try {
      await analyze.createTask(
        {
          goal: 'Generate a diagram',
          outputKind: 'diagram',
          diagramType: 'mermaid',
          targetKind: 'url',
          urls: ['https://example.com'],
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const structured = store.stored[0]?.result.structuredContent;
      const parsed = AnalyzeOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.strictEqual(parsed.data.syntaxValid, false);
      assert.deepStrictEqual(parsed.data.syntaxErrors, [
        'Gemini returned an unlabeled fenced block; expected ```mermaid',
      ]);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });
});
