import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import { explainErrorWork } from '../../src/tools/explain-error.js';

process.env.API_KEY ??= 'test-key-for-explain-error';

async function* fakeStream(text: string): AsyncGenerator {
  yield {
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
  };
}

function makeContext(): ServerContext {
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
  } as unknown as ServerContext;
}

describe('explain_error cache prompt integration', () => {
  it('keeps concise live guidance when using cacheName', async () => {
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    let observedArgs: Record<string, unknown> | undefined;

    // @ts-expect-error test override
    client.models.generateContentStream = async (args: Record<string, unknown>) => {
      observedArgs = args;
      return fakeStream('## Cause\n\nBad cache');
    };

    try {
      const result = await explainErrorWork(
        {
          cacheName: 'cachedContents/workspace-1',
          error: 'TypeError: boom',
          googleSearch: true,
        },
        makeContext(),
      );

      assert.strictEqual(result.isError, undefined);
      const contents = observedArgs?.contents;
      const config = observedArgs?.config as Record<string, unknown> | undefined;
      assert.strictEqual(config?.cachedContent, 'cachedContents/workspace-1');
      assert.strictEqual(config?.systemInstruction, undefined);
      assert.strictEqual(typeof contents, 'string');
      assert.match(String(contents), /TASK: Diagnose the error\./);
      assert.match(String(contents), /## Error/);
      assert.match(String(contents), /## Task/);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });
});
