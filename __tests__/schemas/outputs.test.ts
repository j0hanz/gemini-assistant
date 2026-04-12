import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecuteCodeOutputSchema } from '../../src/schemas/outputs.js';

describe('ExecuteCodeOutputSchema', () => {
  it('accepts valid structured output', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      code: 'print("hello")',
      output: 'hello',
      explanation: 'Prints hello to stdout',
    });
    assert.ok(result.success);
  });

  it('accepts empty strings', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      code: '',
      output: '',
      explanation: '',
    });
    assert.ok(result.success);
  });

  it('rejects missing code', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      output: 'hello',
      explanation: 'x',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing output', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      code: 'x',
      explanation: 'x',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing explanation', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      code: 'x',
      output: 'x',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects non-string values', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      code: 123,
      output: 'x',
      explanation: 'x',
    });
    assert.strictEqual(result.success, false);
  });

  it('strips unknown properties', () => {
    const result = ExecuteCodeOutputSchema.safeParse({
      code: 'x',
      output: 'y',
      explanation: 'z',
      extra: 'should be stripped',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual('extra' in result.data, false);
    }
  });
});
