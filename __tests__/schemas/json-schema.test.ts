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
    assert.ok(messages.includes('properties'));
    assert.ok(!messages.includes('prefixItems'));
  });

  it('preserves exact property names in required', () => {
    const result = GeminiResponseSchema.safeParse({
      type: 'object',
      properties: {
        ' first name': { type: 'string' },
        'id ': { type: 'string' },
      },
      required: [' first name'],
    });

    assert.ok(result.success);
  });

  it('supports title and nullable fields', () => {
    const result = GeminiResponseSchema.safeParse({
      type: 'string',
      title: 'Status',
      nullable: true,
    });

    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.title, 'Status');
      assert.strictEqual(result.data.nullable, true);
    }
  });
});
