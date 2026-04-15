import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { listWorkflowEntries } from '../src/catalog.js';
import { PUBLIC_RESOURCE_URIS } from '../src/resources.js';

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
  it('names the public prompts and resources in the README', () => {
    for (const promptName of [
      'getting-started',
      'deep-research',
      'project-memory',
      'diff-review',
    ]) {
      assert.match(readme, new RegExp(promptName.replace('-', '\\-')));
    }

    for (const resourceUri of PUBLIC_RESOURCE_URIS) {
      assert.match(readme, new RegExp(resourceUri.replace(/[{}]/g, '\\$&')));
    }
  });

  it('mentions the workflow catalog in the README', () => {
    for (const workflow of listWorkflowEntries()) {
      assert.match(readme, new RegExp(workflow.name.replace('-', '\\-')));
    }
  });

  it('keeps web-standard runtime guidance aligned with transport behavior', () => {
    assert.match(readme, /Auto-serves only when the process is running under Bun or Deno\./);
    assert.match(readme, /returns a `handler` but does not start a listener/);
    assert.doesNotMatch(
      readme,
      /```bash\s*MCP_TRANSPORT=web-standard npx tsx src\/index\.ts\s*```/s,
    );
  });

  it('keeps package metadata aligned with distribution and discovery vocabulary', () => {
    assert.match(packageJson.description ?? '', /workflow/i);
    assert.match(packageJson.description ?? '', /MCP/i);
    assert.deepStrictEqual(packageJson.files, ['dist', 'README.md']);
    assert.ok(packageJson.exports && '.' in packageJson.exports);
    assert.ok(Array.isArray(packageJson.keywords));
    assert.ok(packageJson.keywords?.includes('mcp'));
    assert.ok(packageJson.keywords?.includes('gemini'));
    assert.ok(packageJson.keywords?.includes('workflow'));
    assert.strictEqual(packageJson.license, 'MIT');
  });

  it('keeps the repository metadata explicit', () => {
    assert.deepStrictEqual(packageJson.repository, {
      type: 'git',
      url: 'git+https://github.com/j0hanz/gemini-assistant.git',
    });
  });
});
