import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Set dummy API key so client.ts doesn't exit
process.env.API_KEY ??= 'test-key-for-pr';

const { computeDiffStats, buildGitDiffArgs, truncateDiff, buildAnalysisPrompt, formatGitError } =
  await import('../../src/tools/pr.js');

// ── computeDiffStats ──────────────────────────────────────────────────

describe('computeDiffStats', () => {
  it('returns zeros for an empty string', () => {
    const stats = computeDiffStats('');
    assert.deepStrictEqual(stats, { files: 0, additions: 0, deletions: 0 });
  });

  it('counts a single-file diff', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index abc..def 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
    ].join('\n');
    const stats = computeDiffStats(diff);
    assert.deepStrictEqual(stats, { files: 1, additions: 2, deletions: 1 });
  });

  it('counts multiple files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '+line',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '-removed',
    ].join('\n');
    const stats = computeDiffStats(diff);
    assert.deepStrictEqual(stats, { files: 2, additions: 1, deletions: 1 });
  });

  it('ignores +++ and --- header lines', () => {
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x'].join('\n');
    const stats = computeDiffStats(diff);
    assert.deepStrictEqual(stats, { files: 1, additions: 0, deletions: 0 });
  });
});

// ── buildGitDiffArgs ──────────────────────────────────────────────────

describe('buildGitDiffArgs', () => {
  it('builds unstaged args with default exclusions', () => {
    const args = buildGitDiffArgs('unstaged');
    assert.ok(args.includes('diff'));
    assert.ok(args.includes('--no-color'));
    assert.ok(!args.includes('--cached'));
    assert.ok(args.includes('--'));
    assert.ok(args.includes(':!package-lock.json'));
  });

  it('builds staged args with --cached', () => {
    const args = buildGitDiffArgs('staged');
    assert.ok(args.includes('--cached'));
  });

  it('includes base ref when provided', () => {
    const args = buildGitDiffArgs('unstaged', 'origin/main');
    const dashDashIdx = args.indexOf('--');
    const baseIdx = args.indexOf('origin/main');
    assert.ok(baseIdx !== -1, 'base ref should be in args');
    assert.ok(baseIdx < dashDashIdx, 'base ref should appear before --');
  });

  it('uses user paths instead of default exclusions', () => {
    const args = buildGitDiffArgs('unstaged', undefined, ['src/', 'lib/']);
    assert.ok(args.includes('src/'));
    assert.ok(args.includes('lib/'));
    assert.ok(!args.includes(':!package-lock.json'));
  });

  it('uses default exclusions when paths is empty', () => {
    const args = buildGitDiffArgs('unstaged', undefined, []);
    assert.ok(args.includes(':!package-lock.json'));
  });
});

// ── truncateDiff ──────────────────────────────────────────────────────

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

// ── buildAnalysisPrompt ───────────────────────────────────────────────

describe('buildAnalysisPrompt', () => {
  const stats = { files: 2, additions: 10, deletions: 5 };

  it('builds prompt without language', () => {
    const prompt = buildAnalysisPrompt('diff content', 'unstaged', stats);
    assert.ok(prompt.includes('## Git Diff (unstaged)'));
    assert.ok(prompt.includes('Files: 2 | +10 -5'));
    assert.ok(prompt.includes('```diff'));
    assert.ok(prompt.includes('diff content'));
    assert.ok(!prompt.includes('Language:'));
  });

  it('includes language when provided', () => {
    const prompt = buildAnalysisPrompt('diff content', 'staged', stats, 'TypeScript');
    assert.ok(prompt.includes('## Git Diff (staged)'));
    assert.ok(prompt.includes('Language: TypeScript'));
  });
});

// ── formatGitError ────────────────────────────────────────────────────

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

  it('handles undefined', () => {
    const msg = formatGitError(undefined);
    assert.ok(msg.includes('Failed to run git: undefined'));
  });

  it('handles null', () => {
    const msg = formatGitError(null);
    assert.ok(msg.includes('Failed to run git: null'));
  });
});
