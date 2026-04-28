import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import { createServerHarness, type JsonRpcTestClient } from './lib/mcp-contract-client.js';
import { makeChunk, MockGeminiEnvironment } from './lib/mock-gemini-environment.js';

import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-completion';

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

interface CompletionResult {
  completion: {
    hasMore?: boolean;
    total?: number;
    values: string[];
  };
}

async function requestCompletion(
  client: JsonRpcTestClient,
  templateUri: string,
  argumentName: string,
  value: string,
): Promise<CompletionResult> {
  const response = await client.request('completion/complete', {
    argument: { name: argumentName, value },
    ref: { type: 'ref/resource', uri: templateUri },
  });
  return response.result as unknown as CompletionResult;
}

describe('MCP completion/complete for parameterized resources', () => {
  it('returns only prefix-matching, live session IDs for session://{sessionId}', async () => {
    const harness = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: 'seed alpha' }], FinishReason.STOP));
      await harness.client.request('tools/call', {
        arguments: { goal: 'Seed first session', sessionId: 'alpha-one' },
        name: 'chat',
      });

      env.queueStream(makeChunk([{ text: 'seed beta' }], FinishReason.STOP));
      await harness.client.request('tools/call', {
        arguments: { goal: 'Seed second session', sessionId: 'beta-two' },
        name: 'chat',
      });

      const result = await requestCompletion(
        harness.client,
        'session://{sessionId}',
        'sessionId',
        'alpha',
      );

      assert.ok(
        result.completion.values.every((id) => id.startsWith('alpha')),
        `Expected prefix-only session IDs, got: ${JSON.stringify(result.completion.values)}`,
      );
      assert.ok(
        result.completion.values.includes('alpha-one'),
        'Expected seeded session "alpha-one" in completion results',
      );
      assert.ok(
        !result.completion.values.includes('beta-two'),
        'Non-matching session IDs must be excluded',
      );
    } finally {
      await harness.close();
    }
  });

  it('returns matching job values for discover prompt job arg', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.request('completion/complete', {
        argument: { name: 'job', value: 'c' },
        ref: { type: 'ref/prompt', name: 'discover' },
      });
      const result = response.result as unknown as CompletionResult;

      assert.deepStrictEqual(result.completion.values, ['chat']);
    } finally {
      await harness.close();
    }
  });

  it('returns matching mode values for research prompt mode arg', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.request('completion/complete', {
        argument: { name: 'mode', value: 'q' },
        ref: { type: 'ref/prompt', name: 'research' },
      });
      const result = response.result as unknown as CompletionResult;

      assert.deepStrictEqual(result.completion.values, ['quick']);
    } finally {
      await harness.close();
    }
  });

  it('returns matching subject values for review prompt subject arg', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.request('completion/complete', {
        argument: { name: 'subject', value: 'd' },
        ref: { type: 'ref/prompt', name: 'review' },
      });
      const result = response.result as unknown as CompletionResult;

      assert.deepStrictEqual(result.completion.values, ['diff']);
    } finally {
      await harness.close();
    }
  });
});
