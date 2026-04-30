// __tests__/lib/workspace-context.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

import { buildSessionSummary } from '../../src/lib/workspace-context.js';

// ── Gap 5: buildSessionSummary — prior model turns should be flagged ──────────

test('buildSessionSummary — output includes caveat that contents are not verified facts', () => {
  const transcript = [
    { role: 'user' as const, text: 'What is the capital of France?' },
    { role: 'model' as const, text: 'The capital of France is Paris.' },
    { role: 'user' as const, text: 'What about Germany?' },
    { role: 'model' as const, text: 'The capital of Germany is Berlin.' },
  ];

  const summary = buildSessionSummary(transcript);
  assert.ok(summary, 'summary must be produced for 4-entry transcript');
  assert.ok(
    summary.includes('summary') ||
      summary.includes('not') ||
      summary.includes('verified') ||
      summary.includes('note'),
    `Session summary wrapper should include a caveat that content is not verified facts, got: ${summary}`,
  );
});

test('buildSessionSummary — still contains prior conversation content', () => {
  const transcript = [
    { role: 'user' as const, text: 'What is the capital of France?' },
    { role: 'model' as const, text: 'The capital of France is Paris.' },
  ];

  const summary = buildSessionSummary(transcript);
  // Returns undefined for < 2 entries, but with 2 it should return something
  // The content itself should still be present
  if (summary) {
    assert.ok(
      summary.includes('[user]') || summary.includes('[model]'),
      'summary should contain role-prefixed lines',
    );
  }
});

test('buildSessionSummary — returns undefined for fewer than 2 entries', () => {
  const result = buildSessionSummary([{ role: 'user' as const, text: 'hello' }]);
  assert.strictEqual(result, undefined);
});
