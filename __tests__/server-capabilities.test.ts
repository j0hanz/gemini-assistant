import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServerInstance } from '../src/server.js';

describe('server capabilities', () => {
  it('advertises completions capability on createServerInstance()', async () => {
    const instance = createServerInstance();
    try {
      const capabilities = (
        instance.server as unknown as {
          server?: { _capabilities?: { completions?: unknown } };
        }
      ).server?._capabilities;

      assert.ok(capabilities);
      assert.deepStrictEqual(capabilities?.completions, {});
    } finally {
      await instance.close();
    }
  });
});
