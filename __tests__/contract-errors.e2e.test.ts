import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  assertRequestValidationFailure,
  assertToolExecutionError,
} from './lib/mcp-contract-assertions.js';
import { createServerHarness, type ToolCallResult } from './lib/mcp-contract-client.js';
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

describe('public MCP error taxonomy', () => {
  it('surfaces invalid request shapes through the protocol boundary', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'Summarize this file' },
        name: 'analyze',
      });

      assertRequestValidationFailure(response, -32602, /filePath/i);
    } finally {
      await harness.close();
    }
  });

  it('keeps valid requests with invalid business state as tool errors', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.request('tools/call', {
        arguments: {
          action: 'caches.get',
          cacheName: 'cachedContents/missing-cache',
        },
        name: 'memory',
      });

      assertToolExecutionError(response.result as ToolCallResult, /Missing cache|not found/i);
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
});
