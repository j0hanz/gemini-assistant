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
});
