import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import {
  assertAdvertisedOutputSchema,
  assertRequestValidationFailure,
  assertToolExecutionError,
} from './lib/mcp-contract-assertions.js';
import {
  createServerHarness,
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
  ttl = 60_000,
): Promise<string> {
  const response = await client.request('tools/call', {
    arguments: args,
    name,
    task: { ttl },
  });
  const taskId = (response.result as { task?: { taskId?: string } }).task?.taskId;
  assert.ok(taskId, 'Expected tools/call with task augmentation to return a task ID');
  return taskId;
}

async function getTaskResult(client: JsonRpcTestClient, taskId: string): Promise<ToolCallResult> {
  const response = await client.request('tasks/result', { taskId });
  return response.result as unknown as ToolCallResult;
}

describe('public MCP task lifecycle', () => {
  it('advertises task support metadata for the public tools', async () => {
    const harness = await createHarness();

    try {
      const tools = new Map((await listTools(harness.client)).map((tool) => [tool.name, tool]));

      for (const toolName of ['chat', 'research', 'analyze', 'review', 'memory'] as const) {
        assert.equal(tools.get(toolName)?.execution?.taskSupport, 'optional');
      }
      assert.equal(tools.get('discover')?.execution?.taskSupport, 'forbidden');

      const discoverTaskCall = await harness.client.requestRaw('tools/call', {
        arguments: {},
        name: 'discover',
        task: { ttl: 60_000 },
      });
      assertRequestValidationFailure(discoverTaskCall, -32602, /task|discover/i);
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
});
