import type { ServerContext } from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  errorResult,
  finishReasonError,
  geminiErrorResult,
  promptBlockedMessage,
  promptBlockedResult,
  resetProgressThrottle,
  responseBlockedMessage,
  responseBlockedResult,
  sendProgress,
  throwInvalidParams,
  withRetry,
} from '../../src/lib/errors.js';

// ── Helpers ───────────────────────────────────────────────────────────

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

function createStatusError(status: number, message = 'error'): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// ── errorResult ───────────────────────────────────────────────────────

describe('errorResult', () => {
  it('returns a CallToolResult with isError true', () => {
    const result = errorResult('something went wrong');
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
  });

  it('handles empty string', () => {
    const result = errorResult('');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, '');
  });
});

// ── geminiErrorResult ─────────────────────────────────────────────────

describe('geminiErrorResult', () => {
  it('formats a generic Error', () => {
    const result = geminiErrorResult('ask', new Error('network timeout'));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'ask failed: network timeout');
  });

  it('formats a non-Error value', () => {
    const result = geminiErrorResult('search', 'string error');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'search failed: string error');
  });

  it('maps HTTP 429 to rate-limit message', () => {
    const err = Object.assign(new Error('Too many requests'), { status: 429 });
    const result = geminiErrorResult('ask', err);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Rate limited/);
  });

  it('maps HTTP 403 to permission denied', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /Permission denied/);
  });

  it('maps HTTP 404 to not found', () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    const result = geminiErrorResult('search', err);
    assert.match(result.content[0]?.text ?? '', /not found/);
  });

  it('maps HTTP 500 to server error', () => {
    const err = Object.assign(new Error('Internal'), { status: 500 });
    const result = geminiErrorResult('execute_code', err);
    assert.match(result.content[0]?.text ?? '', /server error/);
  });

  it('maps HTTP 503 to service unavailable', () => {
    const err = Object.assign(new Error('Unavailable'), { status: 503 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /unavailable/);
  });

  it('maps HTTP 400 to bad request', () => {
    const err = Object.assign(new Error('Nope'), { status: 400 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /Bad request/);
  });

  it('handles unknown HTTP status', () => {
    const err = Object.assign(new Error('wat'), { status: 418 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /HTTP 418/);
  });

  it('handles AbortError', () => {
    const err = new DOMException('Aborted', 'AbortError');
    const result = geminiErrorResult('ask', err);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'ask: cancelled by client');
  });
});

describe('blocked-result helpers', () => {
  it('formats response-blocked text exactly once from the shared helper', () => {
    assert.strictEqual(
      responseBlockedMessage('execute_code'),
      'execute_code: response blocked by safety filter',
    );
    assert.deepStrictEqual(responseBlockedResult('execute_code'), {
      content: [{ type: 'text', text: 'execute_code: response blocked by safety filter' }],
      isError: true,
    });
  });

  it('formats prompt-blocked text exactly once from the shared helper', () => {
    assert.strictEqual(
      promptBlockedMessage('ask', 'SAFETY'),
      'ask: prompt blocked by safety filter (SAFETY)',
    );
    assert.deepStrictEqual(promptBlockedResult('ask', 'SAFETY'), {
      content: [{ type: 'text', text: 'ask: prompt blocked by safety filter (SAFETY)' }],
      isError: true,
    });
  });
});

describe('finishReasonError', () => {
  it('normalizes safety finish reasons', () => {
    assert.deepStrictEqual(finishReasonError(undefined, 'text', 'ask'), undefined);
    assert.deepStrictEqual(finishReasonError('SAFETY' as never, '', 'execute_code'), {
      content: [{ type: 'text', text: 'execute_code: response blocked by safety filter' }],
      isError: true,
    });
  });

  it('normalizes recitation and max-token edge cases', () => {
    assert.deepStrictEqual(finishReasonError('RECITATION' as never, '', 'ask'), {
      content: [{ type: 'text', text: 'ask: response blocked due to recitation policy' }],
      isError: true,
    });
    assert.deepStrictEqual(finishReasonError('MAX_TOKENS' as never, '', 'search'), {
      content: [
        {
          type: 'text',
          text: 'search: response truncated — max tokens reached with no output',
        },
      ],
      isError: true,
    });
  });
});

// ── throwInvalidParams ────────────────────────────────────────────────

describe('throwInvalidParams', () => {
  it('throws ProtocolError with INVALID_PARAMS code', () => {
    assert.throws(
      () => throwInvalidParams('bad input'),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === INVALID_PARAMS && err.message === 'bad input',
    );
  });
});

