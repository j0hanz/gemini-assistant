import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { listWorkflowEntries } from '../src/catalog.js';
import {
  PUBLIC_PROMPT_NAMES,
  PUBLIC_RESOURCE_URIS,
  PUBLIC_TOOL_NAMES,
  PUBLIC_WORKFLOW_NAMES,
} from '../src/public-contract.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  description?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  keywords?: string[];
  license?: string;
  repository?: { type?: string; url?: string } | string;
};

describe('documentation and package metadata', () => {
  it('names the public tools, prompts, and resources in the README', () => {
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

  it('mentions the workflow catalog in the README', () => {
    assert.deepStrictEqual(
      listWorkflowEntries().map((workflow) => workflow.name),
      [...PUBLIC_WORKFLOW_NAMES],
    );

    for (const workflow of listWorkflowEntries()) {
      assert.match(readme, new RegExp(workflow.name.replace('-', '\\-')));
    }
  });

  it('documents the job-first surface and memory/discovery split', () => {
    assert.match(readme, /job-first public surface/i);
    assert.match(readme, /discover:\/\/catalog/);
    assert.match(readme, /session:\/\//);
    assert.match(readme, /quick or deep/i);
    assert.match(readme, /no backward-compatible aliases/i);
  });

  it('documents process-local runtime state limits', () => {
    assert.match(readme, /process-local/i);
    assert.match(readme, /process restart/i);
    assert.match(readme, /task results/i);
    assert.match(readme, /task queues/i);
    assert.match(readme, /in-memory/i);
  });

  it('documents current public defaults and grounding metadata accurately', () => {
    assert.match(readme, /`research\.mode` defaults to `quick`/);
    assert.match(readme, /`analyze\.outputKind` defaults to `summary`/);
    assert.match(readme, /`thinkingBudget`.*only when `thinkingLevel` is omitted/s);
    assert.match(readme, /`groundingSignals` reports/);
    assert.doesNotMatch(readme, /`grounded` is true/);
    assert.doesNotMatch(readme, /structuredContent\.searchEntryPoint/);
  });

  it('documents replay defaults from config', () => {
    assert.match(readme, /`SESSION_REPLAY_MAX_BYTES`: byte budget.*default `50000`/);
    assert.match(
      readme,
      /`SESSION_REPLAY_INLINE_DATA_MAX_BYTES`: max inline media.*default `16384`/,
    );
  });

  it('documents public chat grounding inputs', () => {
    assert.match(
      readme,
      /Public `chat\.googleSearch` and\s+`chat\.urls` enable direct conversation grounding/,
    );
  });

  it('keeps web-standard runtime guidance aligned with transport behavior', () => {
    assert.match(readme, /Auto-serves only when the process is running under Bun or Deno\./);
    assert.match(readme, /returns a `handler` but does not start a listener/);
  });

  it('keeps package metadata aligned with distribution and discovery vocabulary', () => {
    assert.match(packageJson.description ?? '', /Gemini/i);
    assert.match(packageJson.description ?? '', /MCP/i);
    assert.deepStrictEqual(packageJson.files, ['dist', 'README.md']);
    assert.ok(packageJson.exports && '.' in packageJson.exports);
    assert.ok(Array.isArray(packageJson.keywords));
    assert.ok(packageJson.keywords?.includes('mcp'));
    assert.ok(packageJson.keywords?.includes('gemini'));
    assert.strictEqual(packageJson.license, 'MIT');
  });

  it('keeps the repository metadata explicit', () => {
    assert.deepStrictEqual(packageJson.repository, {
      type: 'git',
      url: 'git+https://github.com/j0hanz/gemini-assistant.git',
    });
  });
});
