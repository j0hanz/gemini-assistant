import type { ServerContext } from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  AppError,
  CancelledError,
  finishReasonToError,
  resetProgressThrottle,
  SafetyError,
  sendProgress,
  TruncationError,
  ValidationError,
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

describe('AppError', () => {
  it('formats generic errors and non-errors', () => {
    assert.strictEqual(AppError.formatMessage(new Error('network timeout')), 'network timeout');
    assert.strictEqual(AppError.formatMessage('string error'), 'string error');
  });

  it('creates error tool results', () => {
    const result = new AppError('ask', 'something went wrong').toToolResult();
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
  });

  it('classifies retryable and non-retryable Gemini statuses', () => {
    const rateLimited = AppError.from(createStatusError(429, 'Too many requests'), 'ask');
    const forbidden = AppError.from(createStatusError(403, 'Forbidden'), 'ask');
    const missing = AppError.from(createStatusError(404, 'Missing'), 'ask');
    const internal = AppError.from(createStatusError(500, 'Internal'), 'ask');
    const unavailable = AppError.from(createStatusError(503, 'Unavailable'), 'ask');

    assert.strictEqual(rateLimited.category, 'server');
    assert.strictEqual(rateLimited.retryable, true);
    assert.match(rateLimited.message, /Rate limited/);
    assert.strictEqual(forbidden.category, 'client');
    assert.strictEqual(forbidden.retryable, false);
    assert.match(forbidden.message, /Permission denied/);
    assert.strictEqual(missing.category, 'client');
    assert.match(missing.message, /not found/i);
    assert.strictEqual(internal.category, 'server');
    assert.strictEqual(internal.retryable, true);
    assert.strictEqual(unavailable.category, 'server');
    assert.strictEqual(unavailable.retryable, true);
  });

  it('classifies abort and generic errors', () => {
    const cancelled = AppError.from(new DOMException('Aborted', 'AbortError'), 'ask');
    const generic = AppError.from(new Error('boom'), 'ask');

    assert.ok(cancelled instanceof CancelledError);
    assert.strictEqual(cancelled.category, 'cancelled');
    assert.strictEqual(cancelled.retryable, false);
    assert.strictEqual(cancelled.message, 'ask: cancelled by client');
    assert.strictEqual(generic.category, 'internal');
    assert.strictEqual(generic.retryable, false);
    assert.strictEqual(generic.message, 'ask failed: boom');
  });

  it('detects retryability', () => {
    assert.strictEqual(AppError.isRetryable(createStatusError(429)), true);
    assert.strictEqual(AppError.isRetryable(createStatusError(500)), true);
    assert.strictEqual(AppError.isRetryable(createStatusError(503)), true);
    assert.strictEqual(AppError.isRetryable(createStatusError(403)), false);
    assert.strictEqual(AppError.isRetryable(new CancelledError('ask')), false);
    assert.strictEqual(AppError.isRetryable(new SafetyError('ask', 'response_blocked')), false);
  });
});

describe('SafetyError', () => {
  it('formats response-blocked, prompt-blocked, and recitation messages', () => {
    assert.strictEqual(
      new SafetyError('execute_code', 'response_blocked').message,
      'execute_code: response blocked by safety filter',
    );
    assert.strictEqual(
      new SafetyError('ask', 'prompt_blocked', 'SAFETY').message,
      'ask: prompt blocked by safety filter (SAFETY)',
    );
    assert.strictEqual(
      new SafetyError('ask', 'recitation').message,
      'ask: response blocked due to recitation policy',
    );
  });
});

describe('finishReasonToError', () => {
  it('maps safety and recitation finish reasons', () => {
    assert.strictEqual(finishReasonToError(undefined, 'text', 'ask'), undefined);
    assert.ok(finishReasonToError('SAFETY' as never, '', 'execute_code') instanceof SafetyError);
    assert.ok(finishReasonToError('RECITATION' as never, '', 'ask') instanceof SafetyError);
  });

  it('maps max-token truncation only when no text exists', () => {
    const truncated = finishReasonToError('MAX_TOKENS' as never, '', 'search');
    assert.ok(truncated instanceof TruncationError);
    assert.strictEqual(
      truncated?.message,
      'search: response truncated — max tokens reached with no output',
    );
    assert.strictEqual(finishReasonToError('MAX_TOKENS' as never, 'partial', 'search'), undefined);
  });
});

describe('ValidationError', () => {
  it('throws ProtocolError with INVALID_PARAMS code', () => {
    assert.throws(
      () => new ValidationError('bad input'),
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
