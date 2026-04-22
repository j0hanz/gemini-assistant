import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeOutputSchema,
  ContextUsedSchema,
  CreateCacheOutputSchema,
  DeleteCachePublicOutputSchema,
  ListCachesOutputSchema,
  ResearchOutputSchema,
  ReviewOutputSchema,
  UpdateCacheOutputSchema,
  UsageMetadataSchema,
} from '../../src/schemas/outputs.js';

describe('ContextUsedSchema', () => {
  it('accepts valid context used metadata', () => {
    const result = ContextUsedSchema.safeParse({
      sources: [
        { kind: 'workspace-file', name: 'package.json', tokens: 850 },
        { kind: 'session-summary', name: 'session-abc', tokens: 480 },
      ],
      totalTokens: 1330,
      workspaceCacheApplied: false,
    });
    assert.ok(result.success);
  });

  it('accepts empty sources array', () => {
    const result = ContextUsedSchema.safeParse({
      sources: [],
      totalTokens: 0,
      workspaceCacheApplied: false,
    });
    assert.ok(result.success);
  });

  it('rejects unknown source kind', () => {
    const result = ContextUsedSchema.safeParse({
      sources: [{ kind: 'magic', name: 'x', tokens: 1 }],
      totalTokens: 1,
      workspaceCacheApplied: false,
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing workspaceCacheApplied', () => {
    const result = ContextUsedSchema.safeParse({
      sources: [],
      totalTokens: 0,
    });
    assert.strictEqual(result.success, false);
  });
});

describe('AnalyzeOutputSchema', () => {
  it('accepts summary output', () => {
    const result = AnalyzeOutputSchema.safeParse({
      kind: 'summary',
      status: 'completed',
      targetKind: 'file',
      summary: 'File analysis',
      usage: { totalTokenCount: 200 },
    });
    assert.ok(result.success);
  });

  it('accepts diagram output', () => {
    const result = AnalyzeOutputSchema.safeParse({
      kind: 'diagram',
      status: 'completed',
      targetKind: 'multi',
      diagramType: 'mermaid',
      diagram: 'flowchart TD\nA-->B',
      explanation: 'Diagram generated from the provided files.',
    });
    assert.ok(result.success);
  });

  it('rejects missing output kind', () => {
    const result = AnalyzeOutputSchema.safeParse({
      status: 'completed',
      targetKind: 'file',
      summary: 'File analysis',
    });
    assert.strictEqual(result.success, false);
  });
});

describe('ResearchOutputSchema', () => {
  it('accepts quick research output', () => {
    const result = ResearchOutputSchema.safeParse({
      status: 'completed',
      mode: 'quick',
      summary: 'Quick answer',
      sources: ['https://example.com'],
    });
    assert.ok(result.success);
  });
});

describe('ReviewOutputSchema', () => {
  it('documents the corrected empty flag description', () => {
    assert.strictEqual(
      ReviewOutputSchema.shape.empty.description,
      'Whether the local diff is empty (no changes)',
    );
  });

  it('accepts failure diagnosis output', () => {
    const result = ReviewOutputSchema.safeParse({
      status: 'completed',
      subjectKind: 'failure',
      summary: 'Likely root cause',
    });
    assert.ok(result.success);
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

describe('DeleteCachePublicOutputSchema', () => {
  const base = { status: 'completed' as const, requestId: 'task-1' };

  it('accepts successful deletion', () => {
    const result = DeleteCachePublicOutputSchema.safeParse({
      ...base,
      summary: 'Deleted cache cachedContents/abc123.',
      cacheName: 'cachedContents/abc123',
      deleted: true,
    });
    assert.ok(result.success);
  });

  it('accepts cancelled deletion', () => {
    const result = DeleteCachePublicOutputSchema.safeParse({
      ...base,
      summary: 'Did not delete cache cachedContents/abc123.',
      cacheName: 'cachedContents/abc123',
      deleted: false,
    });
    assert.ok(result.success);
  });

  it('accepts confirmation-required deletion', () => {
    const result = DeleteCachePublicOutputSchema.safeParse({
      ...base,
      summary: 'Deletion for cachedContents/abc123 requires confirmation.',
      cacheName: 'cachedContents/abc123',
      deleted: false,
      confirmationRequired: true,
      resourceUris: ['memory://caches'],
    });
    assert.ok(result.success);
  });

  it('rejects missing cacheName', () => {
    const result = DeleteCachePublicOutputSchema.safeParse({
      ...base,
      summary: 'x',
      deleted: true,
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing summary', () => {
    const result = DeleteCachePublicOutputSchema.safeParse({
      ...base,
      cacheName: 'cachedContents/abc123',
      deleted: true,
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects non-boolean confirmationRequired', () => {
    const result = DeleteCachePublicOutputSchema.safeParse({
      ...base,
      summary: 'x',
      cacheName: 'cachedContents/abc123',
      deleted: false,
      confirmationRequired: 'yes',
    });
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
