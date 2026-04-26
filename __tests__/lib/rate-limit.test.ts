import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRateLimiter } from '../../src/lib/rate-limit.js';

describe('createRateLimiter', () => {
  it('bounds the bucket count and evicts the oldest bucket when over capacity', () => {
    let currentTime = 0;
    const rateLimiter = createRateLimiter({
      burst: 1,
      maxBuckets: 2,
      now: () => currentTime,
      rps: 1,
    });

    assert.strictEqual(rateLimiter.take('a'), true);
    assert.strictEqual(rateLimiter.take('b'), true);
    assert.strictEqual(rateLimiter.take('c'), true);

    currentTime += 1;
    assert.strictEqual(rateLimiter.take('a'), true);
  });

  it('sweeps idle buckets after the configured ttl', () => {
    let currentTime = 0;
    const rateLimiter = createRateLimiter({
      burst: 1,
      idleTtlMs: 100,
      now: () => currentTime,
      rps: 1,
    });

    assert.strictEqual(rateLimiter.take('idle'), true);
    assert.strictEqual(rateLimiter.take('idle'), false);

    currentTime = 150;
    assert.strictEqual(rateLimiter.take('active'), true);
    assert.strictEqual(rateLimiter.take('idle'), true);
  });
});
