import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import { z } from 'zod/v4';

import {
  appendSources,
  appendUrlStatus,
  auditClaimedToolUsage,
  buildSharedStructuredMetadata,
  buildSuccessfulStructuredContent,
  collectGroundedSourceDetails,
  collectGroundedSources,
  collectGroundingCitations,
  collectSearchEntryPoint,
  collectUrlMetadata,
  computeGroundingSignals,
  createResourceLink,
  deriveDiagramSyntaxValidation,
  deriveFindingsFromCitations,
  deriveOverallStatus,
  extractTextOrError,
  formatCountLabel,
  mergeSourceDetails,
  safeValidateStructuredContent,
  tryParseJsonResponse,
  validateStructuredContent,
  validateStructuredToolResult,
} from '../../src/lib/response.js';

function makeResponse(overrides: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Hello world' }] },
        finishReason: FinishReason.STOP,
      },
    ],
    text: 'Hello world',
    ...overrides,
  } as GenerateContentResponse;
}

describe('extractTextOrError', () => {
  it('extracts text from a normal response', () => {
    const result = extractTextOrError(makeResponse(), 'test');
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, 'Hello world');
  });

  it('returns error when no candidates (prompt blocked)', () => {
    const result = extractTextOrError(
      makeResponse({
        candidates: undefined,
        promptFeedback: { blockReason: 'SAFETY' } as GenerateContentResponse['promptFeedback'],
      }),
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /prompt blocked.*SAFETY/);
  });

  it('returns error when no candidates with unknown block reason', () => {
    const result = extractTextOrError(makeResponse({ candidates: undefined }), 'test');
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /unknown/);
  });

  it('returns error for SAFETY finish reason', () => {
    const result = extractTextOrError(
      makeResponse({
        candidates: [
          {
            content: { parts: [] },
            finishReason: FinishReason.SAFETY,
          },
        ],
        text: '',
      }),
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /safety filter/);
  });

  it('returns error for RECITATION finish reason', () => {
    const result = extractTextOrError(
      makeResponse({
        candidates: [
          {
            content: { parts: [] },
            finishReason: FinishReason.RECITATION,
          },
        ],
        text: '',
      }),
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /recitation/);
  });

  it('returns error for MAX_TOKENS with no text', () => {
    const result = extractTextOrError(
      makeResponse({
        candidates: [
          {
            content: { parts: [] },
            finishReason: FinishReason.MAX_TOKENS,
          },
        ],
        text: '',
      }),
      'test',
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /max tokens/);
  });

  it('returns text when MAX_TOKENS but text exists', () => {
    const result = extractTextOrError(
      makeResponse({
        candidates: [
          {
            content: { parts: [{ text: 'partial' }] },
            finishReason: FinishReason.MAX_TOKENS,
          },
        ],
        text: 'partial',
      }),
      'test',
    );
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, 'partial');
  });

  it('returns empty string text when response text is empty but not blocked', () => {
    const result = extractTextOrError(
      makeResponse({
        candidates: [
          {
            content: { parts: [] },
            finishReason: FinishReason.STOP,
          },
        ],
        text: '',
      }),
      'test',
    );
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0]?.text, '');
  });

  it('includes tool name in error messages', () => {
    const result = extractTextOrError(makeResponse({ candidates: undefined }), 'my_tool');
    assert.match(result.content[0]?.text ?? '', /my_tool/);
  });
});

