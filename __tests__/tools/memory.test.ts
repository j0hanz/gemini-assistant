import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MemoryInput } from '../../src/schemas/inputs.js';
import { memoryWork } from '../../src/tools/memory.js';

function createContext(): ServerContext {
  return {
    mcpReq: {
      _meta: {},
      log: async () => undefined,
      notify: async () => undefined,
      signal: new AbortController().signal,
    },
  } as unknown as ServerContext;
}

describe('memoryWork', () => {
  it('fails closed for unsupported actions', async () => {
    const result = await memoryWork(
      {} as never,
      () => Promise.resolve([]),
      () => Promise.resolve({ content: [{ type: 'text', text: 'unused' }] }),
      { action: 'unknown.action' } as unknown as MemoryInput,
      createContext(),
    );

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Unsupported action 'unknown\.action'/);
  });
});
