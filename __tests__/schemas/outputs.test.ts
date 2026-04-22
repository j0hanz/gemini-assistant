import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeOutputSchema,
  ChatOutputSchema,
  ContextUsedSchema,
  ResearchOutputSchema,
  ReviewOutputSchema,
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

  it('accepts grounding transparency fields and rejects unknown fields', () => {
    const result = ResearchOutputSchema.safeParse({
      status: 'completed',
      mode: 'deep',
      summary: 'Deep answer',
      sources: ['https://example.com'],
      grounded: true,
      citations: [
        {
          text: 'Supported claim',
          startIndex: 0,
          endIndex: 15,
          sourceUrls: ['https://example.com'],
        },
      ],
      searchEntryPoint: {
        renderedContent: '<div>search</div>',
      },
      urlContextUsed: true,
      urlContextSources: ['https://example.com/context'],
      sourceDetails: [
        { origin: 'both', title: 'Example', url: 'https://example.com' },
        { origin: 'urlContext', url: 'https://example.com/context' },
      ],
    });
    assert.ok(result.success);

    const unknown = ResearchOutputSchema.safeParse({
      status: 'completed',
      mode: 'deep',
      summary: 'Deep answer',
      sources: [],
      extra: true,
    });
    assert.strictEqual(unknown.success, false);
  });
});

describe('ChatOutputSchema', () => {
  it('defaults workspaceCacheApplied to false', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
    });

    assert.ok(result.success);
    assert.strictEqual(result.data.workspaceCacheApplied, false);
  });

  it('accepts workspaceCacheApplied when true', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
      workspaceCacheApplied: true,
    });

    assert.ok(result.success);
    assert.strictEqual(result.data.workspaceCacheApplied, true);
  });

  it('accepts function-call signatures and thought tool events', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
      functionCalls: [
        {
          name: 'lookup',
          args: { q: 'x' },
          thoughtSignature: 'sig-fn',
        },
      ],
      toolEvents: [
        {
          kind: 'thought',
          text: 'reasoning',
          thoughtSignature: 'sig-thought',
        },
      ],
    });

    assert.ok(result.success);
  });

  it('rejects unknown tool event kinds', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
      toolEvents: [{ kind: 'unknown' }],
    });

    assert.strictEqual(result.success, false);
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
      cachedContentTokenCount: 10,
      toolUsePromptTokenCount: 5,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
      candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 50 }],
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
