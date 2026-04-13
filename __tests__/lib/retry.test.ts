import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withRetry } from '../../src/lib/retry.js';

function createStatusError(status: number, message = 'error'): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

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
