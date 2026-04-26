import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';

import { getAI } from '../../src/client.js';
import { resetProgressThrottle } from '../../src/lib/progress.js';
import { buildDiagramFencePattern, registerAnalyzeTool } from '../../src/tools/analyze.js';

process.env.API_KEY ??= 'test-key-for-analyze-progress';

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

function makeMockContext(store: RequestTaskStore): {
  ctx: ServerContext;
  logs: { level: string; message: string }[];
  progressCalls: { progress: number; total?: number; message?: string }[];
} {
  const logs: { level: string; message: string }[] = [];
  const progressCalls: { progress: number; total?: number; message?: string }[] = [];

  const ctx = {
    mcpReq: {
      _meta: { progressToken: 'analyze-token' },
      signal: new AbortController().signal,
      log: Object.assign(
        async (level: string, message: string) => {
          logs.push({ level, message });
        },
        {
          debug: async (message: string) => logs.push({ level: 'debug', message }),
          info: async (message: string) => logs.push({ level: 'info', message }),
          warning: async (message: string) => logs.push({ level: 'warning', message }),
          error: async (message: string) => logs.push({ level: 'error', message }),
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
    task: {
      store,
      requestedTtl: undefined,
      id: undefined,
    },
  } as unknown as ServerContext;

  return { ctx, logs, progressCalls };
}

function getHandlers() {
  const handlers: Record<string, ToolTaskHandler<Record<string, unknown>> | undefined> = {};
  const workspaceRootUri = pathToFileURL(process.cwd()).href;

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
    server: {
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots: async () => ({
        roots: [{ uri: workspaceRootUri, name: 'workspace' }],
      }),
    },
  } as never;

  registerAnalyzeTool(server);

  const analyze = handlers.analyze;
  assert.ok(analyze);
  return { analyze };
}

async function flushTaskWork(
  predicate: () => boolean,
  { maxMs = 2_000, stepMs = 5 }: { maxMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function* fakeStream(
  chunks: GenerateContentResponse[],
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('analyze diagram progress', () => {
  beforeEach(() => {
    originalCacheEnv = process.env.CACHE;
    process.env.CACHE = 'false';
    resetProgressThrottle();
  });

  afterEach(() => {
    if (originalCacheEnv === undefined) {
      delete process.env.CACHE;
    } else {
      process.env.CACHE = originalCacheEnv;
    }
  });

  it('builds diagram fence patterns that require the requested language tag', () => {
    const pattern = buildDiagramFencePattern('mermaid');

    assert.ok(pattern.test('```mermaid\nflowchart TD\nA-->B\n```'));
    assert.strictEqual(pattern.test('```\nflowchart TD\nA-->B\n```'), false);
    assert.strictEqual(pattern.test('```plantuml\nAlice -> Bob\n```'), false);
  });

  it('reports uploaded file counts and generating step from logical file count', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const { ctx, progressCalls } = makeMockContext(store);
    const client = getAI();
    const originalUpload = client.files.upload.bind(client.files);
    const originalDelete = client.files.delete.bind(client.files);
    const originalGenerate = client.models.generateContentStream.bind(client.models);
    let uploadCount = 0;

    // @ts-expect-error test override
    client.files.upload = async (opts: { file: string; config?: { mimeType?: string } }) => {
      uploadCount += 1;
      return {
        uri: `gs://files/${basename(opts.file)}`,
        mimeType: opts.config?.mimeType ?? 'text/plain',
        name: `uploaded-${uploadCount}`,
      };
    };
    // @ts-expect-error test override
    client.files.delete = async () => undefined;
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
          targetKind: 'multi',
          filePaths: ['package.json', 'tsconfig.json', 'README.md'],
        },
        ctx,
      );
      await flushTaskWork(() => store.stored.length > 0);

      assert.strictEqual(store.stored[0]?.status, 'completed');

      const uploadCalls = progressCalls.filter((call) =>
        call.message?.startsWith('Analyze Diagram: Uploaded '),
      );
      assert.deepStrictEqual(
        uploadCalls.map((call) => ({ progress: call.progress, total: call.total })),
        [
          { progress: 2, total: 100 },
          { progress: 5, total: 100 },
          { progress: 7, total: 100 },
        ],
      );

      const generatingCall = progressCalls.find(
        (call) => call.message === 'Analyze Diagram: Generating mermaid diagram',
      );
      assert.deepStrictEqual(generatingCall, {
        progress: 7,
        total: 100,
        message: 'Analyze Diagram: Generating mermaid diagram',
      });

      const terminalCalls = progressCalls.filter(
        (call) => call.progress === 100 && call.total === 100,
      );
      assert.strictEqual(terminalCalls.length, 1);
    } finally {
      client.files.upload = originalUpload;
      client.files.delete = originalDelete;
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('keeps the url diagram branch at a single generating step', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const { ctx, progressCalls } = makeMockContext(store);
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);

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
        ctx,
      );
      await flushTaskWork(() => store.stored.length > 0);

      assert.strictEqual(store.stored[0]?.status, 'completed');

      const generatingCall = progressCalls.find(
        (call) => call.message === 'Analyze Diagram: Generating mermaid diagram',
      );
      assert.deepStrictEqual(generatingCall, {
        progress: 0,
        total: 100,
        message: 'Analyze Diagram: Generating mermaid diagram',
      });
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('emits per-file upload steps and analyzing step for multi-file analyze', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const { ctx, progressCalls } = makeMockContext(store);
    const client = getAI();
    const originalUpload = client.files.upload.bind(client.files);
    const originalDelete = client.files.delete.bind(client.files);
    const originalGenerate = client.models.generateContentStream.bind(client.models);
    let uploadCount = 0;

    // @ts-expect-error test override
    client.files.upload = async (opts: { file: string; config?: { mimeType?: string } }) => {
      uploadCount += 1;
      return {
        uri: `gs://files/${basename(opts.file)}`,
        mimeType: opts.config?.mimeType ?? 'text/plain',
        name: `uploaded-${uploadCount}`,
      };
    };
    // @ts-expect-error test override
    client.files.delete = async () => undefined;
    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: { parts: [{ text: 'summary' }] },
              finishReason: FinishReason.STOP,
            },
          ],
        } as GenerateContentResponse,
      ]);

    try {
      await analyze.createTask(
        {
          goal: 'Summarize these files',
          outputKind: 'summary',
          targetKind: 'multi',
          filePaths: ['package.json', 'tsconfig.json'],
        },
        ctx,
      );
      await flushTaskWork(() => store.stored.length > 0);

      assert.strictEqual(store.stored[0]?.status, 'completed');

      const uploadCalls = progressCalls.filter((call) =>
        call.message?.startsWith('Analyze: Uploading '),
      );
      assert.deepStrictEqual(
        uploadCalls.map((call) => ({
          progress: call.progress,
          total: call.total,
          message: call.message,
        })),
        [
          { progress: 0, total: 100, message: 'Analyze: Uploading package.json' },
          { progress: 3, total: 100, message: 'Analyze: Uploading tsconfig.json' },
        ],
      );

      const analyzingCall = progressCalls.find(
        (call) => call.message === 'Analyze: Analyzing content',
      );
      assert.deepStrictEqual(analyzingCall, {
        progress: 6,
        total: 100,
        message: 'Analyze: Analyzing content',
      });

      const terminalCalls = progressCalls.filter(
        (call) => call.progress === 100 && call.total === 100,
      );
      assert.strictEqual(terminalCalls.length, 1);

      const uploadIdx = progressCalls.findIndex(
        (call) => call.message === 'Analyze: Uploading tsconfig.json',
      );
      const analyzingIdx = progressCalls.findIndex(
        (call) => call.message === 'Analyze: Analyzing content',
      );
      assert.ok(uploadIdx >= 0 && analyzingIdx > uploadIdx);
    } finally {
      client.files.upload = originalUpload;
      client.files.delete = originalDelete;
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('returns formatted fenced diagram markdown as the primary content text', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const { ctx } = makeMockContext(store);
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [{ text: '```mermaid\nflowchart TD\nA-->B\n```\n\nExplanation text.' }],
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
        },
        ctx,
      );
      await flushTaskWork(() => store.stored.length > 0);

      const stored = store.stored[0];
      assert.ok(stored);
      assert.strictEqual(stored.status, 'completed');

      const firstText = stored.result.content.find(
        (part) => part.type === 'text' && typeof part.text === 'string',
      );
      assert.ok(firstText?.text);
      assert.match(firstText.text, /^### Diagram\n\n```mermaid\nflowchart TD\nA-->B\n```/);
      assert.match(firstText.text, /### Explanation\n\nExplanation text\./);

      const structured = stored.result.structuredContent as {
        diagram: string;
        diagramType: string;
        explanation?: string;
      };
      assert.strictEqual(structured.diagramType, 'mermaid');
      assert.strictEqual(structured.diagram, 'flowchart TD\nA-->B');
      assert.strictEqual(structured.explanation, 'Explanation text.');
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });

  it('falls back to unlabeled diagram fences and logs a warning', async () => {
    const { analyze } = getHandlers();
    const store = makeMockStore();
    const { ctx, logs } = makeMockContext(store);
    const client = getAI();
    const originalGenerate = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [{ text: '```\nflowchart TD\nA-->B\n```\n\nExplanation text.' }],
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
        },
        ctx,
      );
      await flushTaskWork(() => store.stored.length > 0);

      const structured = store.stored[0]?.result.structuredContent as {
        diagram: string;
      };
      assert.strictEqual(structured.diagram, 'flowchart TD\nA-->B');
      assert.ok(
        logs.some(
          (entry) =>
            entry.level === 'warning' &&
            entry.message.includes('returned an unlabeled diagram fence'),
        ),
      );
    } finally {
      client.models.generateContentStream = originalGenerate;
    }
  });
});
