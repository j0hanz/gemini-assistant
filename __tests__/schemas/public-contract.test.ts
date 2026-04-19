import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeInputSchema,
  ChatInputSchema,
  MemoryInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../../src/schemas/inputs.js';
import {
  AnalyzeOutputSchema,
  ChatOutputSchema,
  MemoryOutputSchema,
  ResearchOutputSchema,
  ReviewOutputSchema,
} from '../../src/schemas/outputs.js';

describe('public contract schemas', () => {
  it('defaults research.mode and rejects legacy top-level fields', () => {
    const result = ResearchInputSchema.safeParse({ goal: 'Current events' });
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data.mode, 'quick');
    }
    assert.strictEqual(
      ResearchInputSchema.safeParse({ mode: 'quick', goal: 'x', query: 'legacy' }).success,
      false,
    );
    assert.strictEqual(
      ResearchInputSchema.safeParse({ mode: 'deep', goal: 'x', topic: 'legacy' }).success,
      false,
    );
  });

  it('keeps memory.action flat with per-action validation', () => {
    assert.strictEqual(MemoryInputSchema.safeParse({ action: 'sessions.get' }).success, false);
    assert.strictEqual(
      MemoryInputSchema.safeParse({ action: 'caches.get', cacheName: 'cachedContents/test' })
        .success,
      true,
    );
    assert.strictEqual(
      MemoryInputSchema.safeParse({ action: 'caches.list', cacheName: 'cachedContents/test' })
        .success,
      false,
    );
  });

  it('rejects legacy public top-level fields across the job-first surface', () => {
    assert.strictEqual(ChatInputSchema.safeParse({ goal: 'x', message: 'legacy' }).success, false);
    assert.strictEqual(
      AnalyzeInputSchema.safeParse({ goal: 'x', question: 'legacy' }).success,
      false,
    );
    assert.strictEqual(
      ReviewInputSchema.safeParse({ subjectKind: 'diff', topic: 'legacy' }).success,
      false,
    );
    assert.strictEqual(
      MemoryInputSchema.safeParse({ action: 'caches.list', cacheName: 'legacy' }).success,
      false,
    );
    assert.strictEqual(
      AnalyzeInputSchema.safeParse({
        goal: 'x',
        targetKind: 'file',
        filePath: 'src/index.ts',
        outputKind: 'summary',
        question: 'legacy',
      }).success,
      false,
    );
  });

  it('parses shared base output fields on every public output schema', () => {
    const base = {
      requestId: 'task-1',
      status: 'completed' as const,
      usage: { totalTokenCount: 1 },
      warnings: ['note'],
    };

    assert.ok(
      ChatOutputSchema.safeParse({ ...base, answer: 'hello' }).success,
      'chat output should parse',
    );
    assert.ok(
      ChatOutputSchema.safeParse({
        ...base,
        answer: 'hello',
        contextUsed: {
          sources: [{ kind: 'workspace-file', name: 'README.md', tokens: 100 }],
          totalTokens: 100,
          workspaceCacheApplied: false,
        },
      }).success,
      'chat output with contextUsed should parse',
    );
    assert.ok(
      ResearchOutputSchema.safeParse({ ...base, mode: 'quick', summary: 'x', sources: [] }).success,
      'research output should parse',
    );
    assert.ok(
      AnalyzeOutputSchema.safeParse({
        ...base,
        kind: 'summary',
        summary: 'x',
        targetKind: 'file',
      }).success,
      'analyze output should parse',
    );
    assert.ok(
      AnalyzeOutputSchema.safeParse({
        ...base,
        kind: 'diagram',
        diagram: 'flowchart TD\nA-->B',
        diagramType: 'mermaid',
        targetKind: 'multi',
      }).success,
      'diagram analyze output should parse',
    );
    assert.ok(
      ReviewOutputSchema.safeParse({ ...base, subjectKind: 'failure', summary: 'x' }).success,
      'review output should parse',
    );
    assert.ok(
      MemoryOutputSchema.safeParse({ ...base, action: 'sessions.list', summary: 'x' }).success,
      'memory output should parse',
    );
  });
});
