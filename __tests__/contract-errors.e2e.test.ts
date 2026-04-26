import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { assertToolExecutionError } from './lib/mcp-contract-assertions.js';
import {
  createServerHarness,
  isJsonRpcFailure,
  type JsonRpcResponse,
  type ToolCallResult,
} from './lib/mcp-contract-client.js';
import { MockGeminiEnvironment } from './lib/mock-gemini-environment.js';

import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-contract-errors';

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

function assertMaterializedToolFailure(
  response: JsonRpcResponse,
  expectedMessagePattern: RegExp,
): void {
  assert.equal(isJsonRpcFailure(response), false);
  if (isJsonRpcFailure(response)) {
    assert.fail(`Unexpected JSON-RPC failure: ${response.error.message}`);
  }
  assertToolExecutionError(response.result as ToolCallResult, expectedMessagePattern);
}

describe('public MCP error taxonomy', () => {
  it('materializes invalid request shapes as tool errors', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'Summarize this file' },
        name: 'analyze',
      });

      assertMaterializedToolFailure(response, /filePath/i);
    } finally {
      await harness.close();
    }
  });

  it('maps controlled runtime failures to tool errors instead of protocol errors', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.request('tools/call', {
        arguments: {
          goal: 'Trigger the mocked runtime failure',
          mode: 'quick',
        },
        name: 'research',
      });

      assertToolExecutionError(
        response.result as ToolCallResult,
        /No mocked Gemini stream queued|research:/i,
      );
    } finally {
      await harness.close();
    }
  });

  it('returns isError:true with non-empty content for every tool when the upstream rejects', async () => {
    const harness = await createHarness();

    try {
      const toolFailureCases: { name: string; arguments: Record<string, unknown> }[] = [
        { name: 'chat', arguments: { goal: 'force runtime failure' } },
        { name: 'research', arguments: { goal: 'force runtime failure', mode: 'quick' } },
        {
          name: 'analyze',
          arguments: {
            goal: 'force runtime failure',
            targetKind: 'file',
            filePath: 'src/client.ts',
            outputKind: 'summary',
          },
        },
        {
          name: 'review',
          arguments: {
            subjectKind: 'failure',
            error: 'force runtime failure',
            language: 'typescript',
          },
        },
      ];

      for (const testCase of toolFailureCases) {
        const response = await harness.client.request('tools/call', {
          arguments: testCase.arguments,
          name: testCase.name,
        });
        const result = response.result as ToolCallResult;
        assert.equal(result.isError, true, `${testCase.name} failure must carry isError:true`);
        assert.ok(
          Array.isArray(result.content) && result.content.length >= 1,
          `${testCase.name} failure must carry non-empty content[]`,
        );
        assert.equal(
          (result as { structuredContent?: unknown }).structuredContent,
          undefined,
          `${testCase.name} failure must not carry structuredContent`,
        );
      }
    } finally {
      await harness.close();
    }
  });

  it('materializes unknown top-level keys on chat arguments as tool errors', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'say hi', foo: 'bar' },
        name: 'chat',
      });

      assertMaterializedToolFailure(response, /foo|unrecognized|unknown/i);
    } finally {
      await harness.close();
    }
  });

  it('materializes functionResponses without a sessionId as a chat tool error', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Continue after a tool result',
          functionResponses: [{ id: 'call-1', name: 'lookup_order', response: { output: 'ok' } }],
        },
        name: 'chat',
      });

      assertMaterializedToolFailure(response, /functionResponses requires sessionId/i);
    } finally {
      await harness.close();
    }
  });
});
