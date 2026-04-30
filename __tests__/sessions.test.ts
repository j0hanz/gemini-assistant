import assert from 'node:assert';
import { test } from 'node:test';

import { sanitizeSessionText } from '../src/sessions.js';

test('sanitizeSessionText — redacts API key patterns', () => {
  const text = 'API_KEY=abc123xyz apikey=secret OTHER=keep';
  const result = sanitizeSessionText(text);
  assert(result.includes('[REDACTED]'));
  assert(!result.includes('abc123xyz'));
  assert(!result.includes('secret'));
  assert(result.includes('keep'));
});

test('sanitizeSessionText — redacts password patterns', () => {
  const text = 'password: supersecret token="xyz" api-key=hidden';
  const result = sanitizeSessionText(text);
  assert(result.includes('[REDACTED]'));
  assert(!result.includes('supersecret'));
  assert(!result.includes('hidden'));
});

test('sanitizeSessionText — preserves unrelated text', () => {
  const text = 'This is a normal message with no secrets';
  const result = sanitizeSessionText(text);
  assert.strictEqual(result, text);
});
