import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import {
  assertAdvertisedOutputSchema,
  assertToolExecutionError,
} from './lib/mcp-contract-assertions.js';
import {
  createServerHarness,
  flushEventLoop,
  isJsonRpcFailure,
  type JsonRpcTestClient,
  type ToolCallResult,
  type ToolInfo,
} from './lib/mcp-contract-client.js';
import {
  createDeferredStream,
  makeChunk,
  MockGeminiEnvironment,
} from './lib/mock-gemini-environment.js';

import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-tasks';

let env: MockGeminiEnvironment;

beforeEach(() => {
  env = new MockGeminiEnvironment();
  env.install();
});

afterEach(() => {
  env.restore();
});

async function createHarness() {
  return await createServerHarness(
    createServerInstance,
    { capabilities: { roots: {} } },
    { autoInitialize: true, flushAfterServerClose: 2, flushBeforeClose: 2 },
  );
}

async function listTools(client: JsonRpcTestClient): Promise<ToolInfo[]> {
  const tools = await client.request('tools/list');
  return (tools.result.tools as ToolInfo[]) ?? [];
}

async function createTask(
  client: JsonRpcTestClient,
  name: string,
  args: Record<string, unknown>,
  ttl?: number,
): Promise<string> {
  const response = await client.request('tools/call', {
    arguments: args,
    name,
    task: ttl === undefined ? {} : { ttl },
  });
  const taskId = (response.result as { task?: { taskId?: string } }).task?.taskId;
  assert.ok(taskId, 'Expected tools/call with task augmentation to return a task ID');
  return taskId;
}

async function getTaskResult(client: JsonRpcTestClient, taskId: string): Promise<ToolCallResult> {
  const response = await client.request('tasks/result', { taskId });
  return response.result as unknown as ToolCallResult;
}

function getRelatedTaskId(result: ToolCallResult): string | undefined {
  for (const item of result.content as Record<string, unknown>[]) {
    if (item.type !== 'resource_link') {
      continue;
    }

    const meta = item._meta;
    if (!meta || typeof meta !== 'object') {
      continue;
    }

    const related = (meta as Record<string, unknown>)['io.modelcontextprotocol/related-task'];
    if (!related || typeof related !== 'object') {
      continue;
    }

    const taskId = (related as { taskId?: unknown }).taskId;
    if (typeof taskId === 'string') {
      return taskId;
    }
  }

  return undefined;
}

