import assert from 'node:assert';
import { test, mock } from 'node:test';

// sendThoughtDelta will be exported from streaming.ts after TASK-003
// For now this import will fail, which is the expected failure mode.
import { sendThoughtDelta } from '../../src/lib/streaming.js';

test('sendThoughtDelta — emits notifications/gemini-assistant/thought with correct shape', async () => {
  const notifications: unknown[] = [];
  const ctx = {
    mcpReq: {
      signal: { aborted: false },
      _meta: { progressToken: 'tok-1' },
      notify: mock.fn(async (n: unknown) => {
        notifications.push(n);
      }),
    },
  } as unknown as import('../../src/lib/streaming.js').ThoughtDeltaCtx;

  await sendThoughtDelta(ctx, 'hello', 5, 0);

  assert.equal(notifications.length, 1);
  const n = notifications[0] as {
    method: string;
    params: { delta: string; totalLen: number; seq: number; _meta?: unknown };
  };
  assert.equal(n.method, 'notifications/gemini-assistant/thought');
  assert.equal(n.params.delta, 'hello');
  assert.equal(n.params.totalLen, 5);
  assert.equal(n.params.seq, 0);
  assert.deepEqual(n.params._meta, { progressToken: 'tok-1' });
});

test('sendThoughtDelta — omits _meta when no progressToken', async () => {
  const notifications: unknown[] = [];
  const ctx = {
    mcpReq: {
      signal: { aborted: false },
      _meta: undefined,
      notify: mock.fn(async (n: unknown) => {
        notifications.push(n);
      }),
    },
  } as unknown as import('../../src/lib/streaming.js').ThoughtDeltaCtx;

  await sendThoughtDelta(ctx, 'world', 5, 1);

  const n = notifications[0] as { params: { _meta?: unknown } };
  assert.equal(n.params._meta, undefined);
});

test('sendThoughtDelta — does not call notify when signal is aborted', async () => {
  const notifyFn = mock.fn(async () => undefined);
  const ctx = {
    mcpReq: {
      signal: { aborted: true },
      _meta: undefined,
      notify: notifyFn,
    },
  } as unknown as import('../../src/lib/streaming.js').ThoughtDeltaCtx;

  await sendThoughtDelta(ctx, 'ignored', 7, 0);

  assert.equal(notifyFn.mock.calls.length, 0);
});
