import assert from 'node:assert';
import { test } from 'node:test';

import { buildUrlContextSourceDetails } from '../../src/lib/response.js';

test('buildUrlContextSourceDetails — valid URL returns entry with domain', () => {
  const result = buildUrlContextSourceDetails(['https://example.com/path']);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]?.url, 'https://example.com/path');
  assert.strictEqual(result[0]?.domain, 'example.com');
  assert.strictEqual(result[0]?.origin, 'urlContext');
});

test('buildUrlContextSourceDetails — malformed URL does not throw and omits domain', () => {
  // This currently throws TypeError: Invalid URL
  assert.doesNotThrow(() => {
    const result = buildUrlContextSourceDetails(['not-a-valid-url']);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.url, 'not-a-valid-url');
    assert.strictEqual(result[0]?.domain, undefined);
    assert.strictEqual(result[0]?.origin, 'urlContext');
  });
});

test('buildUrlContextSourceDetails — empty array returns empty array', () => {
  const result = buildUrlContextSourceDetails([]);
  assert.deepStrictEqual(result, []);
});
