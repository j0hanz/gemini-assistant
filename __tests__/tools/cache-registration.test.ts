import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerCacheTools } from '../../src/tools/cache.js';

describe('cache tool registration contract', () => {
  it('keeps list_caches as the synchronous read-only outlier', () => {
    const registeredTools: string[] = [];
    const registeredTaskTools: string[] = [];

    registerCacheTools({
      registerTool: (name: string) => {
        registeredTools.push(name);
      },
      experimental: {
        tasks: {
          registerToolTask: (name: string) => {
            registeredTaskTools.push(name);
          },
        },
      },
    } as never);

    assert.deepStrictEqual(registeredTools, ['list_caches']);
    assert.deepStrictEqual(registeredTaskTools, ['create_cache', 'delete_cache', 'update_cache']);
  });
});
