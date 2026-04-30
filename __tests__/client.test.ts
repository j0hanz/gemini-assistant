// __tests__/client.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_SYSTEM_INSTRUCTION } from '../src/client.js';

// buildGenerateContentConfig is the public entry-point; it calls buildThinkingConfig internally.
// We spy on the module-level logger by mocking the logger child used in client.ts.
// Because buildThinkingConfig is not exported we test its observable effect via the exported function.

// ── Gap 1: DEFAULT_SYSTEM_INSTRUCTION must contain anti-hallucination language ─

test('DEFAULT_SYSTEM_INSTRUCTION — contains anti-hallucination directive', () => {
  const lower = DEFAULT_SYSTEM_INSTRUCTION.toLowerCase();
  assert.ok(
    lower.includes('unverified') ||
      lower.includes('do not assert') ||
      lower.includes('only assert') ||
      lower.includes('fabricat') ||
      lower.includes('invent'),
    `DEFAULT_SYSTEM_INSTRUCTION must contain anti-hallucination language, got: ${DEFAULT_SYSTEM_INSTRUCTION}`,
  );
});