describe('collectGroundedSources', () => {
  it('collects grounded source URLs', () => {
    const sources = collectGroundedSources({
      groundingChunks: [
        { web: { title: 'Example', uri: 'https://example.com' } },
        { web: { uri: 'https://example.org' } },
        { web: { title: 'Missing URI' } },
      ],
    });

    assert.deepStrictEqual(sources, ['https://example.com', 'https://example.org']);
  });

  it('returns an empty list when grounding metadata is missing', () => {
    assert.deepStrictEqual(collectGroundedSources(undefined), []);
  });

  it('filters out non-public URLs (e.g., file://)', () => {
    const sources = collectGroundedSources({
      groundingChunks: [
        { web: { title: 'Public', uri: 'https://example.com' } },
        { web: { title: 'Local', uri: 'file:///etc/passwd' } },
      ],
    });

    assert.deepStrictEqual(sources, ['https://example.com']);
  });

  it('dedupes grounded source URLs preserving order', () => {
    const sources = collectGroundedSources({
      groundingChunks: [
        { web: { title: 'First', uri: 'https://example.com' } },
        { web: { title: 'Duplicate', uri: 'https://example.com' } },
        { web: { title: 'Second', uri: 'https://example.org' } },
      ],
    });

    assert.deepStrictEqual(sources, ['https://example.com', 'https://example.org']);
  });
});

describe('buildSharedStructuredMetadata', () => {
  it('omits empty envelope fields and trivial finish messages', () => {
    assert.deepStrictEqual(
      buildSharedStructuredMetadata({
        functionCalls: [],
        thoughtText: '',
        toolEvents: [],
        safetyRatings: [],
        citationMetadata: {},
        finishMessage: 'STOP',
      }),
      {},
    );
  });

  it('retains populated envelope fields', () => {
    assert.deepStrictEqual(
      buildSharedStructuredMetadata({
        toolEvents: [{ kind: 'tool_call' }],
        safetyRatings: [{ category: 'x' }],
        citationMetadata: { citations: [{ startIndex: 0 }] },
        finishMessage: 'max tokens',
      }),
      {
        toolEvents: [{ kind: 'tool_call' }],
        safetyRatings: [{ category: 'x' }],
        citationMetadata: { citations: [{ startIndex: 0 }] },
        finishMessage: 'max tokens',
      },
    );
  });
});

describe('tryParseJsonResponse', () => {
  it('prefers the last fenced code block when earlier blocks are not JSON', () => {
    const parsed = tryParseJsonResponse(
      [
        'Summary text',
        '```ts',
        "console.log('not json');",
        '```',
        '```json',
        '{"documentationDrift":[{"file":"README.md"}]}',
        '```',
      ].join('\n'),
    );

    assert.deepStrictEqual(parsed, {
      documentationDrift: [{ file: 'README.md' }],
    });
  });

  it('prefers the trailing fenced JSON block when multiple JSON blocks are present', () => {
    const parsed = tryParseJsonResponse(
      [
        '```json',
        '{"documentationDrift":[{"file":"OLD.md"}]}',
        '```',
        'Interleaved analysis',
        '```json',
        '{"documentationDrift":[{"file":"NEW.md"}]}',
        '```',
      ].join('\n'),
    );

    assert.deepStrictEqual(parsed, {
      documentationDrift: [{ file: 'NEW.md' }],
    });
  });
});

describe('deriveDiagramSyntaxValidation', () => {
  it('returns empty metadata when no code execution result was emitted', () => {
    assert.deepStrictEqual(deriveDiagramSyntaxValidation([]), {});
  });

  it('marks syntax as valid for OUTCOME_OK', () => {
    assert.deepStrictEqual(
      deriveDiagramSyntaxValidation([{ kind: 'code_execution_result', outcome: 'OUTCOME_OK' }]),
      { syntaxValid: true },
    );
  });

  it('returns syntax errors for non-success outcomes', () => {
    assert.deepStrictEqual(
      deriveDiagramSyntaxValidation([
        {
          kind: 'code_execution_result',
          outcome: 'OUTCOME_ERROR',
          output: 'Parse error on line 1',
        },
      ]),
      { syntaxErrors: ['Parse error on line 1'], syntaxValid: false },
    );
  });
});

