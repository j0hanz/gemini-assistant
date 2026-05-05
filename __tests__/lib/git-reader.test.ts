import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixtureGitReader } from '../../src/lib/git-reader.js';

describe('FixtureGitReader', () => {
  it('returns raw diff from fixture', async () => {
    const reader = new FixtureGitReader({ diffRaw: 'diff --git a/foo.ts b/foo.ts\n+added line' });
    const result = await reader.diff({ base: 'HEAD~1', head: 'HEAD' });
    assert.equal(result.raw, 'diff --git a/foo.ts b/foo.ts\n+added line');
  });

  it('returns empty diff when not configured', async () => {
    const reader = new FixtureGitReader({});
    const result = await reader.diff({ base: 'HEAD~1', head: 'HEAD' });
    assert.equal(result.raw, '');
  });

  it('reports available when configured', async () => {
    const reader = new FixtureGitReader({ available: true });
    assert.equal(await reader.isAvailable(), true);
  });

  it('reports unavailable by default', async () => {
    const reader = new FixtureGitReader({});
    assert.equal(await reader.isAvailable(), false);
  });

  it('returns status from fixture', async () => {
    const reader = new FixtureGitReader({ statusRaw: 'M  src/foo.ts' });
    const result = await reader.status();
    assert.equal(result.raw, 'M  src/foo.ts');
  });
});