// ── sendProgress ──────────────────────────────────────────────────────

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

  it('bridges progress to task statusMessage when task context exists', async () => {
    let capturedStatus: string | undefined;
    let capturedMessage: string | undefined;
    const ctx = makeMockContext({ progressToken: 'tok-bridge' });
    (ctx as unknown as Record<string, unknown>).task = {
      id: 'task-1',
      store: {
        updateTaskStatus: async (_id: string, status: string, msg?: string) => {
          capturedStatus = status;
          capturedMessage = msg;
        },
      },
    };
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {};

    await sendProgress(ctx, 5, 100, 'Analyzing files');

    assert.strictEqual(capturedStatus, 'working');
    assert.strictEqual(capturedMessage, 'Analyzing files');
  });

  it('does not bridge to task status on terminal progress', async () => {
    let updateCalled = false;
    const ctx = makeMockContext({ progressToken: 'tok-term' });
    (ctx as unknown as Record<string, unknown>).task = {
      id: 'task-2',
      store: {
        updateTaskStatus: async () => {
          updateCalled = true;
        },
      },
    };
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {};

    await sendProgress(ctx, 100, 100, 'Done');

    assert.strictEqual(updateCalled, false);
  });

  it('does not bridge when message is empty', async () => {
    let updateCalled = false;
    const ctx = makeMockContext({ progressToken: 'tok-nomsg' });
    (ctx as unknown as Record<string, unknown>).task = {
      id: 'task-3',
      store: {
        updateTaskStatus: async () => {
          updateCalled = true;
        },
      },
    };
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {};

    await sendProgress(ctx, 5, 100);

    assert.strictEqual(updateCalled, false);
  });

  it('throttles task status updates', async () => {
    let updateCount = 0;
    const ctx = makeMockContext({ progressToken: 'tok-throttle' });
    (ctx as unknown as Record<string, unknown>).task = {
      id: 'task-4',
      store: {
        updateTaskStatus: async () => {
          updateCount++;
        },
      },
    };
    (ctx.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {};

    await sendProgress(ctx, 5, 100, 'step 1');
    await sendProgress(ctx, 10, 100, 'step 2');
    await sendProgress(ctx, 15, 100, 'step 3');

    // Only the first call should bridge due to 5s throttle
    assert.strictEqual(updateCount, 1);
  });

  it('throttles task status updates independently per task', async () => {
    resetProgressThrottle();
    let updateCountA = 0;
    let updateCountB = 0;

    const ctxA = makeMockContext({ progressToken: 'tok-iso-a' });
    (ctxA as unknown as Record<string, unknown>).task = {
      id: 'task-iso-a',
      store: {
        updateTaskStatus: async () => {
          updateCountA++;
        },
      },
    };
    (ctxA.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {};

    const ctxB = makeMockContext({ progressToken: 'tok-iso-b' });
    (ctxB as unknown as Record<string, unknown>).task = {
      id: 'task-iso-b',
      store: {
        updateTaskStatus: async () => {
          updateCountB++;
        },
      },
    };
    (ctxB.mcpReq as { notify: (n: unknown) => Promise<void> }).notify = async () => {};

    // Both tasks should get their first status update independently
    await sendProgress(ctxA, 5, 100, 'step A1');
    await sendProgress(ctxB, 5, 100, 'step B1');

    assert.strictEqual(updateCountA, 1);
    assert.strictEqual(updateCountB, 1);

    // Subsequent calls within the throttle window are still suppressed per-task
    await sendProgress(ctxA, 10, 100, 'step A2');
    await sendProgress(ctxB, 10, 100, 'step B2');

    assert.strictEqual(updateCountA, 1);
    assert.strictEqual(updateCountB, 1);
  });
});

// ── withRetry ─────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'));
    assert.strictEqual(result, 'ok');
  });

  it('retries on 429 and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) throw createStatusError(429);
      return Promise.resolve('recovered');
    });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 2);
  });

  it('retries on 500 and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) throw createStatusError(500);
      return Promise.resolve('recovered');
    });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 2);
  });

  it('retries on 503 and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) throw createStatusError(503);
      return Promise.resolve('recovered');
    });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 2);
  });

  it('throws immediately for non-retryable status (400)', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(() => {
          calls++;
          throw createStatusError(400);
        }),
      { status: 400 },
    );
    assert.strictEqual(calls, 1);
  });

  it('throws immediately for non-Error exceptions', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(() => {
          calls++;
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'string error';
        }),
      (err) => err === 'string error',
    );
    assert.strictEqual(calls, 1);
  });

  it('throws after max retries exhausted', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++;
            throw createStatusError(429);
          },
          { maxRetries: 1 },
        ),
      { status: 429 },
    );
    assert.strictEqual(calls, 2); // 1 initial + 1 retry
  });

  it('respects custom maxRetries', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls <= 3) throw createStatusError(500);
        return Promise.resolve('ok');
      },
      { maxRetries: 3 },
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 4);
  });

  it('does not retry when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++;
            throw createStatusError(429);
          },
          { signal: ac.signal },
        ),
      { status: 429 },
    );
    assert.strictEqual(calls, 1);
  });

  it('retries on 429 with retryAfter hint on error', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) {
        const err = createStatusError(429);
        (err as Record<string, unknown>).retryAfter = 100;
        throw err;
      }
      return Promise.resolve('recovered');
    });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 2);
  });
});
