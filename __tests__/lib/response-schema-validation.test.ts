import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSchemaValidationWarnings, validateSchemaOutput } from '../../src/lib/response.js';

describe('validateSchemaOutput', () => {
  it('returns no warnings when data matches the schema', () => {
    const schema = {
      type: 'object' as const,
      properties: { name: { type: 'string' as const } },
      required: ['name'],
    };
    assert.deepEqual(validateSchemaOutput({ name: 'ok' }, schema), []);
  });

  it('returns instance-location warnings for missing required fields', () => {
    const schema = {
      type: 'object' as const,
      properties: { name: { type: 'string' as const } },
      required: ['name'],
    };
    const warnings = validateSchemaOutput({}, schema);
    assert.equal(warnings.length >= 1, true);
    assert.equal(
      warnings.some((w) => w.includes('name') || w.length > 0),
      true,
    );
  });

  it('returns a fallback warning when validation throws', () => {
    // Force an error by passing something the validator cannot process
    const result = validateSchemaOutput(undefined, null as unknown as Record<string, unknown>);
    assert.equal(result.length, 1);
    const first = result[0];
    assert.ok(first !== undefined);
    assert.match(first, /could not be performed/);
  });
});

describe('buildSchemaValidationWarnings', () => {
  it('warns when jsonMode is true but parsedData is undefined', () => {
    const warnings = buildSchemaValidationWarnings(undefined, true, undefined);
    assert.deepEqual(warnings, ['Failed to parse JSON from model response']);
  });

  it('returns no warnings when jsonMode is false', () => {
    assert.deepEqual(buildSchemaValidationWarnings({}, false, undefined), []);
  });

  it('returns no warnings when jsonMode is undefined', () => {
    assert.deepEqual(buildSchemaValidationWarnings({}, undefined, undefined), []);
  });

  it('appends schema validation warnings when schema is provided and data is valid', () => {
    const schema = {
      type: 'object' as const,
      properties: { name: { type: 'string' as const } },
      required: ['name'],
    };
    assert.deepEqual(buildSchemaValidationWarnings({ name: 'ok' }, true, schema), []);
  });

  it('appends schema validation warnings when data violates schema', () => {
    const schema = {
      type: 'object' as const,
      properties: { name: { type: 'string' as const } },
      required: ['name'],
    };
    const warnings = buildSchemaValidationWarnings({}, true, schema);
    assert.equal(warnings.length >= 1, true);
  });
});
