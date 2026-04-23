import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import {
  AnalyzeInputSchema,
  ChatInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../../src/schemas/inputs.js';
import { GeminiResponseSchema } from '../../src/schemas/json-schema.js';

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

function oneOfBranches(schema: unknown): unknown[] {
  return schema &&
    typeof schema === 'object' &&
    Array.isArray((schema as { oneOf?: unknown }).oneOf)
    ? (schema as { oneOf: unknown[] }).oneOf
    : [];
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
    assert.strictEqual(
      jsonSchemaProperty(z.toJSONSchema(ResearchInputSchema), 'searchDepth')?.default,
      2,
    );
    assert.strictEqual(
      jsonSchemaProperty(z.toJSONSchema(AnalyzeInputSchema), 'diagramType')?.default,
      'mermaid',
    );
  });

  it('publishes review as an action-specific oneOf schema', () => {
    const reviewBranches = oneOfBranches(z.toJSONSchema(ReviewInputSchema));

    assert.strictEqual(reviewBranches.length, 3);
    assert.ok(
      reviewBranches.some((branch) =>
        ((branch as { required?: unknown }).required as unknown[] | undefined)?.includes(
          'filePathA',
        ),
      ),
    );
  });
});
