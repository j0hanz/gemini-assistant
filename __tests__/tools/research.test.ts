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
      assert.deepStrictEqual((structured as Record<string, unknown>).sources, [
        'https://example.com',
      ]);
      assert.deepStrictEqual((structured as Record<string, unknown>).sourceDetails, [
        { origin: 'googleSearch', title: 'Example', url: 'https://example.com' },
      ]);
      assert.strictEqual((structured as Record<string, unknown>).urlContextSources, undefined);
      assert.strictEqual((structured as Record<string, unknown>).urlContextUsed, false);
      assert.strictEqual((structured as Record<string, unknown>).grounded, true);
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
        { origin: 'googleSearch', title: 'Docs', url: 'https://example.com/docs' },
      ]);
      assert.deepStrictEqual((structured as Record<string, unknown>).toolsUsed, ['googleSearch']);
      assert.strictEqual((structured as Record<string, unknown>).grounded, true);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('resolves orchestration config with additionalTools', async () => {
    const { research } = getHandlers();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    let observedRequest: any;

    // @ts-expect-error test override
    client.models.generateContentStream = async (req: any) => {
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
          goal: 'test tools',
          mode: 'quick',
          additionalTools: [{ functionDeclarations: [{ name: 'test', parameters: {} }] }] as never,
        },
        makeMockContext(store),
      );
      await flushTaskWork();

      const tools = observedRequest?.config?.tools as any[];
      assert.ok(
        tools?.some((t) => 'functionDeclarations' in t),
        'additionalTools were not included',
      );
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
      assert.strictEqual((structured as Record<string, unknown>).grounded, false);
      assert.strictEqual((structured as Record<string, unknown>).urlContextUsed, false);
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
      assert.deepStrictEqual(structured.sources, []);
      assert.deepStrictEqual(structured.urlContextSources, ['https://example.com/context']);
      assert.deepStrictEqual(structured.sourceDetails, [
        { origin: 'urlContext', url: 'https://example.com/context' },
      ]);
      assert.strictEqual(structured.grounded, false);
      assert.strictEqual(structured.urlContextUsed, true);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('uses search_url_code, primary URL prompts, output shape, and HIGH thinking for deep URLs', async () => {
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

      const call = calls[0];
      assert.ok(call);
      assert.strictEqual(String(call.contents).includes('URLs (primary sources):'), true);
      assert.strictEqual(String(call.contents).includes('Planning notes (unverified leads'), true);
      const config = call.config as Record<string, unknown>;
      assert.deepStrictEqual(config.tools, [
        { googleSearch: {} },
        { urlContext: {} },
        { codeExecution: {} },
      ]);
      assert.strictEqual((config.thinkingConfig as Record<string, unknown>).thinkingLevel, 'HIGH');
      assert.match(String(config.systemInstruction), /OUTPUT SHAPE:.*decision memo/);

      const structured = store.stored[0]?.result.structuredContent as Record<string, unknown>;
      assert.deepStrictEqual(structured.urlMetadata, [
        { url: 'https://example.com/report', status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
      ]);
      assert.deepStrictEqual(structured.sources, ['https://example.com/report']);
      assert.deepStrictEqual(structured.urlContextSources, ['https://example.com/report']);
      assert.deepStrictEqual(structured.sourceDetails, [
        { origin: 'both', title: 'Report', url: 'https://example.com/report' },
      ]);
      assert.strictEqual(structured.grounded, true);
      assert.strictEqual(structured.urlContextUsed, true);
      assert.deepStrictEqual(structured.citations, [
        {
          text: 'Supported claim',
          startIndex: 0,
          endIndex: 15,
          sourceUrls: ['https://example.com/report'],
        },
      ]);
      assert.deepStrictEqual(structured.searchEntryPoint, {
        renderedContent: '<div>search</div>',
      });
      assert.deepStrictEqual(structured.warnings, ['dropped 1 non-public grounding supports']);
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

      const config = calls[0]?.config as Record<string, unknown>;
      assert.strictEqual((config.thinkingConfig as Record<string, unknown>).thinkingLevel, 'LOW');
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
