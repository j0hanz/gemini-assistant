import assert from 'node:assert';
import { test } from 'node:test';

import { ResourceMemo } from '../../src/lib/resource-memo.js';

test('ResourceMemo — returns cached value within TTL', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const result1 = await memo.get('key1', 5000, async () => {
    buildCount++;
    return 'value1';
  });

  const result2 = await memo.get('key1', 5000, async () => {
    buildCount++;
    return 'value1-modified';
  });

  assert.strictEqual(result1, 'value1');
  assert.strictEqual(result2, 'value1');
  assert.strictEqual(buildCount, 1);
});

test('ResourceMemo — rebuilds after TTL expires', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const result1 = await memo.get('key1', 100, async () => {
    buildCount++;
    return 'value1';
  });

  assert.strictEqual(result1, 'value1');
  assert.strictEqual(buildCount, 1);

  // Wait for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 150));

  const result2 = await memo.get('key1', 100, async () => {
    buildCount++;
    return 'value2';
  });

  assert.strictEqual(result2, 'value2');
  assert.strictEqual(buildCount, 2);
});

test('ResourceMemo — single-flight — concurrent reads share one build', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(
      memo.get('concurrent-key', 5000, async () => {
        buildCount++;
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'concurrent-value';
      }),
    );
  }

  const results = await Promise.all(promises);

  assert.strictEqual(results.length, 5);
  assert(results.every((r) => r === 'concurrent-value'));
  // Only 1 build should happen despite 5 concurrent calls
  assert.strictEqual(buildCount, 1);
});

test('ResourceMemo — invalidate forces rebuild', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const result1 = await memo.get('key1', 5000, async () => {
    buildCount++;
    return 'value1';
  });

  assert.strictEqual(result1, 'value1');
  assert.strictEqual(buildCount, 1);

  memo.invalidate('key1');

  const result2 = await memo.get('key1', 5000, async () => {
    buildCount++;
    return 'value2';
  });

  assert.strictEqual(result2, 'value2');
  assert.strictEqual(buildCount, 2);
});

test('ResourceMemo — invalidate() with no key clears all', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const result1 = await memo.get('key1', 5000, async () => {
    buildCount++;
    return 'value1';
  });

  const result2 = await memo.get('key2', 5000, async () => {
    buildCount++;
    return 'value2';
  });

  assert.strictEqual(result1, 'value1');
  assert.strictEqual(result2, 'value2');
  assert.strictEqual(buildCount, 2);

  memo.invalidate();

  const result3 = await memo.get('key1', 5000, async () => {
    buildCount++;
    return 'value1-new';
  });

  const result4 = await memo.get('key2', 5000, async () => {
    buildCount++;
    return 'value2-new';
  });

  assert.strictEqual(result3, 'value1-new');
  assert.strictEqual(result4, 'value2-new');
  assert.strictEqual(buildCount, 4);
});

test('ResourceMemo — TTL of Infinity never expires', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const result1 = await memo.get('infinite-key', Number.POSITIVE_INFINITY, async () => {
    buildCount++;
    return 'infinite-value';
  });

  assert.strictEqual(result1, 'infinite-value');
  assert.strictEqual(buildCount, 1);

  // Wait a bit and try again
  await new Promise((resolve) => setTimeout(resolve, 100));

  const result2 = await memo.get('infinite-key', Number.POSITIVE_INFINITY, async () => {
    buildCount++;
    return 'infinite-value-modified';
  });

  assert.strictEqual(result2, 'infinite-value');
  // Should still be 1 because cache never expired
  assert.strictEqual(buildCount, 1);
});

test('ResourceMemo — immediate rebuild on TTL=0', async () => {
  const memo = new ResourceMemo<string, string>();
  let buildCount = 0;

  const result1 = await memo.get('ttl-zero-key', 0, async () => {
    buildCount++;
    return 'value1';
  });

  assert.strictEqual(result1, 'value1');
  assert.strictEqual(buildCount, 1);

  const result2 = await memo.get('ttl-zero-key', 0, async () => {
    buildCount++;
    return 'value2';
  });

  assert.strictEqual(result2, 'value2');
  // Should be 2 because TTL=0 means immediate expiration
  assert.strictEqual(buildCount, 2);
});
