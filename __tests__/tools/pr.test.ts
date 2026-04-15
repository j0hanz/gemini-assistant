import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Set dummy API key so client.ts doesn't exit
process.env.API_KEY ??= 'test-key-for-pr';

const {
  buildAnalysisPrompt,
  buildGitDiffArgs,
  buildUntrackedFilePatch,
  computeDiffStats,
  formatGitError,
  matchesNoisyPath,
  truncateDiff,
} = await import('../../src/tools/pr.js');

describe('computeDiffStats', () => {
  it('returns zeros for an empty string', () => {
    const stats = computeDiffStats('');
    assert.deepStrictEqual(stats, { files: 0, additions: 0, deletions: 0 });
  });

  it('counts unique files across repeated diff headers', () => {
    const diff = [
      'diff --git "a/src/index file.ts" "b/src/index file.ts"',
      '--- "a/src/index file.ts"',
      '+++ "b/src/index file.ts"',
      '+const a = 1;',
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '-const b = 2;',
    ].join('\n');

    const stats = computeDiffStats(diff);
    assert.deepStrictEqual(stats, { files: 2, additions: 1, deletions: 1 });
  });

  it('counts synthetic untracked file patches', () => {
    const diff = buildUntrackedFilePatch('src/new-file.ts', 'const answer = 42;\n');
    const stats = computeDiffStats(diff);
    assert.deepStrictEqual(stats, { files: 1, additions: 1, deletions: 0 });
  });

  it('ignores +++ and --- header lines', () => {
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x'].join('\n');
    const stats = computeDiffStats(diff);
    assert.deepStrictEqual(stats, { files: 1, additions: 0, deletions: 0 });
  });
});

describe('matchesNoisyPath', () => {
  it('matches excluded lockfiles and minified assets', () => {
    assert.strictEqual(matchesNoisyPath('package-lock.json'), true);
    assert.strictEqual(matchesNoisyPath('nested/yarn.lock'), true);
    assert.strictEqual(matchesNoisyPath('foo/bar/app.min.js'), true);
    assert.strictEqual(matchesNoisyPath('foo/bar/styles.min.css'), true);
  });

  it('keeps normal source files', () => {
    assert.strictEqual(matchesNoisyPath('src/index.ts'), false);
    assert.strictEqual(matchesNoisyPath('README.md'), false);
  });
});

describe('buildGitDiffArgs', () => {
  it('builds tracked diff args with default exclusions', () => {
    const args = buildGitDiffArgs(false);
    assert.ok(args.includes('diff'));
    assert.ok(args.includes('--no-color'));
    assert.ok(!args.includes('--cached'));
    assert.ok(args.includes('--'));
    assert.ok(args.includes(':!package-lock.json'));
  });

  it('builds staged tracked diff args', () => {
    const args = buildGitDiffArgs(true);
    assert.ok(args.includes('--cached'));
  });
});

describe('buildUntrackedFilePatch', () => {
  it('creates a new file patch for text content', () => {
    const patch = buildUntrackedFilePatch('src/new-file.ts', 'const a = 1;\nconst b = 2;\n');
    assert.ok(patch.includes('diff --git a/src/new-file.ts b/src/new-file.ts'));
    assert.ok(patch.includes('new file mode 100644'));
    assert.ok(patch.includes('@@ -0,0 +1,2 @@'));
    assert.ok(patch.includes('+const a = 1;'));
    assert.ok(patch.includes('+const b = 2;'));
  });

  it('marks executable files correctly', () => {
    const patch = buildUntrackedFilePatch('scripts/run.sh', '#!/bin/sh\necho ok\n', true);
    assert.ok(patch.includes('new file mode 100755'));
  });

  it('handles files without a trailing newline', () => {
    const patch = buildUntrackedFilePatch('README.md', 'hello');
    assert.ok(patch.includes('\\ No newline at end of file'));
  });
});

describe('truncateDiff', () => {
  it('returns original for short diffs', () => {
    const result = truncateDiff('short diff');
    assert.strictEqual(result.diff, 'short diff');
    assert.strictEqual(result.truncated, false);
  });

  it('truncates diffs exceeding 500k chars', () => {
    const longDiff = 'x'.repeat(600_000);
    const result = truncateDiff(longDiff);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.diff.length < longDiff.length);
    assert.ok(result.diff.includes('[... diff truncated due to size ...]'));
  });

  it('does not truncate at exactly 500k chars', () => {
    const exactDiff = 'x'.repeat(500_000);
    const result = truncateDiff(exactDiff);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.diff, exactDiff);
  });
});

describe('buildAnalysisPrompt', () => {
  const stats = { files: 2, additions: 10, deletions: 5 };
  const reviewedPaths = ['src/a.ts', 'src/b.ts'];

  it('builds prompt without language', () => {
    const prompt = buildAnalysisPrompt('diff content', stats, reviewedPaths, [], [], []);
    assert.ok(prompt.includes('## Local Diff Snapshot'));
    assert.ok(prompt.includes('Files: 2 | +10 -5'));
    assert.ok(prompt.includes('Reviewed Paths:'));
    assert.ok(prompt.includes('- src/a.ts'));
    assert.ok(prompt.includes('```diff'));
    assert.ok(prompt.includes('diff content'));
    assert.ok(!prompt.includes('Language:'));
  });

  it('includes untracked and skipped binary metadata when provided', () => {
    const prompt = buildAnalysisPrompt(
      'diff content',
      stats,
      reviewedPaths,
      ['src/new-file.ts'],
      ['assets/logo.png'],
      ['fixtures/big.json'],
      'TypeScript',
    );
    assert.ok(prompt.includes('Language: TypeScript'));
    assert.ok(prompt.includes('Included Untracked Text Files:'));
    assert.ok(prompt.includes('- src/new-file.ts'));
    assert.ok(prompt.includes('Skipped Binary Untracked Files:'));
    assert.ok(prompt.includes('- assets/logo.png'));
    assert.ok(prompt.includes('Skipped Large Untracked Files (> 1048576 bytes):'));
    assert.ok(prompt.includes('- fixtures/big.json'));
  });
});

describe('formatGitError', () => {
  it('handles Error with numeric code and stderr', () => {
    const err = Object.assign(new Error('fail'), { code: 128, stderr: 'not a git repo\n' });
    const msg = formatGitError(err);
    assert.ok(msg.includes('git exited with code 128'));
    assert.ok(msg.includes('not a git repo'));
  });

  it('handles Error without code', () => {
    const msg = formatGitError(new Error('ENOENT'));
    assert.ok(msg.includes('Failed to run git: ENOENT'));
    assert.ok(msg.includes('Ensure git is installed'));
  });

  it('handles non-Error values', () => {
    const msg = formatGitError('something broke');
    assert.ok(msg.includes('Failed to run git: something broke'));
  });
});
