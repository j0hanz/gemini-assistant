import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { resetProgressThrottle, sendProgress } from '../../src/lib/context.js';

function makeMockContext(overrides: {
  progressToken?: string | number;
  aborted?: boolean;
}): ServerContext {
  const controller = new AbortController();
  if (overrides.aborted) controller.abort();

  return {
    mcpReq: {
      _meta:
        overrides.progressToken !== undefined ? { progressToken: overrides.progressToken } : {},
      signal: controller.signal,
      log: Object.assign(
        async (_level: string, _msg: string) => {
          /* noop */
        },
        {
          debug: async (_msg: string) => {},
          info: async (_msg: string) => {},
          warning: async (_msg: string) => {},
          error: async (_msg: string) => {},
        },
      ),
      notify: async (_notification: unknown) => {
        /* noop */
      },
    },
  } as unknown as ServerContext;
}

describe('sendProgress', () => {
  beforeEach(() => {
    resetProgressThrottle();
  });

  it('is a no-op without progressToken', async () => {
    const ctx = makeMockContext({});
    // Should not throw
    await sendProgress(ctx, 1, 3, 'step 1');
  });

  it('calls notify with progressToken', async () => {
    let notifyCalled = false;
    const ctx = makeMockContext({ progressToken: 'tok-1' });
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async (
      notification: unknown,
    ) => {
      notifyCalled = true;
      const n = notification as {
        method: string;
        params: { progressToken: string; progress: number; total: number; message?: string };
      };
      assert.strictEqual(n.method, 'notifications/progress');
      assert.strictEqual(n.params.progressToken, 'tok-1');
      assert.strictEqual(n.params.progress, 2);
      assert.strictEqual(n.params.total, 5);
      assert.strictEqual(n.params.message, 'uploading');
    };
    await sendProgress(ctx, 2, 5, 'uploading');
    assert.ok(notifyCalled);
  });

  it('omits message when not provided', async () => {
    const ctx = makeMockContext({ progressToken: 'tok-2' });
    let capturedParams: Record<string, unknown> = {};
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async (
      notification: unknown,
    ) => {
      capturedParams = (notification as { params: Record<string, unknown> }).params;
    };
    await sendProgress(ctx, 1, 1);
    assert.strictEqual(capturedParams['message'], undefined);
  });

  it('omits total when not provided (indeterminate)', async () => {
    const ctx = makeMockContext({ progressToken: 'tok-5' });
    let capturedParams: Record<string, unknown> = {};
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async (
      notification: unknown,
    ) => {
      capturedParams = (notification as { params: Record<string, unknown> }).params;
    };
    await sendProgress(ctx, 1, undefined, 'phase 1');
    assert.strictEqual(capturedParams['total'], undefined);
    assert.strictEqual(capturedParams['progress'], 1);
    assert.strictEqual(capturedParams['message'], 'phase 1');
  });

  it('swallows notify errors', async () => {
    const ctx = makeMockContext({ progressToken: 'tok-3' });
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {
      throw new Error('transport closed');
    };
    // Should not throw
    await sendProgress(ctx, 1, 1);
  });

  it('is a no-op when signal is aborted', async () => {
    let notifyCalled = false;
    const ctx = makeMockContext({ progressToken: 'tok-4', aborted: true });
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {
      notifyCalled = true;
    };
    await sendProgress(ctx, 1, 1);
    assert.strictEqual(notifyCalled, false);
  });
});
