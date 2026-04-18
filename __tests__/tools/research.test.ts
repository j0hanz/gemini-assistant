import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import {
  AgenticSearchOutputSchema,
  ResearchOutputSchema,
  SearchOutputSchema,
} from '../../src/schemas/outputs.js';
import {
  registerAgenticSearchTool,
  registerAnalyzeUrlTool,
  registerResearchTool,
  registerSearchTool,
} from '../../src/tools/research-job.js';

process.env.API_KEY ??= 'test-key-for-research-tools';

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
      requestSampling: async () => ({ content: [{ type: 'text', text: 'official docs' }] }),
    },
    task: {
      store,
      requestedTtl: undefined,
      id: undefined,
    },
  } as unknown as ServerContext;
}

function getHandlers() {
  const handlers: Record<string, ToolTaskHandler<never> | undefined> = {};

  const server = {
    experimental: {
      tasks: {
        registerToolTask: (name: string, _config: unknown, handler: ToolTaskHandler<never>) => {
          handlers[name] = handler;
        },
      },
    },
  } as never;

  registerSearchTool(server);
  registerAnalyzeUrlTool(server);
  registerAgenticSearchTool(server);
  registerResearchTool(server);

  return {
    agentic_search: handlers.agentic_search as ToolTaskHandler<{
      searchDepth?: number;
      thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
      topic: string;
    }>,
    analyze_url: handlers.analyze_url as ToolTaskHandler<{
      question: string;
      urls: string[];
    }>,
    research: handlers.research as ToolTaskHandler<{
      deliverable?: string;
      goal: string;
      mode: 'deep' | 'quick';
      searchDepth?: number;
      thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
      urls?: string[];
    }>,
    search: handlers.search as ToolTaskHandler<{
      query: string;
      urls?: string[];
    }>,
  };
}

async function flushTaskWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function* fakeStream(chunks: unknown[]): AsyncGenerator {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('research tool contracts', () => {
  it('stores a schema-valid grounded search result', async () => {
    const { search } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Result summary' }] },
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com' } }],
              },
              urlContextMetadata: {
                urlMetadata: [
                  {
                    retrievedUrl: 'https://example.com/context',
                    urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
                  },
                ],
              },
            },
          ],
        },
      ]);

    try {
      await search.createTask(
        { query: 'latest release', urls: ['https://example.com/context'] },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'completed');
      const structured = store.stored[0]?.result.structuredContent;
      const parsed = SearchOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.deepStrictEqual(structured, {
        answer: 'Result summary',
        sources: ['https://example.com'],
        sourceDetails: [{ title: 'Example', url: 'https://example.com' }],
        urlMetadata: [
          {
            url: 'https://example.com/context',
            status: 'URL_RETRIEVAL_STATUS_SUCCESS',
          },
        ],
      });
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('stores normalized analyze_url prompt-block failures', async () => {
    const { analyze_url } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([{ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }]);

    try {
      await analyze_url.createTask(
        { urls: ['https://example.com'], question: 'summarize' },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'failed');
      const firstContent = store.stored[0]?.result.content[0];
      assert.ok(firstContent);
      assert.strictEqual(firstContent.type, 'text');
      assert.strictEqual(
        firstContent.text,
        'analyze_url: prompt blocked by safety filter (SAFETY)',
      );
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('stores a schema-valid agentic search result with functionCalls metadata', async () => {
    const { agentic_search } = getHandlers();
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
                parts: [{ functionCall: { name: 'rankSources', args: { limit: 3 } } }],
              },
              groundingMetadata: {
                groundingChunks: [{ web: { title: 'Docs', uri: 'https://example.com/docs' } }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [{ text: '# Report\n\nGrounded answer' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

    try {
      await agentic_search.createTask(
        { topic: 'mcp tools', searchDepth: 2 },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'completed');
      const structured = store.stored[0]?.result.structuredContent;
      const parsed = AgenticSearchOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.deepStrictEqual(structured, {
        report: '# Report\n\nGrounded answer',
        sources: ['https://example.com/docs'],
        sourceDetails: [{ title: 'Docs', url: 'https://example.com/docs' }],
        toolsUsed: ['googleSearch', 'rankSources'],
        functionCalls: [{ name: 'rankSources', args: { limit: 3 } }],
        toolEvents: [{ kind: 'function_call', name: 'rankSources', args: { limit: 3 } }],
      });
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('stores a schema-valid quick research result with normalized mode and summary', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Quick research answer' }] },
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com' } }],
              },
            },
          ],
        },
      ]);

    try {
      await research.createTask(
        { goal: 'latest release', mode: 'quick', urls: ['https://example.com'] },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'completed');
      const structured = store.stored[0]?.result.structuredContent;
      const parsed = ResearchOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.ok(structured && typeof structured === 'object');
      assert.strictEqual((structured as Record<string, unknown>).mode, 'quick');
      assert.strictEqual((structured as Record<string, unknown>).summary, 'Quick research answer');
      assert.deepStrictEqual((structured as Record<string, unknown>).sources, [
        'https://example.com',
      ]);
      assert.deepStrictEqual((structured as Record<string, unknown>).sourceDetails, [
        { title: 'Example', url: 'https://example.com' },
      ]);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('stores a schema-valid deep research result with deliverable text folded into the summary', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Deep research report' }] },
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [{ web: { title: 'Docs', uri: 'https://example.com/docs' } }],
              },
            },
          ],
        },
      ]);

    try {
      await research.createTask(
        {
          goal: 'compare approaches',
          deliverable: 'return a short memo',
          mode: 'deep',
          searchDepth: 2,
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'completed');
      const structured = store.stored[0]?.result.structuredContent;
      const parsed = ResearchOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.ok(structured && typeof structured === 'object');
      assert.strictEqual((structured as Record<string, unknown>).mode, 'deep');
      assert.strictEqual((structured as Record<string, unknown>).summary, 'Deep research report');
      assert.deepStrictEqual((structured as Record<string, unknown>).sources, [
        'https://example.com/docs',
      ]);
      assert.deepStrictEqual((structured as Record<string, unknown>).sourceDetails, [
        { title: 'Docs', url: 'https://example.com/docs' },
      ]);
      assert.deepStrictEqual((structured as Record<string, unknown>).toolsUsed, ['googleSearch']);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });
});
