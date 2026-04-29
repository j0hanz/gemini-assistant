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
      status: 'ungrounded',
      targetKind: 'file',
      summary: 'File analysis',
      diagnostics: { usage: { totalTokenCount: 200 } },
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
      status: 'grounded',
      mode: 'quick',
      summary: 'Quick answer',
      sources: ['https://example.com'],
    });
    assert.ok(result.success);
  });

  it('accepts grounding transparency fields and rejects unknown fields', () => {
    const result = ResearchOutputSchema.safeParse({
      mode: 'deep',
      summary: 'Deep answer',
      sources: ['https://example.com'],
      citations: [
        {
          text: 'Supported claim',
          startIndex: 0,
          endIndex: 15,
          sourceUrls: ['https://example.com'],
        },
      ],
      urlContextSources: ['https://example.com/context'],
      sourceDetails: [
        { domain: 'example.com', origin: 'both', title: 'Example', url: 'https://example.com' },
        { domain: 'example.com', origin: 'urlContext', url: 'https://example.com/context' },
      ],
      status: 'grounded',
      groundingSignals: {
        retrievalPerformed: true,
        urlContextUsed: true,
        groundingSupportsCount: 1,
        confidence: 'medium',
      },
      findings: [
        {
          claim: 'Supported claim',
          supportingSourceUrls: ['https://example.com'],
          verificationStatus: 'cited',
        },
      ],
      computations: [
        {
          id: 'exec-1',
          code: 'print(2)',
          language: 'PYTHON',
          outcome: 'OUTCOME_OK',
          output: '2',
        },
      ],
    });
    assert.ok(result.success);

    const unknown = ResearchOutputSchema.safeParse({
      status: 'grounded',
      mode: 'deep',
      summary: 'Deep answer',
      sources: [],
      extra: true,
    });
    assert.strictEqual(unknown.success, false);
  });
});

describe('ChatOutputSchema', () => {
  it('accepts missing workspaceCacheApplied for compatibility', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
    });

    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.workspaceCacheApplied, undefined);
    }
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

  it('accepts function-call signatures and thought tool events under diagnostics', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
      workspaceCacheApplied: false,
      diagnostics: {
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
      },
      computations: [{ code: 'print(1)', output: '1' }],
    });

    assert.ok(result.success);
  });

  it('rejects unknown tool event kinds', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
      diagnostics: { toolEvents: [{ kind: 'unknown' }] },
    });

    assert.strictEqual(result.success, false);
  });

  it('rejects telemetry at the root level', () => {
    const result = ChatOutputSchema.safeParse({
      status: 'completed',
      answer: 'Done',
      toolEvents: [{ kind: 'thought', text: 'oops' }],
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
