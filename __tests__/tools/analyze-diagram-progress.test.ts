import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';
import { InMemoryTaskMessageQueue } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';

import { getAI } from '../../src/client.js';
import { resetProgressThrottle } from '../../src/lib/errors.js';
import { registerAnalyzeTool } from '../../src/tools/analyze.js';

process.env.API_KEY ??= 'test-key-for-analyze-progress';

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
  progressCalls: { progress: number; total?: number; message?: string }[];
} {
  const progressCalls: { progress: number; total?: number; message?: string }[] = [];

  const ctx = {
    mcpReq: {
      _meta: { progressToken: 'analyze-token' },
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
    task: {
      store,
      requestedTtl: undefined,
      id: undefined,
    },
  } as unknown as ServerContext;

  return { ctx, progressCalls };
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

  registerAnalyzeTool(server, new InMemoryTaskMessageQueue());

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
    resetProgressThrottle();
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
          { progress: 1, total: 4 },
          { progress: 2, total: 4 },
          { progress: 3, total: 4 },
        ],
      );

      const generatingCall = progressCalls.find(
        (call) => call.message === 'Analyze Diagram: Generating mermaid diagram',
      );
      assert.deepStrictEqual(generatingCall, {
        progress: 3,
        total: 4,
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
        total: 1,
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
          { progress: 0, total: 3, message: 'Analyze: Uploading package.json' },
          { progress: 1, total: 3, message: 'Analyze: Uploading tsconfig.json' },
        ],
      );

      const analyzingCall = progressCalls.find(
        (call) => call.message === 'Analyze: Analyzing content',
      );
      assert.deepStrictEqual(analyzingCall, {
        progress: 2,
        total: 3,
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
});
