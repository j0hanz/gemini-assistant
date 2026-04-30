// __tests__/lib/anti-hallucination.test.ts
//
// Gap 4: When a caller supplies a custom systemInstruction to the chat tool,
// the anti-hallucination directive must be preserved in the final instruction
// that reaches Gemini. We test this via buildResponseConfig indirectly through
// buildGenerateContentConfig, which is the single assembly point.
import assert from 'node:assert';
import { test } from 'node:test';

import { buildGenerateContentConfig } from '../../src/client.js';

test('buildGenerateContentConfig — custom systemInstruction retains anti-hallucination suffix', () => {
  const config = buildGenerateContentConfig({
    systemInstruction: 'You are a pirate. Speak only in pirate dialect.',
  });

  const instruction =
    typeof config.systemInstruction === 'string'
      ? config.systemInstruction
      : ((config.systemInstruction as { text?: string } | undefined)?.text ?? '');

  assert.ok(
    instruction.includes('You are a pirate'),
    'Custom instruction content must be preserved',
  );

  const lower = instruction.toLowerCase();
  assert.ok(
    lower.includes('unverified') ||
      lower.includes('do not assert') ||
      lower.includes('only assert') ||
      lower.includes('cannot support') ||
      lower.includes('fabricat') ||
      lower.includes('invent'),
    `Custom systemInstruction path must append anti-hallucination language, got: ${instruction}`,
  );
});

test('buildGenerateContentConfig — default (no custom instruction) still has anti-hallucination language', () => {
  const config = buildGenerateContentConfig({});

  const instruction =
    typeof config.systemInstruction === 'string'
      ? config.systemInstruction
      : ((config.systemInstruction as { text?: string } | undefined)?.text ?? '');

  const lower = instruction.toLowerCase();
  assert.ok(
    lower.includes('unverified') ||
      lower.includes('do not assert') ||
      lower.includes('only assert') ||
      lower.includes('cannot support') ||
      lower.includes('fabricat') ||
      lower.includes('invent'),
    `Default systemInstruction must contain anti-hallucination language, got: ${instruction}`,
  );
});
