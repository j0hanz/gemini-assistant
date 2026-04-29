import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

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

function findDiscriminatorBranches(
  schema: unknown,
  discriminator: string,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return {};
  }

  const branches = Array.isArray((schema as { oneOf?: unknown[] }).oneOf)
    ? ((schema as { oneOf?: unknown[] }).oneOf ?? [])
    : [];
  const result: Record<string, unknown> = {};

  for (const branch of branches) {
    if (!branch || typeof branch !== 'object') {
      continue;
    }

    const properties = (branch as { properties?: Record<string, unknown> }).properties;
    const propertySchema = properties?.[discriminator];
    if (
      propertySchema &&
      typeof propertySchema === 'object' &&
      'const' in propertySchema &&
      typeof propertySchema.const === 'string'
    ) {
      result[propertySchema.const] = branch;
    }
  }

  return result;
}

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
      status: 'completed' as const,
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
        session: { id: 'session-abc' },
      }).success,
      'chat output with session should parse',
    );
    assert.ok(
      ResearchOutputSchema.safeParse({
        ...base,
        status: 'partially_grounded',
        summary: 'x',
        sourceDetails: [
          { domain: 'example.com', origin: 'urlContext', url: 'https://example.com' },
        ],
        findings: [
          {
            claim: 'Example finding',
            supportingSourceUrls: ['https://example.com'],
            verificationStatus: 'cited',
          },
        ],
      }).success,
      'research output should parse',
    );
    assert.ok(
      AnalyzeOutputSchema.safeParse({
        ...base,
        status: 'ungrounded',
        summary: 'x',
      }).success,
      'analyze output should parse',
    );
    assert.ok(
      AnalyzeOutputSchema.safeParse({
        ...base,
        status: 'completed',
        diagram: 'flowchart TD\nA-->B',
        diagramType: 'mermaid',
        syntaxErrors: ['line 1: missing node'],
        syntaxValid: false,
      }).success,
      'diagram analyze output should parse',
    );
    assert.ok(
      ReviewOutputSchema.safeParse({ ...base, summary: 'x' }).success,
      'review output should parse',
    );
  });

  it('locks the public status shapes and keeps session id optional', () => {
    assert.ok(
      ChatOutputSchema.safeParse({
        status: 'completed',
        answer: 'x',
      }).success,
    );
    assert.ok(ResearchOutputSchema.safeParse({ status: 'grounded', summary: 's' }).success);
    assert.ok(ResearchOutputSchema.safeParse({ status: 'ungrounded', summary: 's' }).success);
    assert.strictEqual(
      ResearchOutputSchema.safeParse({ status: 'completed', summary: 's' }).success,
      false,
      'legacy completed status should be rejected on research outputs',
    );
    assert.strictEqual(
      ChatOutputSchema.safeParse({ status: 'unknown', answer: 'x' }).success,
      false,
    );
    assert.ok(ChatOutputSchema.safeParse({ status: 'completed', answer: 'x' }).success);
  });

  it('keeps discriminated oneOf JSON schema branches for public variant inputs', () => {
    const researchBranches = findDiscriminatorBranches(z.toJSONSchema(ResearchInputSchema), 'mode');
    const analyzeBranches = findDiscriminatorBranches(
      z.toJSONSchema(AnalyzeInputSchema),
      'targetKind',
    );
    const reviewBranches = findDiscriminatorBranches(
      z.toJSONSchema(ReviewInputSchema),
      'subjectKind',
    );

    assert.deepStrictEqual(Object.keys(researchBranches).sort(), ['deep', 'quick']);
    assert.deepStrictEqual(Object.keys(analyzeBranches).sort(), ['file', 'multi', 'url']);
    assert.deepStrictEqual(Object.keys(reviewBranches).sort(), ['comparison', 'diff', 'failure']);
  });

  it('keeps new optional fields backward-compatible on inputs and outputs', () => {
    assert.ok(ChatInputSchema.safeParse({ goal: 'x' }).success);
    assert.ok(ResearchInputSchema.safeParse({ mode: 'quick', goal: 'x' }).success);
    assert.ok(
      ChatInputSchema.safeParse({ goal: 'x', thinkingLevel: 'LOW', thinkingBudget: 32 }).success,
    );
    assert.ok(
      ResearchOutputSchema.safeParse({
        status: 'grounded',
        summary: 'x',
        sourceDetails: [
          { url: 'https://example.com', domain: 'example.com', origin: 'googleSearch' },
        ],
      }).success,
    );
  });
});
