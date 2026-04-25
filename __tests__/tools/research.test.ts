import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import { ResearchOutputSchema } from '../../src/schemas/outputs.js';
import { registerResearchTool } from '../../src/tools/research.js';

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

function makeMockContext(
  store: RequestTaskStore,
  options: { onElicitInput?: () => void } = {},
): ServerContext {
  const logs: string[] = [];
  return {
    mcpReq: {
      _meta: {},
      signal: new AbortController().signal,
      log: Object.assign(
        async (_level: string, message: string) => {
          logs.push(message);
        },
        {
          debug: async (message: string) => {
            logs.push(message);
          },
          info: async (message: string) => {
            logs.push(message);
          },
          warning: async (message: string) => {
            logs.push(message);
          },
          error: async (message: string) => {
            logs.push(message);
          },
        },
      ),
      notify: async () => undefined,
      requestSampling: async () => ({ content: [{ type: 'text', text: 'official docs' }] }),
      elicitInput: async () => {
        options.onElicitInput?.();
        return { action: 'accept', content: { text: 'none' } };
      },
    },
    task: {
      store,
      requestedTtl: undefined,
      id: undefined,
    },
    __logs: logs,
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

  registerResearchTool(server);

  return {
    research: handlers.research as ToolTaskHandler<{
      deliverable?: string;
      goal: string;
      mode: 'deep' | 'quick';
      searchDepth?: number;
      thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
      urls?: string[];
      fileSearch?: { fileSearchStoreNames: string[] };
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

function getCapturedLogs(ctx: ServerContext): string[] {
  return ((ctx as unknown as { __logs?: string[] }).__logs ?? []).slice();
}

describe('research tool contracts', () => {
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
      assert.strictEqual((structured as Record<string, unknown>).sources, undefined);
      assert.deepStrictEqual((structured as Record<string, unknown>).sourceDetails, [
        {
          domain: 'example.com',
          origin: 'googleSearch',
          title: 'Example',
          url: 'https://example.com',
        },
      ]);
      assert.strictEqual((structured as Record<string, unknown>).urlContextSources, undefined);
      assert.strictEqual((structured as Record<string, unknown>).status, 'partially_grounded');
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
              content: {
                parts: [
                  { toolCall: { id: 'search-1', toolType: 'GOOGLE_SEARCH_WEB' } },
                  { text: 'Deep research report' },
                ],
              },
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
      assert.strictEqual((structured as Record<string, unknown>).sources, undefined);
      assert.deepStrictEqual((structured as Record<string, unknown>).sourceDetails, [
        {
          domain: 'example.com',
          origin: 'googleSearch',
          title: 'Docs',
          url: 'https://example.com/docs',
        },
      ]);
      assert.deepStrictEqual((structured as Record<string, unknown>).toolsUsed, ['googleSearch']);
      assert.strictEqual((structured as Record<string, unknown>).status, 'partially_grounded');
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('composes fileSearch with googleSearch and urlContext', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    let observedRequest: Record<string, unknown> | undefined;

    // @ts-expect-error test override
    client.models.generateContentStream = async (req: Record<string, unknown>) => {
      observedRequest = req;
      return fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'ok' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);
    };

    try {
      await research.createTask(
        {
          goal: 'test file search',
          mode: 'quick',
          urls: ['https://example.com/context'],
          fileSearch: { fileSearchStoreNames: ['fileSearchStores/research'] },
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const config = observedRequest?.config as Record<string, unknown> | undefined;
      assert.deepStrictEqual(config?.tools, [
        { googleSearch: {} },
        { urlContext: {} },
        { fileSearch: { fileSearchStoreNames: ['fileSearchStores/research'] } },
      ]);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('marks quick research ungrounded when no sources are surfaced', async () => {
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
              content: { parts: [{ text: 'No grounded sources available.' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

    try {
      await research.createTask({ goal: 'thin query', mode: 'quick' }, makeMockContext(store));
      await flushTaskWork();

      const result = store.stored[0]?.result;
      const structured = result?.structuredContent;
      assert.ok(structured && typeof structured === 'object');
      assert.deepStrictEqual((structured as Record<string, unknown>).sources, []);
      assert.ok(
        result?.content.some((entry) =>
          entry.text?.includes('No grounded sources were retrieved; the answer may be ungrounded.'),
        ),
      );
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('separates URL Context-only success from Google Search grounding', async () => {
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
              content: { parts: [{ text: 'URL-only answer' }] },
              finishReason: 'STOP',
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
      await research.createTask(
        { goal: 'url only', mode: 'quick', urls: ['https://example.com/context'] },
        makeMockContext(store),
      );
      await flushTaskWork();

      const structured = store.stored[0]?.result.structuredContent as Record<string, unknown>;
      assert.strictEqual(structured.sources, undefined);
      assert.strictEqual(structured.urlContextSources, undefined);
      assert.deepStrictEqual(structured.sourceDetails, [
        { domain: 'example.com', origin: 'urlContext', url: 'https://example.com/context' },
      ]);
      assert.strictEqual(structured.status, 'partially_grounded');
      assert.deepStrictEqual(structured.groundingSignals, {
        retrievalPerformed: true,
        urlContextUsed: true,
        groundingSupportsCount: 0,
        confidence: 'low',
      });
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('uses search_url_code, primary URL prompts, output shape, and cost profiles for deep URLs', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    const calls: Record<string, unknown>[] = [];

    // @ts-expect-error test override
    client.models.generateContentStream = async (request: Record<string, unknown>) => {
      calls.push(request);
      return fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [
                  { executableCode: { id: 'exec-1', code: 'print(2)', language: 'PYTHON' } },
                  {
                    codeExecutionResult: {
                      id: 'exec-1',
                      outcome: 'OUTCOME_OK',
                      output: '2',
                    },
                  },
                  { executableCode: { code: 'print(3)' } },
                  { text: 'Deep research report' },
                ],
              },
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [
                  { web: { title: 'Report', uri: 'https://example.com/report' } },
                  { web: { title: 'Private', uri: 'file:///etc/passwd' } },
                ],
                groundingSupports: [
                  {
                    groundingChunkIndices: [0],
                    segment: { text: 'Supported claim', startIndex: 0, endIndex: 15 },
                  },
                  {
                    groundingChunkIndices: [1],
                    segment: { text: 'Private claim', startIndex: 16, endIndex: 29 },
                  },
                ],
                searchEntryPoint: { renderedContent: '<div>search</div>' },
              },
              urlContextMetadata: {
                urlMetadata: [
                  {
                    retrievedUrl: 'https://example.com/report',
                    urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
                  },
                ],
              },
            },
          ],
        },
      ]);
    };

    try {
      await research.createTask(
        {
          goal: 'compare approaches',
          deliverable: 'return a decision memo',
          mode: 'deep',
          searchDepth: 4,
          urls: ['https://example.com/report'],
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const planCall = calls[0];
      const retrievalCall = calls.find((entry) => String(entry.contents).includes('Primary URLs:'));
      const synthesisCall = calls.find((entry) =>
        String(entry.contents).includes('Retrieved evidence summaries:'),
      );
      assert.ok(planCall);
      assert.ok(retrievalCall);
      assert.ok(synthesisCall);
      assert.strictEqual(String(retrievalCall.contents).includes('<planning_leads'), true);
      const retrievalConfig = retrievalCall.config as Record<string, unknown>;
      assert.deepStrictEqual(retrievalConfig.tools, [{ googleSearch: {} }, { urlContext: {} }]);
      assert.strictEqual(
        (retrievalConfig.thinkingConfig as Record<string, unknown>).thinkingLevel,
        'LOW',
      );
      const synthesisConfig = synthesisCall.config as Record<string, unknown>;
      assert.deepStrictEqual(synthesisConfig.tools, [{ codeExecution: {} }]);
      assert.strictEqual(
        (synthesisConfig.thinkingConfig as Record<string, unknown>).thinkingLevel,
        'MEDIUM',
      );
      assert.match(String(synthesisConfig.systemInstruction), /Preferred shape:.*decision memo/);
      assert.ok(calls.length >= 4);

      const structured = store.stored[0]?.result.structuredContent as Record<string, unknown>;
      assert.deepStrictEqual(structured.urlMetadata, [
        { url: 'https://example.com/report', status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
      ]);
      assert.strictEqual(structured.sources, undefined);
      assert.strictEqual(structured.urlContextSources, undefined);
      assert.deepStrictEqual(structured.sourceDetails, [
        {
          domain: 'example.com',
          origin: 'both',
          title: 'Report',
          url: 'https://example.com/report',
        },
      ]);
      assert.deepStrictEqual(structured.citations, [
        {
          text: 'Supported claim',
          startIndex: 0,
          endIndex: 15,
          sourceUrls: ['https://example.com/report'],
        },
      ]);
      assert.deepStrictEqual(structured.findings, [
        {
          claim: 'Supported claim',
          supportingSourceUrls: ['https://example.com/report'],
          verificationStatus: 'supported',
        },
      ]);
      assert.strictEqual(
        (structured.groundingSignals as { confidence?: string }).confidence,
        'medium',
      );
      assert.deepStrictEqual((structured.computations as unknown[]).slice(0, 2), [
        {
          id: 'exec-1',
          code: 'print(2)',
          language: 'PYTHON',
          outcome: 'OUTCOME_OK',
          output: '2',
        },
        { code: 'print(3)' },
      ]);
      assert.ok(
        (structured.warnings as string[]).includes('dropped 1 non-public grounding supports'),
      );
      assert.ok(
        (structured.warnings as string[]).some((warning) =>
          warning.includes('non-public grounding chunks'),
        ),
      );
      assert.ok(
        store.stored[0]?.result.content.some((entry) =>
          entry.text?.includes('```PYTHON\nprint(2)\n```'),
        ),
      );
      assert.ok(
        store.stored[0]?.result.content.some((entry) =>
          entry.text?.includes('Google Search Suggestions:\n<div>search</div>'),
        ),
      );
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('preserves explicit thinkingLevel for deep research', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    const calls: Record<string, unknown>[] = [];

    // @ts-expect-error test override
    client.models.generateContentStream = async (request: Record<string, unknown>) => {
      calls.push(request);
      return fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Deep research report' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);
    };

    try {
      await research.createTask(
        {
          goal: 'compare approaches',
          mode: 'deep',
          searchDepth: 4,
          thinkingLevel: 'LOW',
          deliverable: 'short memo',
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const config = calls.find((entry) =>
        String(entry.contents).includes('Retrieved evidence summaries:'),
      )?.config as Record<string, unknown>;
      assert.strictEqual((config.thinkingConfig as Record<string, unknown>).thinkingLevel, 'LOW');
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('makes searchDepth change the number of Gemini stream calls', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    const calls: Record<string, unknown>[] = [];

    // @ts-expect-error test override
    client.models.generateContentStream = async (request: Record<string, unknown>) => {
      calls.push(request);
      return fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Research answer' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);
    };

    try {
      await research.createTask(
        { goal: 'single pass', mode: 'deep', searchDepth: 1 },
        makeMockContext(store),
      );
      await flushTaskWork();
      assert.strictEqual(calls.length, 1);

      calls.length = 0;
      await research.createTask(
        { goal: 'multi pass', mode: 'deep', searchDepth: 3 },
        makeMockContext(store),
      );
      await flushTaskWork();
      assert.ok(calls.length >= 3);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('only elicits extra constraints for deeper research budgets', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    let elicitCount = 0;

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Deep research report' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

    try {
      await research.createTask(
        { goal: 'default depth', mode: 'deep', searchDepth: 3 },
        makeMockContext(store, { onElicitInput: () => elicitCount++ }),
      );
      await research.createTask(
        {
          goal: 'depth four with deliverable',
          mode: 'deep',
          searchDepth: 4,
          deliverable: 'short memo',
        },
        makeMockContext(store, { onElicitInput: () => elicitCount++ }),
      );
      await research.createTask(
        { goal: 'depth four', mode: 'deep', searchDepth: 4 },
        makeMockContext(store, { onElicitInput: () => elicitCount++ }),
      );
      await research.createTask(
        {
          goal: 'depth five',
          mode: 'deep',
          searchDepth: 5,
          deliverable: 'short memo',
        },
        makeMockContext(store, { onElicitInput: () => elicitCount++ }),
      );
      await flushTaskWork();

      assert.strictEqual(elicitCount, 2);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('keeps raw quick-search query text out of MCP log messages', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const ctx = makeMockContext(store);
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
            },
          ],
        },
      ]);

    try {
      await research.createTask({ goal: 'SECRET-QUERY', mode: 'quick' }, ctx);
      await flushTaskWork();

      const messages = getCapturedLogs(ctx);
      assert.ok(messages.includes('Search requested'));
      assert.ok(messages.every((message) => !message.includes('SECRET-QUERY')));
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('keeps raw deep-research topic text out of MCP log messages', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const ctx = makeMockContext(store);
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Deep research answer' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

    try {
      await research.createTask({ goal: 'SECRET-TOPIC', mode: 'deep', searchDepth: 3 }, ctx);
      await flushTaskWork();

      const messages = getCapturedLogs(ctx);
      assert.ok(messages.includes('Agentic search requested'));
      assert.ok(messages.includes('Sampling provided research angles'));
      assert.ok(messages.every((message) => !message.includes('SECRET-TOPIC')));
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('passes maxOutputTokens through to the Gemini config for quick research', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    const calls: Record<string, unknown>[] = [];

    // @ts-expect-error test override
    client.models.generateContentStream = async (request: Record<string, unknown>) => {
      calls.push(request);
      return fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'Quick research answer' }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);
    };

    try {
      await research.createTask(
        { goal: 'latest release', mode: 'quick', maxOutputTokens: 9_999 },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(
        (calls[0]?.config as { maxOutputTokens?: number } | undefined)?.maxOutputTokens,
        9_999,
      );
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });
});
