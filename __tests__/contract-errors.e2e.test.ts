import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  assertNoStructuredContentOnError,
  assertProtocolError,
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

      assertProtocolError(response, -32602, /filePath/i);
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

  it('never returns structuredContent on a failed tool call', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.request('tools/call', {
        arguments: {
          action: 'caches.get',
          cacheName: 'cachedContents/missing-cache',
        },
        name: 'memory',
      });

      assertNoStructuredContentOnError(response.result as ToolCallResult);
    } finally {
      await harness.close();
    }
  });

  it('returns isError:true with non-empty content for every tool when the upstream rejects', async () => {
    const harness = await createHarness();

    try {
      // Each tool below triggers a runtime failure without queueing a stream;
      // the mock environment rejects generateContentStream, so the tool body
      // must surface isError:true with a descriptive content entry.
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
        {
          name: 'memory',
          arguments: {
            action: 'caches.get',
            cacheName: 'cachedContents/missing-cache',
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

  it('rejects unknown top-level keys on chat arguments at the protocol boundary', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'say hi', foo: 'bar' },
        name: 'chat',
      });

      assertProtocolError(response, -32602, /foo|unrecognized|unknown/i);
    } finally {
      await harness.close();
    }
  });

  it('rejects unknown top-level keys on memory arguments at the protocol boundary', async () => {
    const harness = await createHarness();

    try {
      const response = await harness.client.requestRaw('tools/call', {
        arguments: { action: 'sessions.list', foo: 'bar' },
        name: 'memory',
      });

      assertProtocolError(response, -32602, /foo|unrecognized|unknown/i);
    } finally {
      await harness.close();
    }
  });
});
