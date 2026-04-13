import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeFileOutputSchema,
  AnalyzeUrlOutputSchema,
  AskOutputSchema,
  CreateCacheOutputSchema,
  DeleteCacheOutputSchema,
  ExecuteCodeOutputSchema,
  ListCachesOutputSchema,
  SearchOutputSchema,
  UpdateCacheOutputSchema,
  UsageMetadataSchema,
} from '../../src/schemas/outputs.js';

describe('AskOutputSchema', () => {
  it('accepts a plain text answer', () => {
    const result = AskOutputSchema.safeParse({ answer: 'Hello world' });
    assert.ok(result.success);
  });

  it('accepts structured data alongside the answer', () => {
    const result = AskOutputSchema.safeParse({
      answer: '{"status":"ok"}',
      data: { status: 'ok' },
      usage: { totalTokenCount: 42 },
    });
    assert.ok(result.success);
  });

  it('rejects a missing answer field', () => {
    const result = AskOutputSchema.safeParse({ data: { status: 'ok' } });
    assert.strictEqual(result.success, false);
  });
});

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

describe('AnalyzeFileOutputSchema', () => {
  it('accepts valid output', () => {
    const result = AnalyzeFileOutputSchema.safeParse({ analysis: 'File contains...' });
    assert.ok(result.success);
  });

  it('accepts output with usage', () => {
    const result = AnalyzeFileOutputSchema.safeParse({
      analysis: 'File analysis',
      usage: { promptTokenCount: 100, totalTokenCount: 200 },
    });
    assert.ok(result.success);
  });

  it('rejects missing analysis', () => {
    const result = AnalyzeFileOutputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });
});

describe('UsageMetadataSchema', () => {
  it('accepts full usage metadata', () => {
    const result = UsageMetadataSchema.safeParse({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
      totalTokenCount: 170,
    });
    assert.ok(result.success);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = UsageMetadataSchema.safeParse({});
    assert.ok(result.success);
  });

  it('accepts partial usage', () => {
    const result = UsageMetadataSchema.safeParse({ totalTokenCount: 42 });
    assert.ok(result.success);
  });

  it('rejects non-number values', () => {
    const result = UsageMetadataSchema.safeParse({ promptTokenCount: 'many' });
    assert.strictEqual(result.success, false);
  });
});

describe('CreateCacheOutputSchema', () => {
  it('accepts valid cache output', () => {
    const result = CreateCacheOutputSchema.safeParse({
      name: 'cachedContents/abc123',
      displayName: 'My Cache',
      model: 'gemini-3-flash-preview',
      expireTime: '2026-04-14T00:00:00Z',
    });
    assert.ok(result.success);
  });

  it('accepts name-only output', () => {
    const result = CreateCacheOutputSchema.safeParse({ name: 'cachedContents/abc123' });
    assert.ok(result.success);
  });

  it('rejects missing name', () => {
    const result = CreateCacheOutputSchema.safeParse({ displayName: 'My Cache' });
    assert.strictEqual(result.success, false);
  });
});

describe('ListCachesOutputSchema', () => {
  it('accepts valid list output', () => {
    const result = ListCachesOutputSchema.safeParse({
      caches: [{ name: 'cachedContents/abc', displayName: 'Test' }],
      count: 1,
    });
    assert.ok(result.success);
  });

  it('accepts empty caches', () => {
    const result = ListCachesOutputSchema.safeParse({ caches: [], count: 0 });
    assert.ok(result.success);
  });

  it('accepts caches with partial fields', () => {
    const result = ListCachesOutputSchema.safeParse({
      caches: [{ name: 'cachedContents/xyz' }, {}],
      count: 2,
    });
    assert.ok(result.success);
  });

  it('rejects missing count', () => {
    const result = ListCachesOutputSchema.safeParse({ caches: [] });
    assert.strictEqual(result.success, false);
  });
});

describe('DeleteCacheOutputSchema', () => {
  it('accepts successful deletion', () => {
    const result = DeleteCacheOutputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      deleted: true,
    });
    assert.ok(result.success);
  });

  it('accepts cancelled deletion', () => {
    const result = DeleteCacheOutputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      deleted: false,
    });
    assert.ok(result.success);
  });

  it('rejects missing cacheName', () => {
    const result = DeleteCacheOutputSchema.safeParse({ deleted: true });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing deleted', () => {
    const result = DeleteCacheOutputSchema.safeParse({ cacheName: 'cachedContents/abc123' });
    assert.strictEqual(result.success, false);
  });
});

describe('UpdateCacheOutputSchema', () => {
  it('accepts valid update output', () => {
    const result = UpdateCacheOutputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      expireTime: '2026-04-14T00:00:00Z',
    });
    assert.ok(result.success);
  });

  it('accepts update without expireTime', () => {
    const result = UpdateCacheOutputSchema.safeParse({ cacheName: 'cachedContents/abc123' });
    assert.ok(result.success);
  });

  it('rejects missing cacheName', () => {
    const result = UpdateCacheOutputSchema.safeParse({ expireTime: '2026-04-14T00:00:00Z' });
    assert.strictEqual(result.success, false);
  });
});
