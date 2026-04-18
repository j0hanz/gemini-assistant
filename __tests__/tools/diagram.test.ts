import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAI } from '../../src/client.js';
import { createDiagramWork } from '../../src/tools/diagram.js';

process.env.API_KEY ??= 'test-key-for-diagram';

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

describe('generate_diagram cache prompt integration', () => {
  it('keeps a concise live diagram instruction when using cacheName', async () => {
    const diagramWork = createDiagramWork((async () => ['c:/gemini-assistant']) as never);
    const client = getAI();
    const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
    let observedArgs: Record<string, unknown> | undefined;

    // @ts-expect-error test override
    client.models.generateContentStream = async (args: Record<string, unknown>) => {
      observedArgs = args;
      return fakeStream('```mermaid\nflowchart TD\nA-->B\n```');
    };

    try {
      const result = await diagramWork(
        {
          cacheName: 'cachedContents/workspace-1',
          description: 'Show the request flow',
          diagramType: 'mermaid',
        },
        makeContext(),
      );

      assert.strictEqual(result.isError, undefined);
      const config = observedArgs?.config as Record<string, unknown> | undefined;
      const contents = observedArgs?.contents as { text?: string }[] | undefined;
      assert.strictEqual(config?.cachedContent, 'cachedContents/workspace-1');
      assert.strictEqual(config?.systemInstruction, undefined);
      assert.ok(Array.isArray(contents));
      assert.deepStrictEqual(contents, [
        { text: 'Return exactly one fenced ```mermaid block.' },
        { text: 'Task: Show the request flow' },
      ]);
    } finally {
      client.models.generateContentStream = originalGenerateContentStream;
    }
  });
});
