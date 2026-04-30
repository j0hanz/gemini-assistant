import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeSessionText, buildReplayHistoryParts, selectReplayWindow } from '../src/sessions.js';

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

test('buildReplayHistoryParts — filters out pure thought parts', () => {
  const parts = [
    { text: 'my thought' },
    { text: 'user response' },
  ];
  const result = buildReplayHistoryParts(parts);
  assert(result.length > 0);
  assert(result.every((p) => p.text !== undefined || p.functionCall !== undefined));
});

test('buildReplayHistoryParts — preserves thoughtSignature on functionCall parts', () => {
  const parts = [
    {
      functionCall: { name: 'search', args: {} },
      thoughtSignature: 'sig123',
    },
  ];
  const result = buildReplayHistoryParts(parts);
  assert(result.some((p) => p.thoughtSignature === 'sig123'));
});

test('selectReplayWindow — returns empty selection for empty input', () => {
  const result = selectReplayWindow([], 10000);
  assert.deepStrictEqual(result.kept, []);
  assert.strictEqual(result.dropped, 0);
});
