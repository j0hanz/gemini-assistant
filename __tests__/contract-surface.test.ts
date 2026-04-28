import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';
import {
  DISCOVERY_ENTRIES,
  JOB_METADATA,
  PUBLIC_PROMPT_NAMES,
  PUBLIC_RESOURCE_TEMPLATES,
  PUBLIC_RESOURCE_URIS,
  PUBLIC_STATIC_RESOURCE_URIS,
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
    assert.match(SERVER_INSTRUCTIONS, /STATELESS=true/);
    assert.match(SERVER_INSTRUCTIONS, /task-aware tools\/call requests are unavailable/i);
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
    assert.ok(review?.inputs.includes('fileSearch? (subjectKind=comparison or failure)'));
    assert.strictEqual(
      (review?.inputs as readonly string[] | undefined)?.includes('functions?'),
      false,
    );
  });

  it('partitions PUBLIC_RESOURCE_URIS into static and template tuples without overlap', () => {
    const staticSet = new Set<string>(PUBLIC_STATIC_RESOURCE_URIS);
    const templateSet = new Set<string>(PUBLIC_RESOURCE_TEMPLATES);
    for (const uri of PUBLIC_STATIC_RESOURCE_URIS) {
      assert.strictEqual(templateSet.has(uri), false, `static URI ${uri} must not be templated`);
    }
    for (const uri of PUBLIC_RESOURCE_TEMPLATES) {
      assert.strictEqual(staticSet.has(uri), false, `template URI ${uri} must not be static`);
      assert.ok(uri.includes('{'), `template URI ${uri} must contain placeholder`);
    }
    assert.deepStrictEqual(
      [...PUBLIC_RESOURCE_URIS].sort(),
      [...PUBLIC_STATIC_RESOURCE_URIS, ...PUBLIC_RESOURCE_TEMPLATES].sort(),
    );
  });

  it('softens the chat turnParts promise to reflect conditional availability', () => {
    const chat = DISCOVERY_ENTRIES.find((entry) => entry.kind === 'tool' && entry.name === 'chat');
    assert.ok(chat);
    assert.match(chat.returns, /available only when sessions persist/);
    assert.ok(
      chat.limitations?.some((limit) =>
        limit.includes('Stateless transport rejects chat calls that include sessionId'),
      ),
      'chat limitations must mention stateless rejection',
    );
  });

  it('describes chat cache skipping with the runtime conditions', () => {
    const chat = DISCOVERY_ENTRIES.find((entry) => entry.kind === 'tool' && entry.name === 'chat');
    assert.ok(chat);

    const cacheLimitation = chat.limitations?.find((limit) =>
      limit.includes('Workspace cache reuse is skipped'),
    );
    assert.ok(cacheLimitation, 'chat limitations must include workspace cache skip guidance');
    assert.match(cacheLimitation, /non-default temperature/);
    assert.match(cacheLimitation, /seed/);
    assert.match(cacheLimitation, /systemInstruction/);
    assert.doesNotMatch(cacheLimitation, /temperature, or seed/);
  });

  it('annotates selector-gated discovery inputs', () => {
    const analyze = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'analyze',
    );
    const research = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'research',
    );
    const review = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'review',
    );

    assert.ok(analyze);
    assert.ok(research);
    assert.ok(review);

    const assertAnnotatedInput = (
      inputs: readonly string[],
      field: string,
      selector: string,
    ): void => {
      assert.ok(
        inputs.some((input) => input.includes(field) && input.includes(selector)),
        `expected ${field} to include ${selector}`,
      );
    };

    assertAnnotatedInput(analyze.inputs, 'filePath', 'targetKind=file');
    assertAnnotatedInput(analyze.inputs, 'urls', 'targetKind=url');
    assertAnnotatedInput(analyze.inputs, 'filePaths', 'targetKind=multi');
    assertAnnotatedInput(analyze.inputs, 'diagramType', 'outputKind=diagram');
    assertAnnotatedInput(research.inputs, 'searchDepth', 'mode=deep');
    assertAnnotatedInput(research.inputs, 'deliverable', 'mode=deep');
    assertAnnotatedInput(review.inputs, 'filePathA', 'subjectKind=comparison');
    assertAnnotatedInput(review.inputs, 'error', 'subjectKind=failure');
    assertAnnotatedInput(review.inputs, 'dryRun', 'subjectKind=diff');
    assertAnnotatedInput(review.inputs, 'fileSearch', 'subjectKind=comparison or failure');
  });

  it('documents discovery-side selector strictness and forward-compatible enums', () => {
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

    assert.ok(chat);
    assert.ok(research);
    assert.ok(analyze);
    assert.ok(review);

    assert.ok(
      chat.limitations?.some((limit) =>
        limit.includes('resumed sessions reject responseSchemaJson'),
      ),
      'chat limitations must document resumed-session schema rejection',
    );
    assert.ok(
      research.limitations?.some(
        (limit) => limit.includes('searchDepth') && limit.includes('mode=quick'),
      ),
      'research limitations must document mode-specific field rejection',
    );
    assert.ok(
      review.limitations?.some((limit) => limit.includes('Subject-specific fields')),
      'review limitations must document subject-specific field rejection',
    );

    for (const entry of [research, analyze]) {
      assert.ok(
        entry.limitations?.some((limit) => limit.includes('forward-compatible open enums')),
        `${entry.name} limitations must document open-enum status fields`,
      );
    }
  });

  it('documents the current resource payloads and input caps in discovery metadata', () => {
    const discoverContext = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'resource' && entry.name === 'discover://context',
    );
    const sessionList = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'resource' && entry.name === 'session://',
    );
    const chat = DISCOVERY_ENTRIES.find((entry) => entry.kind === 'tool' && entry.name === 'chat');
    const research = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'research',
    );
    const review = DISCOVERY_ENTRIES.find(
      (entry) => entry.kind === 'tool' && entry.name === 'review',
    );

    assert.ok(discoverContext);
    assert.ok(sessionList);
    assert.ok(chat);
    assert.ok(research);
    assert.ok(review);

    assert.strictEqual(discoverContext.returns, 'JSON snapshot of the server context state.');
    assert.match(sessionList.returns, /active session summaries/i);
    assert.match(sessionList.returns, /lastAccess/i);

    const assertCap = (entry: (typeof DISCOVERY_ENTRIES)[number], value: string): void => {
      assert.ok(
        entry.limitations?.some((limit) => limit.includes(value)),
        `expected ${entry.name} limitations to mention ${value}`,
      );
    };

    assertCap(chat, 'goal max 100000 chars');
    assertCap(research, 'goal max 100000 chars');
    assertCap(review, 'error max 32000 chars');
    assertCap(review, 'codeContext max 16000 chars');
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
