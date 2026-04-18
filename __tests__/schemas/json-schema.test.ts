import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GeminiResponseSchema } from '../../src/schemas/json-schema.js';

describe('GeminiResponseSchema', () => {
  it('does not advertise unsupported prefixItems in the supported-key message', () => {
    const result = GeminiResponseSchema.safeParse({});
    assert.strictEqual(result.success, false);

    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message).join('\n');
    assert.ok(messages.includes('propertyOrdering'));
    assert.ok(!messages.includes('prefixItems'));
  });
});
