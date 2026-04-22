import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HarmBlockThreshold, ThinkingLevel } from '@google/genai';

import { buildGenerateContentConfig } from '../src/client.js';

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

  it('defaults safety setting thresholds to BLOCK_ONLY_HIGH', () => {
    const config = buildGenerateContentConfig({
      safetySettings: [{}] as never,
    });

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
});
