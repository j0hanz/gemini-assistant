import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HarmBlockThreshold, HarmCategory, ThinkingLevel } from '@google/genai';

import { buildGenerateContentConfig } from '../src/client.js';
import { ChatInputSchema } from '../src/schemas/inputs.js';

describe('client config', () => {
  it('maps thinking level strings to SDK enum values', () => {
    assert.strictEqual(
      buildGenerateContentConfig({ thinkingLevel: 'MINIMAL' }).thinkingConfig?.thinkingLevel,
      ThinkingLevel.MINIMAL,
    );
    assert.strictEqual(
      buildGenerateContentConfig({ thinkingLevel: 'LOW' }).thinkingConfig?.thinkingLevel,
      ThinkingLevel.LOW,
    );
    assert.strictEqual(
      buildGenerateContentConfig({ thinkingLevel: 'MEDIUM' }).thinkingConfig?.thinkingLevel,
      ThinkingLevel.MEDIUM,
    );
    assert.strictEqual(
      buildGenerateContentConfig({ thinkingLevel: 'HIGH' }).thinkingConfig?.thinkingLevel,
      ThinkingLevel.HIGH,
    );
  });

  it('passes validated safety settings through to Gemini config', () => {
    const config = buildGenerateContentConfig({
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
      ],
    });

    assert.strictEqual(
      config.safetySettings?.[0]?.category,
      HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    );
    assert.strictEqual(config.safetySettings?.[0]?.threshold, HarmBlockThreshold.BLOCK_ONLY_HIGH);
  });

  it('strips thinkingBudget when thinkingLevel is provided', () => {
    const config = buildGenerateContentConfig({
      thinkingLevel: 'LOW',
      thinkingBudget: 64,
    });

    assert.strictEqual(config.thinkingConfig?.thinkingLevel, ThinkingLevel.LOW);
    assert.strictEqual(config.thinkingConfig?.thinkingBudget, undefined);
  });

  it('uses thinkingBudget as a fallback when thinkingLevel is absent', () => {
    const config = buildGenerateContentConfig({
      thinkingBudget: 64,
    });

    assert.strictEqual(config.thinkingConfig?.thinkingLevel, undefined);
    assert.strictEqual(config.thinkingConfig?.thinkingBudget, 64);
  });

  it('lets public chat thinkingBudget bypass cost-profile thinkingLevel when omitted', () => {
    const parsed = ChatInputSchema.parse({ goal: 'Use a budget', thinkingBudget: 64 });
    const config = buildGenerateContentConfig({ ...parsed, costProfile: 'chat' });

    assert.strictEqual(parsed.thinkingLevel, undefined);
    assert.strictEqual(config.thinkingConfig?.thinkingLevel, undefined);
    assert.strictEqual(config.thinkingConfig?.thinkingBudget, 64);
  });

  it('fills missing values from cost profiles', () => {
    const config = buildGenerateContentConfig({ costProfile: 'review.diff' });

    assert.strictEqual(config.thinkingConfig?.thinkingLevel, ThinkingLevel.LOW);
    assert.strictEqual(config.maxOutputTokens, 4_096);
  });

  it('preserves systemInstruction when cachedContent is used', () => {
    const config = buildGenerateContentConfig({
      cacheName: 'cachedContents/abc',
      systemInstruction: 'Use the current review rubric.',
    });

    assert.strictEqual(config.cachedContent, 'cachedContents/abc');
    assert.strictEqual(config.systemInstruction, 'Use the current review rubric.');
  });

  it('lets explicit args override cost profiles', () => {
    const config = buildGenerateContentConfig({
      costProfile: 'review.diff',
      thinkingLevel: 'HIGH',
      maxOutputTokens: 123,
    });

    assert.strictEqual(config.thinkingConfig?.thinkingLevel, ThinkingLevel.HIGH);
    assert.strictEqual(config.maxOutputTokens, 123);
  });

  it('throws for unknown cost profiles at runtime', () => {
    assert.throws(
      () => buildGenerateContentConfig({ costProfile: 'missing.profile' }),
      /Unknown Gemini cost profile/,
    );
  });

  it('clamps thinkingBudget to GEMINI_THINKING_BUDGET_CAP', () => {
    process.env.GEMINI_THINKING_BUDGET_CAP = '32';
    try {
      const config = buildGenerateContentConfig({ thinkingBudget: 64 });
      assert.strictEqual(config.thinkingConfig?.thinkingBudget, 32);
    } finally {
      delete process.env.GEMINI_THINKING_BUDGET_CAP;
    }
  });
});
