import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractToolContext } from '../../src/lib/context.js';

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

describe('extractToolContext', () => {
  it('returns signal from context', () => {
    const ctx = makeMockContext({});
    const tc = extractToolContext(ctx);
    assert.ok(tc.signal instanceof AbortSignal);
    assert.strictEqual(tc.signal.aborted, false);
  });

  it('returns aborted signal when context is aborted', () => {
    const ctx = makeMockContext({ aborted: true });
    const tc = extractToolContext(ctx);
    assert.strictEqual(tc.signal.aborted, true);
  });

  it('reportProgress is a no-op without progressToken', async () => {
    const ctx = makeMockContext({});
    const tc = extractToolContext(ctx);
    // Should not throw
    await tc.reportProgress(1, 3, 'step 1');
  });

  it('reportProgress calls notify with progressToken', async () => {
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
    const tc = extractToolContext(ctx);
    await tc.reportProgress(2, 5, 'uploading');
    assert.ok(notifyCalled);
  });

  it('reportProgress omits message when not provided', async () => {
    const ctx = makeMockContext({ progressToken: 'tok-2' });
    let capturedParams: Record<string, unknown> = {};
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async (
      notification: unknown,
    ) => {
      capturedParams = (notification as { params: Record<string, unknown> }).params;
    };
    const tc = extractToolContext(ctx);
    await tc.reportProgress(1, 1);
    assert.strictEqual(capturedParams['message'], undefined);
  });

  it('reportProgress swallows notify errors', async () => {
    const ctx = makeMockContext({ progressToken: 'tok-3' });
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {
      throw new Error('transport closed');
    };
    const tc = extractToolContext(ctx);
    // Should not throw
    await tc.reportProgress(1, 1);
  });

  it('reportProgress is a no-op when signal is aborted', async () => {
    let notifyCalled = false;
    const ctx = makeMockContext({ progressToken: 'tok-4', aborted: true });
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {
      notifyCalled = true;
    };
    const tc = extractToolContext(ctx);
    await tc.reportProgress(1, 1);
    assert.strictEqual(notifyCalled, false);
  });
});
