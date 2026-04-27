import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeInputSchema,
  ChatInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../../src/schemas/inputs.js';
import {
  AnalyzeOutputSchema,
  ChatOutputSchema,
  ResearchOutputSchema,
  ReviewOutputSchema,
} from '../../src/schemas/outputs.js';
import type { SessionEventEntry } from '../../src/sessions.js';

describe('public contract schemas', () => {
  it('keeps SessionEventEntry audit shape stable', () => {
    const event = {
      request: { message: 'Hello', sentMessage: 'Hello', toolProfile: 'none', urls: [] },
      response: {
        anomalies: { namelessFunctionCalls: 1 },
        citationMetadata: {},
        data: {},
        finishMessage: 'done',
        finishReason: 'STOP',
        functionCalls: [],
        groundingMetadata: {},
        promptBlockReason: 'SAFETY',
        promptFeedback: {},
        safetyRatings: [],
        schemaWarnings: [],
        text: 'Hi',
        thoughts: 'summary',
        toolEvents: [],
        urlContextMetadata: {},
        usage: {},
      },
      taskId: 'task-1',
      timestamp: 1,
    } satisfies SessionEventEntry;

    assert.deepStrictEqual(Object.keys(event).sort(), [
      'request',
      'response',
      'taskId',
      'timestamp',
    ]);
    assert.deepStrictEqual(Object.keys(event.request).sort(), [
      'message',
      'sentMessage',
      'toolProfile',
      'urls',
    ]);
    assert.deepStrictEqual(Object.keys(event.response).sort(), [
      'anomalies',
      'citationMetadata',
      'data',
      'finishMessage',
      'finishReason',
      'functionCalls',
      'groundingMetadata',
      'promptBlockReason',
      'promptFeedback',
      'safetyRatings',
      'schemaWarnings',
      'text',
      'thoughts',
      'toolEvents',
      'urlContextMetadata',
      'usage',
    ]);
  });

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
      usage: {
        totalTokenCount: 1,
        toolUsePromptTokenCount: 1,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }],
        cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }],
        candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }],
      },
      warnings: ['note'],
      safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT' }],
      finishMessage: 'done',
      citationMetadata: { citationSources: [] },
    };

    assert.ok(
      ChatOutputSchema.safeParse({ ...base, answer: 'hello', workspaceCacheApplied: false })
        .success,
      'chat output should parse',
    );
    assert.ok(
      ChatOutputSchema.safeParse({
        ...base,
        answer: 'hello',
        workspaceCacheApplied: false,
        contextUsed: {
          sources: [{ kind: 'workspace-file', name: 'README.md', tokens: 100 }],
          totalTokens: 100,
          workspaceCacheApplied: false,
        },
      }).success,
      'chat output with contextUsed should parse',
    );
    assert.ok(
      ResearchOutputSchema.safeParse({
        ...base,
        status: 'partially_grounded',
        mode: 'quick',
        summary: 'x',
        sources: [],
        groundingSignals: {
          retrievalPerformed: true,
          urlContextUsed: true,
          groundingSupportsCount: 0,
          confidence: 'low',
        },
        findings: [
          {
            claim: 'x',
            supportingSourceUrls: ['https://example.com'],
            verificationStatus: 'cited',
          },
        ],
        sourceDetails: [
          { domain: 'example.com', origin: 'urlContext', url: 'https://example.com' },
        ],
        urlContextSources: ['https://example.com'],
      }).success,
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
        syntaxErrors: ['line 1: missing node'],
        syntaxValid: false,
        targetKind: 'multi',
      }).success,
      'diagram analyze output should parse',
    );
    assert.ok(
      ReviewOutputSchema.safeParse({ ...base, subjectKind: 'failure', summary: 'x' }).success,
      'review output should parse',
    );
  });

  it('locks the public status shapes and required chat cache flag', () => {
    assert.ok(
      ChatOutputSchema.safeParse({
        status: 'completed',
        answer: 'x',
        workspaceCacheApplied: false,
      }).success,
    );
    assert.ok(
      ResearchOutputSchema.safeParse({ status: 'grounded', mode: 'quick', summary: 's' }).success,
    );
    assert.ok(
      ResearchOutputSchema.safeParse({ status: 'ungrounded', mode: 'quick', summary: 's' }).success,
    );
    assert.ok(
      ResearchOutputSchema.safeParse({ status: 'completed', mode: 'quick', summary: 's' }).success,
    );
    assert.strictEqual(
      ChatOutputSchema.safeParse({ status: 'unknown', answer: 'x', workspaceCacheApplied: false })
        .success,
      false,
    );
    assert.strictEqual(
      ChatOutputSchema.safeParse({ status: 'completed', answer: 'x' }).success,
      false,
    );
  });

  it('keeps new optional fields backward-compatible on inputs and outputs', () => {
    assert.ok(ChatInputSchema.safeParse({ goal: 'x' }).success);
    assert.ok(ResearchInputSchema.safeParse({ mode: 'quick', goal: 'x' }).success);
    assert.ok(
      ChatInputSchema.safeParse({ goal: 'x', thinkingLevel: 'LOW', thinkingBudget: 32 }).success,
    );
    assert.ok(
      ResearchOutputSchema.safeParse({
        status: 'completed',
        mode: 'quick',
        summary: 'x',
        sources: [],
      }).success,
    );
  });
});
