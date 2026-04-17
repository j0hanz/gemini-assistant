import type { RequestTaskStore, ServerContext, Task } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import { ExecuteCodeOutputSchema } from '../../src/schemas/outputs.js';
import { registerExecuteCodeTool } from '../../src/tools/diagram.js';

process.env.API_KEY ??= 'test-key-for-execution-tools';

interface ExecuteCodeTaskHandler {
  createTask: (
    args: { language?: string; task: string },
    ctx: ServerContext,
  ) => Promise<{ task: Task }>;
}

function makeMockStore(overrides?: {
  getTask?: RequestTaskStore['getTask'];
  storeTaskResult?: RequestTaskStore['storeTaskResult'];
  updateTaskStatus?: RequestTaskStore['updateTaskStatus'];
}): RequestTaskStore & {
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
    getTask:
      overrides?.getTask ?? (async (taskId: string) => ({ taskId, status: 'completed' }) as Task),
    getTaskResult: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    storeTaskResult:
      overrides?.storeTaskResult ??
      (async (taskId: string, status: string, result) => {
        stored.push({ taskId, status, result });
      }),
    updateTaskStatus: overrides?.updateTaskStatus ?? (async () => undefined),
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

function getExecuteCodeHandler(): ExecuteCodeTaskHandler {
  let executeCodeHandler: ExecuteCodeTaskHandler | undefined;

  registerExecuteCodeTool({
    experimental: {
      tasks: {
        registerToolTask: (name: string, _config: unknown, handler: ExecuteCodeTaskHandler) => {
          if (name === 'execute_code') {
            executeCodeHandler = handler;
          }
        },
      },
    },
  } as never);

  assert.ok(executeCodeHandler);
  return executeCodeHandler;
}

async function flushTaskWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function* fakeStream(chunks: unknown[]): AsyncGenerator {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('execute_code contract', () => {
  it('stores a schema-valid success result', async () => {
    const handler = getExecuteCodeHandler();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([
        { candidates: [{ content: { parts: [{ executableCode: { code: 'print(2 + 2)' } }] } }] },
        {
          candidates: [
            {
              content: {
                parts: [{ codeExecutionResult: { output: '4', outcome: 'OUTCOME_OK' } }],
              },
            },
          ],
        },
        {
          candidates: [
            { content: { parts: [{ text: 'Calculated the sum.' }] }, finishReason: 'STOP' },
          ],
        },
      ]);

    try {
      await handler.createTask(
        { task: 'add two numbers', language: 'python' },
        makeMockContext(store),
      );
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'completed');
      const structured = store.stored[0]?.result.structuredContent;
      const parsed = ExecuteCodeOutputSchema.safeParse(structured);
      assert.ok(parsed.success);
      assert.deepStrictEqual(structured, {
        code: 'print(2 + 2)',
        output: '4',
        explanation: 'Calculated the sum.',
        runtime: 'python',
        requestedLanguage: 'python',
        toolEvents: [
          { kind: 'executable_code', code: 'print(2 + 2)' },
          { kind: 'code_execution_result', outcome: 'OUTCOME_OK', output: '4' },
        ],
      });
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('stores the normalized blocked-response message when no parts are returned', async () => {
    const handler = getExecuteCodeHandler();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      fakeStream([{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }]);

    try {
      await handler.createTask({ task: 'run code' }, makeMockContext(store));
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'failed');
      const firstContent = store.stored[0]?.result.content[0];
      assert.ok(firstContent);
      assert.strictEqual(firstContent.type, 'text');
      assert.strictEqual(firstContent.text, 'execute_code: response blocked by safety filter');
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });

  it('stores normalized provider failures', async () => {
    const handler = getExecuteCodeHandler();
    const store = makeMockStore();
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);

    // @ts-expect-error test override
    client.models.generateContentStream = async () =>
      (async function* (): AsyncGenerator {
        yield* [];
        const err = Object.assign(new Error('Too many requests'), { status: 429 });
        throw err;
      })();

    try {
      await handler.createTask({ task: 'run code' }, makeMockContext(store));
      await flushTaskWork();

      assert.strictEqual(store.stored[0]?.status, 'failed');
      const firstContent = store.stored[0]?.result.content[0];
      assert.ok(firstContent);
      assert.strictEqual(firstContent.type, 'text');
      assert.strictEqual(
        firstContent.text,
        'execute_code failed: Rate limited — try again later — Too many requests',
      );
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });
});
