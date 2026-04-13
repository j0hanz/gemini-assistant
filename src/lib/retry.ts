import { hasHttpStatus } from './errors.js';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;
const JITTER_MS = 500;

function isRetryableError(err: unknown): boolean {
  return hasHttpStatus(err) && RETRYABLE_STATUS_CODES.has(err.status);
}

function computeDelay(attempt: number): number {
  const exponential = Math.min(Math.pow(2, attempt) * BASE_DELAY_MS, MAX_DELAY_MS);
  const jitter = Math.random() * JITTER_MS;
  return exponential + jitter;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; signal?: AbortSignal },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableError(err)) throw err;
      if (options?.signal?.aborted) throw err;

      await new Promise<void>((resolve, reject) => {
        const delay = computeDelay(attempt);

        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };

        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delay);

        if (options?.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
}
