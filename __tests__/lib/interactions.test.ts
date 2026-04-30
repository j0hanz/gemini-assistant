import assert from 'node:assert';
import { test } from 'node:test';

import type { Interactions } from '@google/genai';

import { buildInteractionParams } from '../../src/lib/interactions.js';
import type { ResolvedProfile } from '../../src/lib/tool-profiles.js';

test('buildInteractionParams — builds valid Interactions.CreateInteractionParameters for plain profile', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Explain X',
    thinkingLevel: 'LOW',
    maxOutputTokens: 4096,
    systemInstruction: 'Be concise',
  });

  assert.strictEqual((result as Record<string, unknown>).model, 'gemini-3-pro-preview');
  assert.strictEqual((result as Record<string, unknown>).input, 'Explain X');
  const generationConfig = (result as Record<string, unknown>).generation_config as Record<
    string,
    unknown
  >;
  assert(generationConfig);
  assert.strictEqual(generationConfig.thinking_level, 'low');
  assert.strictEqual(generationConfig.max_output_tokens, 4096);
  const systemInstruction = (result as Record<string, unknown>).system_instruction as string;
  assert(systemInstruction);
  assert(systemInstruction.includes('Be concise'));
});

test('buildInteractionParams — includes grounding suffix when systemInstruction provided', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
    systemInstruction: 'Custom instruction',
  });

  const systemInstruction = (result as Record<string, unknown>).system_instruction as string;
  assert(systemInstruction);
  assert(systemInstruction.includes('Custom instruction'));
  assert(systemInstruction.includes('Only assert facts'));
});

test('buildInteractionParams — uses default system instruction when not provided', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
  });

  const systemInstruction = (result as Record<string, unknown>).system_instruction as string;
  assert(systemInstruction);
  assert(systemInstruction.includes('table when content'));
});

test('buildInteractionParams — converts camelCase thinkingLevel to snake_case', () => {
  const profile: ResolvedProfile = {
    profile: 'grounded',
    builtIns: ['googleSearch'],
    thinkingLevel: 'medium',
    autoPromoted: false,
    overrides: {},
  };

  const testCases: [string, string][] = [
    ['MINIMAL', 'minimal'],
    ['LOW', 'low'],
    ['MEDIUM', 'medium'],
    ['HIGH', 'high'],
  ];

  for (const [input, expected] of testCases) {
    const result = buildInteractionParams({
      profile,
      model: 'gemini-3-pro-preview',
      prompt: 'Test',
      thinkingLevel: input as import('../../src/public-contract.js').AskThinkingLevel,
    });

    const generationConfig = (result as Record<string, unknown>).generation_config as Record<
      string,
      unknown
    >;
    assert.strictEqual(
      generationConfig?.thinking_level,
      expected,
      `thinkingLevel ${input} should convert to ${expected}`,
    );
  }
});

test('buildInteractionParams — builds tools from builtIns', () => {
  const profile: ResolvedProfile = {
    profile: 'grounded',
    builtIns: ['googleSearch', 'urlContext'],
    thinkingLevel: 'medium',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
  });

  const tools = (result as Record<string, unknown>).tools as unknown[];
  assert(Array.isArray(tools));
  assert(tools.length > 0);
});

test('buildInteractionParams — omits tools when builtIns is empty', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
  });

  const tools = (result as Record<string, unknown>).tools as unknown[] | undefined;
  assert(!tools || tools.length === 0);
});

test('buildInteractionParams — includes previousInteractionId when provided', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
    previousInteractionId: 'interaction-123',
  });

  assert.strictEqual(
    (result as Record<string, unknown>).previous_interaction_id,
    'interaction-123',
  );
});

test('buildInteractionParams — defaults maxOutputTokens to 2048 when not provided', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
  });

  const generationConfig = (result as Record<string, unknown>).generation_config as Record<
    string,
    unknown
  >;
  assert.strictEqual(generationConfig.max_output_tokens, 2048);
});

test('buildInteractionParams — respects maxOutputTokens override', () => {
  const profile: ResolvedProfile = {
    profile: 'plain',
    builtIns: [],
    thinkingLevel: 'minimal',
    autoPromoted: false,
    overrides: {},
  };

  const result = buildInteractionParams({
    profile,
    model: 'gemini-3-pro-preview',
    prompt: 'Test',
    maxOutputTokens: 8192,
  });

  const generationConfig = (result as Record<string, unknown>).generation_config as Record<
    string,
    unknown
  >;
  assert.strictEqual(generationConfig.max_output_tokens, 8192);
});
