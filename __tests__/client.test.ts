import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ThinkingLevel } from '@google/genai';

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
});
