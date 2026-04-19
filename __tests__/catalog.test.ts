import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findDiscoveryEntry,
  findWorkflowEntry,
  listDiscoveryEntries,
  listWorkflowEntries,
} from '../src/catalog.js';
import { createPromptDefinitions } from '../src/prompts.js';
import { PUBLIC_RESOURCE_URIS, PUBLIC_TOOL_NAMES } from '../src/public-contract.js';
import {
  AnalyzeInputSchema,
  ChatInputSchema,
  createMemoryInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../src/schemas/inputs.js';

interface ObjectLikeSchema {
  shape: Record<string, { isOptional: () => boolean }>;
  keyof: () => { options: string[] };
}

function isObjectLikeSchema(schema: unknown): schema is ObjectLikeSchema {
  return (
    !!schema &&
    typeof schema === 'object' &&
    'shape' in schema &&
    'keyof' in schema &&
    typeof schema.keyof === 'function'
  );
}

function isUnionLikeSchema(schema: unknown): schema is { options: unknown[] } {
  return (
    !!schema && typeof schema === 'object' && 'options' in schema && Array.isArray(schema.options)
  );
}

function isPipeLikeSchema(schema: unknown): schema is { in: unknown } {
  return !!schema && typeof schema === 'object' && 'in' in schema;
}

function schemaInputs(schema: unknown): string[] {
  if (isPipeLikeSchema(schema)) {
    return schemaInputs(schema.in);
  }

  if (isObjectLikeSchema(schema)) {
    return schema.keyof().options.map((key) => (schema.shape[key]?.isOptional() ? `${key}?` : key));
  }

  if (isUnionLikeSchema(schema)) {
    const options = schema.options.filter(isObjectLikeSchema);
    const keys: string[] = [];

    for (const option of options) {
      for (const key of option.keyof().options) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
    }

    return keys.map((key) => {
      const requiredInAllOptions = options.every(
        (option) => key in option.shape && !option.shape[key]?.isOptional(),
      );
      return requiredInAllOptions ? key : `${key}?`;
    });
  }

  return [];
}

function resourceInputs(uri: string): string[] {
  return [...uri.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

const toolSchemas = new Map<string, string[]>([
  ['chat', schemaInputs(ChatInputSchema)],
  ['research', schemaInputs(ResearchInputSchema)],
  ['analyze', schemaInputs(AnalyzeInputSchema)],
  ['review', schemaInputs(ReviewInputSchema)],
  ['memory', schemaInputs(createMemoryInputSchema(() => []))],
]);

const promptSchemas = new Map(
  createPromptDefinitions().map((definition) => [
    definition.name,
    definition.argsSchema ? schemaInputs(definition.argsSchema) : [],
  ]),
);

describe('catalog', () => {
  it('keeps discovery entries uniquely named within each kind', () => {
    const seen = new Set<string>();

    for (const entry of listDiscoveryEntries()) {
      const key = `${entry.kind}:${entry.name}`;
      assert.strictEqual(seen.has(key), false, `Duplicate catalog entry: ${key}`);
      seen.add(key);
    }
  });

  it('returns discovery entries in deterministic kind/name order', () => {
    const entries = listDiscoveryEntries();
    const sorted = [...entries].sort((left, right) => {
      const kindOrder =
        ['tool', 'prompt', 'resource'].indexOf(left.kind) -
        ['tool', 'prompt', 'resource'].indexOf(right.kind);
      if (kindOrder !== 0) return kindOrder;
      return left.name.localeCompare(right.name);
    });

    assert.deepStrictEqual(entries, sorted);
  });

  it('keeps related references valid', () => {
    for (const entry of listDiscoveryEntries()) {
      for (const related of entry.related) {
        assert.ok(
          findDiscoveryEntry(related.kind, related.name),
          `Missing related catalog reference: ${entry.kind}:${entry.name} -> ${related.kind}:${related.name}`,
        );
      }
    }
  });

  it('keeps workflows ordered with start-here first', () => {
    const workflows = listWorkflowEntries();
    assert.strictEqual(workflows[0]?.name, 'start-here');
  });

  it('keeps workflow references valid', () => {
    for (const workflow of listWorkflowEntries()) {
      assert.ok(findWorkflowEntry(workflow.name));

      for (const tool of workflow.recommendedTools) {
        assert.ok(findDiscoveryEntry('tool', tool), `Missing workflow tool reference: ${tool}`);
      }

      for (const prompt of workflow.recommendedPrompts) {
        assert.ok(
          findDiscoveryEntry('prompt', prompt),
          `Missing workflow prompt reference: ${prompt}`,
        );
      }

      for (const resource of workflow.relatedResources) {
        assert.ok(
          findDiscoveryEntry('resource', resource),
          `Missing workflow resource reference: ${resource}`,
        );
      }
    }
  });

  it('keeps tool input metadata aligned with live schemas', () => {
    for (const entry of listDiscoveryEntries().filter((entry) => entry.kind === 'tool')) {
      assert.deepStrictEqual(
        entry.inputs,
        toolSchemas.get(entry.name),
        `Catalog tool inputs drifted for ${entry.name}`,
      );
    }
  });

  it('keeps prompt input metadata aligned with prompt schemas', () => {
    for (const entry of listDiscoveryEntries().filter((entry) => entry.kind === 'prompt')) {
      assert.deepStrictEqual(
        entry.inputs,
        promptSchemas.get(entry.name),
        `Catalog prompt inputs drifted for ${entry.name}`,
      );
    }
  });

  it('keeps resource input metadata aligned with URI templates', () => {
    for (const resourceUri of PUBLIC_RESOURCE_URIS) {
      const entry = findDiscoveryEntry('resource', resourceUri);
      assert.ok(entry, `Missing resource catalog entry: ${resourceUri}`);
      assert.deepStrictEqual(
        entry.inputs,
        resourceInputs(resourceUri),
        `Catalog resource inputs drifted for ${resourceUri}`,
      );
    }
  });

  it('documents limitations for contract-sensitive jobs', () => {
    for (const toolName of ['chat', 'research', 'analyze', 'review', 'memory']) {
      const entry = findDiscoveryEntry('tool', toolName);
      assert.ok(entry, `Missing tool entry for ${toolName}`);
      assert.ok(entry?.limitations && entry.limitations.length > 0);
    }
  });

  it('keeps the tool catalog aligned with the public job list', () => {
    const toolNames = listDiscoveryEntries()
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => entry.name);
    assert.deepStrictEqual(toolNames, [...PUBLIC_TOOL_NAMES].sort());
  });
});