describe('auditClaimedToolUsage', () => {
  it('warns when prose claims search without search tool usage', () => {
    assert.deepStrictEqual(auditClaimedToolUsage('I searched and found a source.', []), [
      'prose claims googleSearch but it was not invoked this turn',
    ]);
  });

  it('does not warn when claimed capability matches actual tool usage', () => {
    assert.deepStrictEqual(
      auditClaimedToolUsage('I computed the result and verified by running code.', [
        'codeExecution',
      ]),
      [],
    );
  });

  it('returns no warnings when no claim pattern is present', () => {
    assert.deepStrictEqual(auditClaimedToolUsage('Here is the answer.', []), []);
  });
});

describe('buildSuccessfulStructuredContent', () => {
  it('keeps request id, non-empty warnings, domain fields, and shared stream metadata', () => {
    assert.deepStrictEqual(
      buildSuccessfulStructuredContent({
        requestId: 'task-1',
        warnings: ['check sources'],
        domain: {
          summary: 'done',
          omitted: undefined,
        },
        shared: {
          functionCalls: [{ name: 'lookup' }],
          usage: { totalTokenCount: 10 },
          safetyRatings: undefined,
        },
      }),
      {
        status: 'completed',
        requestId: 'task-1',
        warnings: ['check sources'],
        summary: 'done',
        functionCalls: [{ name: 'lookup' }],
        usage: { totalTokenCount: 10 },
      },
    );
  });

  it('omits empty optional base fields', () => {
    assert.deepStrictEqual(
      buildSuccessfulStructuredContent({
        warnings: [],
        domain: { summary: 'done' },
        shared: {},
      }),
      {
        status: 'completed',
        summary: 'done',
      },
    );
  });
});

describe('collectGroundedSourceDetails', () => {
  it('collects structured source details for grounded results', () => {
    const sources = collectGroundedSourceDetails({
      groundingChunks: [
        { web: { title: 'Example', uri: 'https://example.com' } },
        { web: { uri: 'https://example.org' } },
      ],
    });

    assert.deepStrictEqual(sources, [
      {
        domain: 'example.com',
        origin: 'googleSearch',
        title: 'Example',
        url: 'https://example.com',
      },
      { domain: 'example.org', origin: 'googleSearch', url: 'https://example.org' },
    ]);
  });

  it('dedupes and filters structured source details', () => {
    const sources = collectGroundedSourceDetails({
      groundingChunks: [
        { web: { title: 'First', uri: 'https://example.com' } },
        { web: { title: 'Duplicate', uri: 'https://example.com' } },
        { web: { title: 'Local', uri: 'file:///etc/passwd' } },
      ],
    });

    assert.deepStrictEqual(sources, [
      {
        domain: 'example.com',
        origin: 'googleSearch',
        title: 'First',
        url: 'https://example.com',
      },
    ]);
  });

  it('marks sources present in URL Context as both origins', () => {
    const sources = collectGroundedSourceDetails(
      {
        groundingChunks: [{ web: { title: 'Both', uri: 'https://example.com' } }],
      },
      new Set(['https://example.com']),
    );

    assert.deepStrictEqual(sources, [
      { domain: 'example.com', origin: 'both', title: 'Both', url: 'https://example.com' },
    ]);
  });
});

describe('mergeSourceDetails', () => {
  it('merges google search and URL Context details with both provenance', () => {
    const merged = mergeSourceDetails(
      [{ origin: 'googleSearch', title: 'Grounded', url: 'https://example.com' }],
      [
        { origin: 'urlContext', url: 'https://example.com' },
        { origin: 'urlContext', url: 'https://example.org' },
      ],
    );

    assert.deepStrictEqual(merged, [
      { origin: 'both', title: 'Grounded', url: 'https://example.com' },
      { origin: 'urlContext', url: 'https://example.org' },
    ]);
  });
});

