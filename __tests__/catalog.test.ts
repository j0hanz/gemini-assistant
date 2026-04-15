import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findDiscoveryEntry,
  findWorkflowEntry,
  listDiscoveryEntries,
  listWorkflowEntries,
} from '../src/catalog.js';
import { createPromptDefinitions } from '../src/prompts.js';
import { PUBLIC_RESOURCE_URIS } from '../src/resources.js';
import {
  AgenticSearchInputSchema,
  AnalyzeFileInputSchema,
  AnalyzePrInputSchema,
  AnalyzeUrlInputSchema,
  AskInputSchema,
  CompareFilesInputSchema,
  CreateCacheInputSchema,
  DeleteCacheInputSchema,
  ExecuteCodeInputSchema,
  ExplainErrorInputSchema,
  GenerateDiagramInputSchema,
  SearchInputSchema,
  UpdateCacheInputSchema,
} from '../src/schemas/inputs.js';

function schemaInputs(schema: {
  shape: Record<string, { isOptional: () => boolean }>;
  keyof: () => { options: string[] };
}): string[] {
  return schema.keyof().options.map((key) => (schema.shape[key]?.isOptional() ? `${key}?` : key));
}

function resourceInputs(uri: string): string[] {
  return [...uri.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

const toolSchemas = new Map<string, string[]>([
  ['ask', schemaInputs(AskInputSchema)],
  ['execute_code', schemaInputs(ExecuteCodeInputSchema)],
  ['search', schemaInputs(SearchInputSchema)],
  ['agentic_search', schemaInputs(AgenticSearchInputSchema)],
  ['analyze_file', schemaInputs(AnalyzeFileInputSchema)],
  ['analyze_url', schemaInputs(AnalyzeUrlInputSchema)],
  ['analyze_pr', schemaInputs(AnalyzePrInputSchema)],
  ['explain_error', schemaInputs(ExplainErrorInputSchema)],
  ['compare_files', schemaInputs(CompareFilesInputSchema)],
  ['generate_diagram', schemaInputs(GenerateDiagramInputSchema)],
  ['create_cache', schemaInputs(CreateCacheInputSchema)],
  ['list_caches', []],
  ['delete_cache', schemaInputs(DeleteCacheInputSchema)],
  ['update_cache', schemaInputs(UpdateCacheInputSchema)],
]);

const promptSchemas = new Map(
  createPromptDefinitions(async () => ['C:\\workspace']).map((definition) => [
    definition.name,
    definition.argsSchema &&
    'shape' in definition.argsSchema &&
    typeof definition.argsSchema.keyof === 'function'
      ? schemaInputs(
          definition.argsSchema as {
            shape: Record<string, { isOptional: () => boolean }>;
            keyof: () => { options: string[] };
          },
        )
      : [],
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

  it('keeps workflows ordered with getting-started first', () => {
    const workflows = listWorkflowEntries();
    assert.strictEqual(workflows[0]?.name, 'getting-started');
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
});