describe('public MCP task lifecycle', () => {
  it('advertises task support metadata for the public tools', async () => {
    const harness = await createHarness();

    try {
      const tools = new Map((await listTools(harness.client)).map((tool) => [tool.name, tool]));

      for (const toolName of ['chat', 'research', 'analyze', 'review', 'memory'] as const) {
        assert.equal(tools.get(toolName)?.execution?.taskSupport, 'optional');
      }
      assert.strictEqual(tools.has('discover'), false);
    } finally {
      await harness.close();
    }
  });

  it('supports read-only and mutable tool tasks end to end', async () => {
    const harness = await createHarness();

    try {
      const tools = new Map((await listTools(harness.client)).map((tool) => [tool.name, tool]));

      const deferred = createDeferredStream(
        makeChunk([{ text: 'Deferred research answer' }], FinishReason.STOP, {
          groundingMetadata: {
            groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com/task' } }],
          },
        }),
      );
      env.queueGenerator(deferred.stream);

      const researchTaskId = await createTask(harness.client, 'research', {
        goal: 'Research with deferred completion',
        mode: 'quick',
      });

      const listedTasks = await harness.client.request('tasks/list');
      assert.ok(
        ((listedTasks.result.tasks as { taskId?: string }[]) ?? []).some(
          (task) => task.taskId === researchTaskId,
        ),
      );

      const pendingTask = await harness.client.request('tasks/get', { taskId: researchTaskId });
      assert.match(String(pendingTask.result.status), /submitted|working/i);

      deferred.release();

      const researchResult = await getTaskResult(harness.client, researchTaskId);
      assert.notEqual(researchResult.isError, true);
      const researchTool = tools.get('research');
      assert.ok(researchTool);
      assertAdvertisedOutputSchema(researchTool, researchResult);

      const completedTask = await harness.client.request('tasks/get', { taskId: researchTaskId });
      assert.equal(completedTask.result.status, 'completed');

      const memoryTaskId = await createTask(harness.client, 'memory', {
        action: 'sessions.list',
      });
      const memoryResult = await getTaskResult(harness.client, memoryTaskId);
      assert.notEqual(memoryResult.isError, true);
      const memoryTool = tools.get('memory');
      assert.ok(memoryTool);
      assertAdvertisedOutputSchema(memoryTool, memoryResult);

      const completedMemoryTask = await harness.client.request('tasks/get', {
        taskId: memoryTaskId,
      });
      assert.equal(completedMemoryTask.result.status, 'completed');
    } finally {
      await harness.close();
    }
  });

  it('maps tool-level task failures to failed task status', async () => {
    const harness = await createHarness();

    try {
      const failedTaskId = await createTask(harness.client, 'memory', {
        action: 'caches.get',
        cacheName: 'cachedContents/missing-cache',
      });

      const failedResult = await getTaskResult(harness.client, failedTaskId);
      assertToolExecutionError(failedResult, /Missing cache|not found/i);

      const failedTask = await harness.client.request('tasks/get', { taskId: failedTaskId });
      assert.equal(failedTask.result.status, 'failed');
    } finally {
      await harness.close();
    }
  });

  it('cancels an in-flight task and leaves no terminal task result stored', async () => {
    const harness = await createHarness();

    try {
      const deferred = createDeferredStream(
        makeChunk([{ text: 'Deferred research answer' }], FinishReason.STOP),
      );
      env.queueGenerator(deferred.stream);

      const taskId = await createTask(
        harness.client,
        'research',
        {
          goal: 'Cancellation probe',
          mode: 'quick',
        },
        60_000,
      );

      const cancelledTask = await harness.client.request('tasks/cancel', { taskId });
      assert.equal(cancelledTask.result.status, 'cancelled');
      assert.equal(cancelledTask.result.ttl, 60_000);

      const latestTask = await harness.client.request('tasks/get', { taskId });
      assert.equal(latestTask.result.status, 'cancelled');
      assert.equal(latestTask.result.statusMessage, 'Client cancelled task execution.');

      deferred.release();
      await flushEventLoop(2);

      const resultResponse = await harness.client.requestRaw('tasks/result', { taskId });
      assert.equal(isJsonRpcFailure(resultResponse), true);
      if (!isJsonRpcFailure(resultResponse)) {
        assert.fail('Expected tasks/result to fail for a cancelled task with no stored result');
      }
      assert.match(resultResponse.error.message, /has no result stored/i);
    } finally {
      await harness.close();
    }
  });

  it('defaults task ttl to 300000 when omitted', async () => {
    const harness = await createHarness();

    try {
      const taskId = await createTask(
        harness.client,
        'memory',
        {
          action: 'sessions.list',
        },
        undefined,
      );

      const task = await harness.client.request('tasks/get', { taskId });
      assert.equal(task.result.ttl, 300_000);
      assert.equal(task.result.pollInterval, 1000);
    } finally {
      await harness.close();
    }
  });

  it('forwards explicit ttl unchanged', async () => {
    const harness = await createHarness();

    try {
      const taskId = await createTask(
        harness.client,
        'memory',
        {
          action: 'sessions.list',
        },
        60_000,
      );

      const task = await harness.client.request('tasks/get', { taskId });
      assert.equal(task.result.ttl, 60_000);
      assert.equal(task.result.pollInterval, 1000);
    } finally {
      await harness.close();
    }
  });

  it('preserves related-task metadata on task-associated session resource links', async () => {
    const harness = await createHarness();

    try {
      const deferred = createDeferredStream(
        makeChunk([{ text: 'Task chat answer' }], FinishReason.STOP),
      );
      env.queueGenerator(deferred.stream);

      const taskId = await createTask(harness.client, 'chat', {
        goal: 'Start a task-backed chat session',
        sessionId: 'task-session',
      });

      deferred.release();

      const result = await getTaskResult(harness.client, taskId);
      assert.equal(getRelatedTaskId(result), taskId);
    } finally {
      await harness.close();
    }
  });

  it('preserves related-task metadata on memory resource links', async () => {
    const harness = await createHarness();

    try {
      const taskId = await createTask(harness.client, 'memory', {
        action: 'sessions.list',
      });

      await flushEventLoop(2);

      const result = await getTaskResult(harness.client, taskId);
      assert.equal(getRelatedTaskId(result), taskId);
    } finally {
      await harness.close();
    }
  });

  it('surfaces input validation failures through tasks/result instead of JSON-RPC', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Research with invalid mode',
          mode: 'not-a-valid-mode',
        },
        name: 'research',
        task: { ttl: 60_000 },
      });

      assert.equal(isJsonRpcFailure(response), false);
      if (isJsonRpcFailure(response)) {
        assert.fail(`Unexpected JSON-RPC failure: ${response.error.message}`);
      }

      const taskId = (response.result as { task?: { taskId?: string } }).task?.taskId;
      assert.ok(taskId, 'Expected invalid task input to still return a task ID');

      const failedTask = await harness.client.request('tasks/get', { taskId });
      assert.equal(failedTask.result.status, 'failed');

      const failedResult = await getTaskResult(harness.client, taskId);
      assert.equal(failedResult.isError, true);
      assert.match(
        failedResult.content[0]?.text ?? '',
        /Input validation error|Invalid arguments|research failed/i,
      );
    } finally {
      await harness.close();
    }
  });
});