describe('grounding signal helpers', () => {
  it('computes confidence from citations and retrieval metadata', () => {
    assert.strictEqual(computeGroundingSignals({}, [], [], []).confidence, 'none');
    assert.strictEqual(
      computeGroundingSignals(
        {},
        [],
        [{ url: 'https://example.com', status: 'URL_RETRIEVAL_STATUS_SUCCESS' }],
        [{ origin: 'urlContext', url: 'https://example.com' }],
      ).confidence,
      'low',
    );
    assert.strictEqual(
      computeGroundingSignals(
        {},
        [{ text: 'Claim', sourceUrls: ['https://example.com'] }],
        [],
        [{ origin: 'googleSearch', url: 'https://example.com' }],
      ).confidence,
      'medium',
    );
    assert.strictEqual(
      computeGroundingSignals(
        {},
        [
          { text: 'A', sourceUrls: ['https://example.com/a'] },
          { text: 'B', sourceUrls: ['https://example.com/b'] },
          { text: 'C', sourceUrls: ['https://example.com/c'] },
        ],
        [],
        [],
      ).confidence,
      'high',
    );
  });

  it('derives findings from citations', () => {
    const citations = [
      { text: 'Claim', sourceUrls: ['https://example.com/a'] },
      { text: 'Claim', sourceUrls: ['https://example.com/a'] },
      { text: 'Other', sourceUrls: ['https://example.com/b'] },
    ];

    assert.deepStrictEqual(deriveFindingsFromCitations(citations), [
      {
        claim: 'Claim',
        supportingSourceUrls: ['https://example.com/a'],
        verificationStatus: 'cited',
      },
      {
        claim: 'Other',
        supportingSourceUrls: ['https://example.com/b'],
        verificationStatus: 'cited',
      },
    ]);
  });

  it('does not let prose-only tool-usage audits affect grounding confidence', () => {
    const warnings = auditClaimedToolUsage('I searched and found a source.', []);
    assert.deepStrictEqual(warnings, [
      'prose claims googleSearch but it was not invoked this turn',
    ]);
    assert.strictEqual(
      computeGroundingSignals(
        {},
        [{ text: 'Claim', sourceUrls: ['https://example.com'] }],
        [],
        [{ origin: 'googleSearch', url: 'https://example.com' }],
      ).confidence,
      'medium',
    );
  });

  it('derives overall status from grounding confidence', () => {
    assert.strictEqual(
      deriveOverallStatus({
        retrievalPerformed: false,
        urlContextUsed: false,
        groundingSupportsCount: 0,
        confidence: 'none',
      }),
      'ungrounded',
    );
    assert.strictEqual(
      deriveOverallStatus({
        retrievalPerformed: true,
        urlContextUsed: true,
        groundingSupportsCount: 0,
        confidence: 'low',
      }),
      'partially_grounded',
    );
    assert.strictEqual(
      deriveOverallStatus({
        retrievalPerformed: true,
        urlContextUsed: false,
        groundingSupportsCount: 3,
        confidence: 'high',
      }),
      'grounded',
    );
  });
});

