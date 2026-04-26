import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';
import {
  DISCOVERY_ENTRIES,
  JOB_METADATA,
  PUBLIC_PROMPT_NAMES,
  PUBLIC_RESOURCE_URIS,
  PUBLIC_TOOL_NAMES,
  PUBLIC_WORKFLOW_NAMES,
} from '../src/public-contract.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('contract surface invariants', () => {
  it('keeps discovery metadata aligned with the public tool, prompt, and resource constants', () => {
    const discoveryEntries = listDiscoveryEntries();

    assert.deepStrictEqual(
      discoveryEntries.filter((entry) => entry.kind === 'tool').map((entry) => entry.name),
      [...PUBLIC_TOOL_NAMES].sort(),
    );
    assert.deepStrictEqual(
      discoveryEntries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.name),
      [...PUBLIC_PROMPT_NAMES].sort(),
    );
    assert.deepStrictEqual(
      discoveryEntries.filter((entry) => entry.kind === 'resource').map((entry) => entry.name),
      [...PUBLIC_RESOURCE_URIS].sort(),
    );
    assert.deepStrictEqual(
      DISCOVERY_ENTRIES.filter((entry) => entry.kind === 'tool').map((entry) => entry.name),
      [...PUBLIC_TOOL_NAMES],
    );
    assert.deepStrictEqual(
      JOB_METADATA.map((entry) => entry.name),
      [...PUBLIC_TOOL_NAMES],
    );
  });

  it('keeps workflow references within the public contract and README', () => {
    const workflows = listWorkflowEntries();

    assert.deepStrictEqual(
      workflows.map((workflow) => workflow.name),
      [...PUBLIC_WORKFLOW_NAMES],
    );

    for (const workflow of workflows) {
      for (const toolName of workflow.recommendedTools) {
        assert.ok(PUBLIC_TOOL_NAMES.includes(toolName));
      }
      for (const promptName of workflow.recommendedPrompts) {
        assert.ok(PUBLIC_PROMPT_NAMES.includes(promptName));
      }
      for (const resourceUri of workflow.relatedResources) {
        assert.ok(PUBLIC_RESOURCE_URIS.includes(resourceUri));
      }

      assert.match(readme, new RegExp(workflow.name.replace('-', '\\-')));
    }
  });

  it('mentions every public contract entry in the README', () => {
    for (const toolName of PUBLIC_TOOL_NAMES) {
      assert.match(readme, new RegExp(toolName));
    }
    for (const promptName of PUBLIC_PROMPT_NAMES) {
      assert.match(readme, new RegExp(promptName));
    }
    for (const resourceUri of PUBLIC_RESOURCE_URIS) {
      assert.match(readme, new RegExp(resourceUri.replace(/[{}]/g, '\\$&')));
    }
  });

  it('mentions every public tool and canonical discovery resource in SERVER_INSTRUCTIONS', () => {
    for (const toolName of PUBLIC_TOOL_NAMES) {
      assert.match(SERVER_INSTRUCTIONS, new RegExp(toolName));
    }

    assert.match(SERVER_INSTRUCTIONS, /discover:\/\/catalog/);
    assert.match(SERVER_INSTRUCTIONS, /discover:\/\/workflows/);
  });

  it('exposes new tool parameters only on intended public surfaces', () => {
    const chat = DISCOVERY_ENTRIES.find((entry) => entry.kind === 'tool' && entry.name === 'chat');
    const research = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'research',
    );
    const analyze = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'analyze',
    );
    const review = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'review',
    );

    assert.ok(chat?.inputs.includes('fileSearch?'));
    assert.ok(chat?.inputs.includes('functions?'));
    assert.ok(chat?.inputs.includes('googleSearch?'));
    assert.ok(chat?.inputs.includes('urls?'));
    assert.ok(chat?.inputs.includes('serverSideToolInvocations?'));
    assert.ok(research?.inputs.includes('fileSearch?'));
    assert.strictEqual(
      (research?.inputs as readonly string[] | undefined)?.includes('functions?'),
      false,
    );
    assert.ok(analyze?.inputs.includes('fileSearch?'));
    assert.strictEqual(
      (analyze?.inputs as readonly string[] | undefined)?.includes('functions?'),
      false,
    );
    assert.ok(review?.inputs.includes('fileSearch?'));
    assert.strictEqual(
      (review?.inputs as readonly string[] | undefined)?.includes('functions?'),
      false,
    );
  });

  it('does not advertise resources.subscribe in the initialize capability set', async () => {
    const { MockGeminiEnvironment } = await import('./lib/mock-gemini-environment.js');
    const { createServerHarness } = await import('./lib/mcp-contract-client.js');
    const { createServerInstance } = await import('../src/server.js');

    process.env.API_KEY ??= 'test-key-for-contract-surface';
    const env = new MockGeminiEnvironment();
    env.install();
    const harness = await createServerHarness(
      createServerInstance,
      { capabilities: { roots: {} } },
      { flushBeforeClose: 2 },
    );
    try {
      const initResult = await harness.client.initialize();
      const capabilities = initResult.result.capabilities as
        | { resources?: { listChanged?: boolean; subscribe?: boolean } }
        | undefined;
      assert.ok(capabilities?.resources?.listChanged, 'resources.listChanged must remain true');
      assert.notStrictEqual(
        capabilities?.resources?.subscribe,
        true,
        'resources.subscribe must not be advertised without per-URI subscribe/unsubscribe support',
      );
    } finally {
      await harness.close();
      env.restore();
    }
  });
});
