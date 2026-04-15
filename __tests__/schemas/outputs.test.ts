import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AgenticSearchOutputSchema,
  AnalyzeFileOutputSchema,
  AnalyzePrOutputSchema,
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

  it('accepts schemaWarnings array', () => {
    const result = AskOutputSchema.safeParse({
      answer: 'test',
      schemaWarnings: ['Failed to parse JSON from model response'],
    });
    assert.ok(result.success);
  });

  it('accepts output without schemaWarnings', () => {
    const result = AskOutputSchema.safeParse({ answer: 'test', data: { x: 1 } });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.schemaWarnings, undefined);
    }
  });

  it('rejects non-array schemaWarnings', () => {
    const result = AskOutputSchema.safeParse({
      answer: 'test',
      schemaWarnings: 'not an array',
    });
    assert.strictEqual(result.success, false);
  });
});

describe('AnalyzePrOutputSchema', () => {
  it('accepts valid generated diff metadata', () => {
    const result = AnalyzePrOutputSchema.safeParse({
      analysis: 'Review text',
      stats: { files: 1, additions: 10, deletions: 5 },
      reviewedPaths: ['src/index.ts'],
      includedUntracked: ['src/new-file.ts'],
      skippedBinaryPaths: ['assets/logo.png'],
      skippedLargePaths: ['fixtures/big.json'],
      omittedPaths: ['src/overflow.ts'],
      empty: false,
    });
    assert.ok(result.success);
  });

  it('accepts empty review output', () => {
    const result = AnalyzePrOutputSchema.safeParse({
      analysis: 'No local changes to review.',
      stats: { files: 0, additions: 0, deletions: 0 },
      reviewedPaths: [],
      includedUntracked: [],
      skippedBinaryPaths: [],
      skippedLargePaths: [],
      empty: true,
    });
    assert.ok(result.success);
  });

  it('rejects missing reviewedPaths', () => {
    const result = AnalyzePrOutputSchema.safeParse({
      analysis: 'Review text',
      stats: { files: 1, additions: 10, deletions: 5 },
      includedUntracked: [],
      skippedBinaryPaths: [],
      skippedLargePaths: [],
      empty: false,
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects negative diff stats', () => {
    const result = AnalyzePrOutputSchema.safeParse({
      analysis: 'Review text',
      stats: { files: -1, additions: 10, deletions: 5 },
      reviewedPaths: ['src/index.ts'],
      includedUntracked: [],
      skippedBinaryPaths: [],
      skippedLargePaths: [],
      empty: false,
    });
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
      sourceDetails: [{ title: 'Example', url: 'https://example.com' }],
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

  it('rejects non-url source entries', () => {
    const result = SearchOutputSchema.safeParse({
      answer: 'Result',
      sources: ['Example: https://example.com'],
    });
    assert.strictEqual(result.success, false);
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

  it('rejects negative token counts', () => {
    const result = UsageMetadataSchema.safeParse({ totalTokenCount: -1 });
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

  it('rejects negative count', () => {
    const result = ListCachesOutputSchema.safeParse({ caches: [], count: -1 });
    assert.strictEqual(result.success, false);
  });

  it('rejects malformed timestamps and cache names', () => {
    const result = ListCachesOutputSchema.safeParse({
      caches: [{ name: 'bad-cache', expireTime: 'not-a-date' }],
      count: 1,
    });
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

describe('AgenticSearchOutputSchema', () => {
  it('accepts valid output', () => {
    const result = AgenticSearchOutputSchema.safeParse({
      report: '# Report\n\nFindings here.',
      sources: ['https://example.com/source1', 'https://example.com/source2'],
      sourceDetails: [{ url: 'https://example.com/source1', title: 'Source 1' }],
    });
    assert.ok(result.success);
  });

  it('accepts with optional thoughts and usage', () => {
    const result = AgenticSearchOutputSchema.safeParse({
      report: 'Report content',
      sources: [],
      thoughts: 'Thinking about the approach...',
      usage: { totalTokenCount: 5000 },
    });
    assert.ok(result.success);
  });

  it('accepts with optional toolsUsed', () => {
    const result = AgenticSearchOutputSchema.safeParse({
      report: 'Report content',
      sources: [],
      toolsUsed: ['googleSearch', 'codeExecution'],
    });
    assert.ok(result.success);
  });

  it('rejects missing report', () => {
    const result = AgenticSearchOutputSchema.safeParse({
      sources: [],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing sources', () => {
    const result = AgenticSearchOutputSchema.safeParse({
      report: 'Report',
    });
    assert.strictEqual(result.success, false);
  });
});