describe('collectUrlMetadata', () => {
  it('dedupes and filters URL metadata', () => {
    const metadata = collectUrlMetadata([
      {
        retrievedUrl: 'https://example.com',
        urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
      },
      {
        retrievedUrl: 'https://example.com',
        urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR',
      },
      {
        retrievedUrl: 'file:///etc/passwd',
        urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
      },
    ]);

    assert.deepStrictEqual(metadata, [
      { url: 'https://example.com', status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
    ]);
  });
});

describe('collectGroundingCitations', () => {
  it('maps grounding supports to public chunk URLs', () => {
    const result = collectGroundingCitations({
      groundingChunks: [
        { web: { uri: 'https://example.com/a' } },
        { web: { uri: 'file:///etc/passwd' } },
        { web: { uri: 'https://example.com/b' } },
      ],
      groundingSupports: [
        {
          groundingChunkIndices: [0, 1, 2],
          segment: { text: 'Supported claim', startIndex: 0, endIndex: 15 },
        },
        {
          groundingChunkIndices: [1],
          segment: { text: 'Unsafe only' },
        },
      ],
    });

    assert.strictEqual(result.droppedSupportCount, 1);
    assert.deepStrictEqual(result.citations, [
      {
        text: 'Supported claim',
        startIndex: 0,
        endIndex: 15,
        sourceUrls: ['https://example.com/a', 'https://example.com/b'],
      },
    ]);
  });
});

describe('collectSearchEntryPoint', () => {
  it('returns rendered Google Search content when present', () => {
    assert.deepStrictEqual(
      collectSearchEntryPoint({
        searchEntryPoint: { renderedContent: '<div>search</div>' },
      }),
      { renderedContent: '<div>search</div>' },
    );
  });
});

describe('appendSources', () => {
  it('appends a sources section when entries exist', () => {
    const content: { type: string; text?: string }[] = [];
    appendSources(content as never, ['Example: https://example.com']);

    assert.strictEqual(content.length, 1);
    assert.match(content[0]?.text ?? '', /Sources:/);
    assert.match(content[0]?.text ?? '', /Example: https:\/\/example.com/);
  });

  it('does nothing when no sources exist', () => {
    const content: { type: string; text?: string }[] = [];
    appendSources(content as never, []);
    assert.strictEqual(content.length, 0);
  });
});

describe('appendUrlStatus', () => {
  it('formats URL retrieval status as bullet lines', () => {
    const content: { type: string; text?: string }[] = [];
    appendUrlStatus(content as never, [
      { url: 'https://example.com', status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
    ]);

    assert.strictEqual(content.length, 1);
    assert.match(content[0]?.text ?? '', /URL Retrieval Status:/);
    assert.match(content[0]?.text ?? '', /https:\/\/example.com: URL_RETRIEVAL_STATUS_SUCCESS/);
  });
});

describe('createResourceLink', () => {
  it('creates a JSON resource link with the default mime type', () => {
    assert.deepStrictEqual(createResourceLink('sessions://abc', 'Chat Session abc'), {
      type: 'resource_link',
      uri: 'sessions://abc',
      name: 'Chat Session abc',
      mimeType: 'application/json',
    });
  });

  it('allows overriding the mime type', () => {
    assert.deepStrictEqual(createResourceLink('custom://resource', 'Custom', 'text/plain'), {
      type: 'resource_link',
      uri: 'custom://resource',
      name: 'Custom',
      mimeType: 'text/plain',
    });
  });
});

describe('formatCountLabel', () => {
  it('formats singular and plural labels', () => {
    assert.strictEqual(formatCountLabel(1, 'source'), '1 source');
    assert.strictEqual(formatCountLabel(2, 'source'), '2 sources');
    assert.strictEqual(formatCountLabel(0, 'URL'), '0 URLs');
  });
});

describe('validateStructuredContent', () => {
  it('returns parsed structured content when it matches the schema', () => {
    const parsed = validateStructuredContent(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        status: 'completed',
        summary: 'ok',
      },
    );

    assert.deepStrictEqual(parsed, {
      status: 'completed',
      summary: 'ok',
    });
  });

  it('throws when structured content does not match the schema', () => {
    assert.throws(
      () =>
        validateStructuredContent(
          'test-tool',
          z.strictObject({
            status: z.literal('completed'),
            summary: z.string(),
          }),
          {
            status: 'completed',
            explanation: 'wrong field',
          },
        ),
      /does not match outputSchema/,
    );
  });
});

describe('safeValidateStructuredContent', () => {
  it('returns parsed structured content when it matches the schema', () => {
    const result = safeValidateStructuredContent(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        status: 'completed',
        summary: 'ok',
      },
      {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          status: 'completed',
          summary: 'ok',
        },
      },
    );

    assert.deepStrictEqual(result.structuredContent, {
      status: 'completed',
      summary: 'ok',
    });
    assert.strictEqual(result.isError, undefined);
  });

  it('returns a warning when structured content does not match but visible content exists', () => {
    const result = safeValidateStructuredContent(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        status: 'completed',
        explanation: 'wrong field',
      },
      {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'text', text: 'link' },
        ],
        structuredContent: {
          status: 'completed',
          explanation: 'wrong field',
        },
      },
    );

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.structuredContent, undefined);
    assert.strictEqual(result.content[0]?.text, 'ok');
    assert.strictEqual(result.content[1]?.text, 'link');
    assert.match(
      result.content[2]?.text ?? '',
      /Warning: test-tool structuredContent did not match outputSchema and was omitted\./,
    );
  });

  it('still errors when structured content mismatches and there is no visible content', () => {
    const result = safeValidateStructuredContent(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        status: 'completed',
        explanation: 'wrong field',
      },
      {
        content: [{ type: 'text', text: '' }],
        structuredContent: {
          status: 'completed',
          explanation: 'wrong field',
        },
      },
    );

    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[1]?.text ?? '',
      /Internal test-tool output validation failed: structuredContent did not match outputSchema\./,
    );
  });

  it('produces the same failure shape as validateStructuredToolResult', () => {
    const schema = z.strictObject({
      status: z.literal('completed'),
      summary: z.string(),
    });
    const originalContent = [
      { type: 'text' as const, text: 'first' },
      { type: 'text' as const, text: 'second' },
    ];
    const structured = { status: 'completed', explanation: 'bad' };

    const viaSafe = safeValidateStructuredContent('test-tool', schema, structured, {
      content: originalContent,
      structuredContent: structured,
    });
    const viaToolResult = validateStructuredToolResult('test-tool', schema, {
      content: originalContent,
      structuredContent: structured,
    });

    assert.deepStrictEqual(viaSafe, viaToolResult);
  });
});

