import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import {
  AnalyzeInputSchema,
  ChatInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../../src/schemas/inputs.js';
import { GeminiResponseSchema } from '../../src/schemas/inputs.js';

function jsonSchemaProperty(
  schema: unknown,
  property: string,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;

  const properties = (schema as { properties?: unknown }).properties;
  if (properties && typeof properties === 'object') {
    const value = (properties as Record<string, unknown>)[property];
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = (schema as Record<string, unknown>)[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const value = jsonSchemaProperty(branch, property);
      if (value) return value;
    }
  }

  return undefined;
}

function findVariantBranch(
  schema: unknown,
  property: string,
  value: string,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;

  const propertySchema = jsonSchemaProperty(schema, property);
  const constValue = propertySchema?.const;
  if (constValue === value) {
    return schema as Record<string, unknown>;
  }

  const enumValue = propertySchema?.enum;
  if (Array.isArray(enumValue) && enumValue.length === 1 && enumValue[0] === value) {
    return schema as Record<string, unknown>;
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = (schema as Record<string, unknown>)[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const match = findVariantBranch(branch, property, value);
      if (match) return match;
    }
  }

  return undefined;
}

function assertRequiredField(schema: unknown, field: string): void {
  const required = (schema as { required?: unknown }).required;
  assert.ok(Array.isArray(required), 'expected required array');
  assert.ok(required.includes(field), `expected required to include ${field}`);
}

describe('GeminiResponseSchema', () => {
  it('does not advertise unsupported prefixItems in the supported-key message', () => {
    const result = GeminiResponseSchema.safeParse({});
    assert.strictEqual(result.success, false);

    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message).join('\n');
    assert.ok(messages.includes('properties'));
    assert.ok(!messages.includes('prefixItems'));
  });

  it('preserves exact property names in required', () => {
    const result = GeminiResponseSchema.safeParse({
      type: 'object',
      properties: {
        ' first name': { type: 'string' },
        'id ': { type: 'string' },
      },
      required: [' first name'],
    });

    assert.ok(result.success);
  });

  it('supports title and nullable fields', () => {
    const result = GeminiResponseSchema.safeParse({
      type: 'string',
      title: 'Status',
      nullable: true,
    });

    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.title, 'Status');
      assert.strictEqual(result.data.nullable, true);
    }
  });
});

describe('public input JSON Schema', () => {
  it('publishes declarative defaults for public inputs', () => {
    assert.strictEqual(
      jsonSchemaProperty(z.toJSONSchema(ChatInputSchema), 'temperature')?.default,
      1,
    );
  });

  it('publishes review selector branches with variant-specific required fields', () => {
    const reviewSchema = z.toJSONSchema(ReviewInputSchema);
    const diffBranch = findVariantBranch(reviewSchema, 'subjectKind', 'diff');
    const comparisonBranch = findVariantBranch(reviewSchema, 'subjectKind', 'comparison');
    const failureBranch = findVariantBranch(reviewSchema, 'subjectKind', 'failure');

    assert.strictEqual(jsonSchemaProperty(reviewSchema, 'subjectKind')?.default, 'diff');
    assert.ok(diffBranch);
    assert.ok(comparisonBranch);
    assert.ok(failureBranch);
    assertRequiredField(comparisonBranch, 'filePathA');
    assertRequiredField(comparisonBranch, 'filePathB');
    assertRequiredField(failureBranch, 'error');
    assert.strictEqual(jsonSchemaProperty(diffBranch, 'googleSearch'), undefined);
    assert.strictEqual(jsonSchemaProperty(diffBranch, 'urls'), undefined);
  });

  it('publishes research mode branches without cross-mode fields', () => {
    const researchSchema = z.toJSONSchema(ResearchInputSchema);
    const quickBranch = findVariantBranch(researchSchema, 'mode', 'quick');
    const deepBranch = findVariantBranch(researchSchema, 'mode', 'deep');

    assert.ok(quickBranch);
    assert.ok(deepBranch);
    assert.strictEqual(jsonSchemaProperty(researchSchema, 'mode')?.default, 'quick');
    assert.ok(jsonSchemaProperty(quickBranch, 'systemInstruction'));
    assert.strictEqual(jsonSchemaProperty(quickBranch, 'deliverable'), undefined);
    assert.strictEqual(jsonSchemaProperty(quickBranch, 'searchDepth'), undefined);
    assert.ok(jsonSchemaProperty(deepBranch, 'deliverable'));
    assert.ok(jsonSchemaProperty(deepBranch, 'searchDepth'));
    assert.strictEqual(jsonSchemaProperty(deepBranch, 'systemInstruction'), undefined);
  });

  it('publishes analyze target branches with required variant-specific inputs', () => {
    const analyzeSchema = z.toJSONSchema(AnalyzeInputSchema);
    const fileBranch = findVariantBranch(analyzeSchema, 'targetKind', 'file');
    const urlBranch = findVariantBranch(analyzeSchema, 'targetKind', 'url');
    const multiBranch = findVariantBranch(analyzeSchema, 'targetKind', 'multi');

    assert.ok(fileBranch);
    assert.ok(urlBranch);
    assert.ok(multiBranch);
    assert.strictEqual(jsonSchemaProperty(analyzeSchema, 'targetKind')?.default, 'file');
    assertRequiredField(fileBranch, 'filePath');
    assertRequiredField(urlBranch, 'urls');
    assertRequiredField(multiBranch, 'filePaths');
    assert.strictEqual(jsonSchemaProperty(urlBranch, 'filePath'), undefined);
    assert.strictEqual(jsonSchemaProperty(fileBranch, 'filePaths'), undefined);
  });
});
