import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findDiscoveryEntry,
  findWorkflowEntry,
  listDiscoveryEntries,
  listWorkflowEntries,
} from '../src/catalog.js';

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
});