describe('validateStructuredToolResult', () => {
  it('returns parsed structured content when it matches the schema', () => {
    const result = validateStructuredToolResult(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          status: 'completed',
          summary: 'ok',
        },
      },
    );

    assert.deepStrictEqual(result.structuredContent, {
      status: 'completed',
      summary: 'ok',
    });
    assert.strictEqual(result.isError, undefined);
  });

  it('converts invalid structured content into a warning when visible content exists', () => {
    const result = validateStructuredToolResult(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          status: 'completed',
          explanation: 'wrong field',
        },
      },
    );

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.structuredContent, undefined);
    assert.strictEqual(result.content[0]?.text, 'ok');
    assert.match(
      result.content[1]?.text ?? '',
      /Warning: test-tool structuredContent did not match outputSchema and was omitted\./,
    );
  });

  it('is a no-op for error results, missing structured content, and missing safeParse', () => {
    const errorResult = {
      content: [{ type: 'text' as const, text: 'bad' }],
      isError: true,
      structuredContent: { status: 'completed', summary: 'ignored' },
    };
    assert.deepStrictEqual(
      validateStructuredToolResult('test-tool', z.string(), errorResult),
      errorResult,
    );

    const noStructured = { content: [{ type: 'text' as const, text: 'ok' }] };
    assert.deepStrictEqual(
      validateStructuredToolResult('test-tool', z.string(), noStructured),
      noStructured,
    );

    const nonSchema = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { status: 'completed', summary: 'ok' },
    };
    assert.deepStrictEqual(validateStructuredToolResult('test-tool', {}, nonSchema), nonSchema);
  });

  it('retains original content, appends a validation warning entry, and omits structuredContent key', () => {
    const result = validateStructuredToolResult(
      'test-tool',
      z.strictObject({
        status: z.literal('completed'),
        summary: z.string(),
      }),
      {
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        structuredContent: { status: 'completed', explanation: 'bad' },
      },
    );

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.structuredContent, undefined);
    assert.strictEqual(result.content[0]?.text, 'first');
    assert.strictEqual(result.content[1]?.text, 'second');
    assert.match(
      result.content[2]?.text ?? '',
      /Warning: test-tool structuredContent did not match outputSchema and was omitted\./,
    );
  });
});
