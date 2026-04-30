// __tests__/lib/model-prompts.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

import {
  buildAgenticResearchPrompt,
  buildGroundedAnswerPrompt,
} from '../../src/lib/model-prompts.js';

// ── Gap 2: buildGroundedAnswerPrompt — retrieval-unavailable branch ────────────

test('buildGroundedAnswerPrompt — retrieval-unavailable instruction forbids inventing URLs', () => {
  const { systemInstruction } = buildGroundedAnswerPrompt('what is X?', undefined, undefined, {
    googleSearch: false,
    urlContext: false,
    codeExecution: false,
    fileSearch: false,
  });
  assert.ok(systemInstruction, 'systemInstruction must be present');
  assert.ok(
    systemInstruction.toLowerCase().includes('invent') ||
      systemInstruction.toLowerCase().includes('fabricat') ||
      systemInstruction.toLowerCase().includes('unverified'),
    `Expected anti-hallucination language in retrieval-unavailable instruction, got: ${systemInstruction}`,
  );
});

test('buildGroundedAnswerPrompt — retrieval-unavailable instruction does not tell model to answer from retrieved sources', () => {
  const { systemInstruction } = buildGroundedAnswerPrompt('what is X?', undefined, undefined, {
    googleSearch: false,
    urlContext: false,
    codeExecution: false,
    fileSearch: false,
  });
  assert.ok(systemInstruction, 'systemInstruction must be present');
  // Should NOT say "Answer from sources retrieved this turn" when no retrieval is available
  assert.ok(
    !systemInstruction.includes('sources retrieved this turn'),
    `Retrieval-unavailable path should not reference "sources retrieved this turn", got: ${systemInstruction}`,
  );
});

test('buildGroundedAnswerPrompt — normal path keeps "Answer from sources retrieved this turn"', () => {
  const { systemInstruction } = buildGroundedAnswerPrompt('what is X?', undefined, undefined, {
    googleSearch: true,
    urlContext: false,
    codeExecution: false,
    fileSearch: false,
  });
  assert.ok(systemInstruction, 'systemInstruction must be present');
  assert.ok(
    systemInstruction.includes('sources retrieved this turn'),
    `Normal path should keep retrieval instruction, got: ${systemInstruction}`,
  );
});

// ── Gap 3: buildAgenticResearchPrompt — no-search branch ──────────────────────

test('buildAgenticResearchPrompt — no-search branch warns about ungrounded claims', () => {
  const { systemInstruction } = buildAgenticResearchPrompt({
    topic: 'test topic',
    capabilities: {
      googleSearch: false,
      urlContext: false,
      codeExecution: false,
      fileSearch: false,
    },
  });
  assert.ok(systemInstruction, 'systemInstruction must be present');
  assert.ok(
    systemInstruction.toLowerCase().includes('fabricat') ||
      systemInstruction.toLowerCase().includes('invent') ||
      systemInstruction.toLowerCase().includes('provided context') ||
      systemInstruction.toLowerCase().includes('do not retrieve'),
    `No-search branch should explicitly warn against fabrication, got: ${systemInstruction}`,
  );
});

test('buildAgenticResearchPrompt — search branch keeps search instruction', () => {
  const { systemInstruction } = buildAgenticResearchPrompt({
    topic: 'test topic',
    capabilities: {
      googleSearch: true,
      urlContext: false,
      codeExecution: false,
      fileSearch: false,
    },
  });
  assert.ok(systemInstruction, 'systemInstruction must be present');
  assert.ok(
    systemInstruction.includes('Google Search'),
    `Search branch should mention Google Search, got: ${systemInstruction}`,
  );
});

// ── Gap 6: buildGroundedAnswerPrompt — partial retrieval gap ──────────────────

test('buildGroundedAnswerPrompt — normal path includes guidance on partial retrieval gaps', () => {
  const { systemInstruction } = buildGroundedAnswerPrompt('what is X?', undefined, undefined, {
    googleSearch: true,
    urlContext: false,
    codeExecution: false,
    fileSearch: false,
  });
  assert.ok(systemInstruction, 'systemInstruction must be present');
  // Should tell model what to do when retrieved sources don't fully answer
  assert.ok(
    systemInstruction.toLowerCase().includes('unverified') ||
      systemInstruction.toLowerCase().includes('supplement') ||
      systemInstruction.toLowerCase().includes('fully') ||
      systemInstruction.toLowerCase().includes('training'),
    `Normal grounded path should address partial-retrieval gaps, got: ${systemInstruction}`,
  );
});
