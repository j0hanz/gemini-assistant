import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixtureGitReader } from '../../src/lib/git-reader.js';

describe('Review tool with FixtureGitReader', () => {
  it('returns diff from fixture git reader', async () => {
    const diffOutput =
      'diff --git a/file.ts b/file.ts\nindex 1234567..abcdefg 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n line 1\n-old line\n+new line';
    const reader = new FixtureGitReader({
      diffRaw: diffOutput,
      execOutput: {
        'diff --name-only HEAD': 'file.ts\n',
      },
    });

    const diffResult = await reader.diff({ base: 'HEAD' });
    assert.equal(diffResult.raw, diffOutput);
  });

  it('detects when git is available', async () => {
    const reader = new FixtureGitReader({ available: true });
    assert.equal(await reader.isAvailable(), true);
  });

  it('detects when git is unavailable', async () => {
    const reader = new FixtureGitReader({ available: false });
    assert.equal(await reader.isAvailable(), false);
  });

  it('returns staged changes via exec', async () => {
    const stagedDiff =
      'diff --git a/staged.ts b/staged.ts\nindex 1234567..abcdefg 100644\n--- a/staged.ts\n+++ b/staged.ts\n@@ -1 +1,2 @@\n line 1\n+added line';
    const reader = new FixtureGitReader({
      execOutput: {
        'diff --cached HEAD': stagedDiff,
      },
    });

    const output = await reader.exec(['diff', '--cached', 'HEAD']);
    assert.equal(output, stagedDiff);
  });

  it('returns untracked file status', async () => {
    const statusOutput = '?? untracked.ts\n?? another-untracked.js\n';
    const reader = new FixtureGitReader({
      statusRaw: statusOutput,
    });

    const status = await reader.status();
    assert.equal(status.raw, statusOutput);
  });

  it('handles multiple arbitrary git commands', async () => {
    const reader = new FixtureGitReader({
      execOutput: {
        'rev-parse --show-toplevel': '/home/user/project\n',
        'ls-files --others --exclude-standard': 'untracked1.ts\nuntracked2.js\n',
        'rev-parse HEAD': 'abc123def456\n',
      },
    });

    assert.equal(await reader.exec(['rev-parse', '--show-toplevel']), '/home/user/project\n');
    assert.equal(
      await reader.exec(['ls-files', '--others', '--exclude-standard']),
      'untracked1.ts\nuntracked2.js\n',
    );
    assert.equal(await reader.exec(['rev-parse', 'HEAD']), 'abc123def456\n');
  });

  it('returns empty string for unconfigured git commands', async () => {
    const reader = new FixtureGitReader({
      execOutput: {
        'some-command': 'output',
      },
    });

    const output = await reader.exec(['other-command']);
    assert.equal(output, '');
  });

  it('returns empty diff when not configured', async () => {
    const reader = new FixtureGitReader({});
    const diff = await reader.diff({ base: 'HEAD' });
    assert.equal(diff.raw, '');
  });

  it('returns empty status when not configured', async () => {
    const reader = new FixtureGitReader({});
    const status = await reader.status();
    assert.equal(status.raw, '');
  });

  it('returns empty string from show() when not configured', async () => {
    const reader = new FixtureGitReader({});
    const output = await reader.show('HEAD:file.ts');
    assert.equal(output, '');
  });
});
