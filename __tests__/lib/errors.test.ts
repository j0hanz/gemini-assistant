import assert from 'node:assert';
import { test } from 'node:test';

import { AppError, isAbortError, withRetry } from '../../src/lib/errors.js';

test('AppError — construction', () => {
  const error = new AppError('chat', 'Something went wrong', 'client');
  assert.strictEqual(error.toolName, 'chat');
  assert.strictEqual(error.category, 'client');
  assert.strictEqual(error.message, 'Something went wrong');
  assert.strictEqual(error.retryable, false);
  assert.strictEqual(error.statusCode, undefined);
});

test('AppError — retryable error sets retryable flag', () => {
  const error = new AppError('chat', 'Timeout', 'transient', true);
  assert.strictEqual(error.retryable, true);
});

test('AppError — custom statusCode', () => {
  const error = new AppError('chat', 'Not found', 'client', false, 404);
  assert.strictEqual(error.statusCode, 404);
});

test('withRetry — non-retryable error throws immediately', async () => {
  const error = new AppError('chat', 'Bad input', 'client', false);
  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw error;
  };

  try {
    await withRetry(fn);
    assert.fail('Should have thrown');
  } catch (e) {
    assert.strictEqual(callCount, 1);
    assert.strictEqual(e, error);
  }
});

test('withRetry — retryable error retries exactly 2 times', async () => {
  const error = new AppError('chat', 'Timeout', 'transient', true);
  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw error;
  };

  try {
    await withRetry(fn);
    assert.fail('Should have thrown');
  } catch (e) {
    assert.strictEqual(callCount, 3);
    assert.strictEqual(e, error);
  }
});

test('withRetry — succeeds on second try', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount === 1) {
      throw new AppError('chat', 'Timeout', 'transient', true);
    }
    return 'success';
  };

  const result = await withRetry(fn);
  assert.strictEqual(result, 'success');
  assert.strictEqual(callCount, 2);
});

test('withRetry — abort signal cancels retry', async () => {
  const controller = new AbortController();
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount === 1) {
      throw new AppError('chat', 'Timeout', 'transient', true);
    }
    return 'success';
  };

  const promise = withRetry(fn, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  try {
    await promise;
    assert.fail('Should have thrown AbortError');
  } catch (e) {
    assert(e instanceof Error);
    assert.strictEqual(e.name, 'AbortError');
  }
});

test('isAbortError — true for AbortError', () => {
  const error = new DOMException('Aborted', 'AbortError');
  assert.strictEqual(isAbortError(error), true);
});

test('isAbortError — false for generic Error', () => {
  const error = new Error('something');
  assert.strictEqual(isAbortError(error), false);
});

test('isAbortError — false for AppError', () => {
  const error = new AppError('chat', 'msg', 'client');
  assert.strictEqual(isAbortError(error), false);
});

test('AppError.isRetryable — ECONNRESET network error is retryable (fallback preserved)', () => {
  const networkError = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  assert.strictEqual(AppError.isRetryable(networkError), true);
});

test('AppError.isRetryable — nested cause ECONNRESET is retryable (fallback preserved)', () => {
  const wrapper = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
  });
  assert.strictEqual(AppError.isRetryable(wrapper), true);
});

test('AppError.from — HTTP 429 error is classified as retryable server error', () => {
  const httpErr = Object.assign(new Error('rate limited'), { status: 429 });
  const appErr = AppError.from(httpErr, 'chat');
  assert.strictEqual(appErr.retryable, true);
  assert.strictEqual(appErr.category, 'server');
});
