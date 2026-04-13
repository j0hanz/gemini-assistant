import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeUrlOutputSchema,
  ExecuteCodeOutputSchema,
  SearchOutputSchema,
} from '../../src/schemas/outputs.js';

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

describe('SearchOutputSchema', () => {
  it('accepts valid output without urlMetadata', () => {
    const result = SearchOutputSchema.safeParse({
      answer: 'The answer is 42',
      sources: ['https://example.com'],
    });
    assert.ok(result.success);
  });

  it('accepts output with urlMetadata', () => {
    const result = SearchOutputSchema.safeParse({
      answer: 'Analysis result',
      sources: ['https://example.com'],
      urlMetadata: [{ url: 'https://example.com', status: 'URL_RETRIEVAL_STATUS_SUCCESS' }],
    });
    assert.ok(result.success);
  });

  it('accepts empty sources and no urlMetadata', () => {
    const result = SearchOutputSchema.safeParse({
      answer: 'No sources found',
      sources: [],
    });
    assert.ok(result.success);
  });
});

describe('AnalyzeUrlOutputSchema', () => {
  it('accepts valid output', () => {
    const result = AnalyzeUrlOutputSchema.safeParse({
      answer: 'The page discusses X',
    });
    assert.ok(result.success);
  });

  it('accepts output with urlMetadata', () => {
    const result = AnalyzeUrlOutputSchema.safeParse({
      answer: 'Analysis result',
      urlMetadata: [{ url: 'https://example.com', status: 'URL_RETRIEVAL_STATUS_SUCCESS' }],
    });
    assert.ok(result.success);
  });

  it('rejects missing answer', () => {
    const result = AnalyzeUrlOutputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects non-string answer', () => {
    const result = AnalyzeUrlOutputSchema.safeParse({ answer: 123 });
    assert.strictEqual(result.success, false);
  });
});
