import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Set dummy API key so client.ts doesn't exit
process.env.API_KEY ??= 'test-key-for-pr';

const {
  buildLocalDiffSnapshot,
  budgetDiffUnits,
  buildAnalysisPrompt,
  buildGitDiffArgs,
  buildUntrackedFilePatch,
  computeDiffStats,
  formatGitError,
  matchesNoisyPath,
  scoreDiffUnitRisk,
  splitDiffUnits,
} = await import('../../src/tools/pr.js');

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gemini-assistant-pr-'));
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.name', 'Test User']);
  runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
  return repoRoot;
}

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

  it('includes the full noisy path exclusion policy', () => {
    const args = buildGitDiffArgs(false);

    assert.ok(args.includes(':!package-lock.json'));
    assert.ok(args.includes(':!yarn.lock'));
    assert.ok(args.includes(':!pnpm-lock.yaml'));
    assert.ok(args.includes(':!bun.lockb'));
    assert.ok(args.includes(':!*.map'));
    assert.ok(args.includes(':!*.min.js'));
    assert.ok(args.includes(':!*.min.css'));
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

describe('splitDiffUnits', () => {
  it('splits a multi-file diff into whole-file units', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '+const a = 1;',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '-const b = 2;',
    ].join('\n');

    const units = splitDiffUnits(diff);

    assert.strictEqual(units.length, 2);
    assert.strictEqual(units[0]?.path, 'src/a.ts');
    assert.strictEqual(units[1]?.path, 'src/b.ts');
  });
});

describe('budgetDiffUnits', () => {
  it('returns original for short diffs', () => {
    const units = splitDiffUnits(
      ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '+ok'].join('\n'),
    );
    const result = budgetDiffUnits(units, 500_000);

    assert.strictEqual(result.truncated, false);
    assert.match(result.diff, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
    assert.deepStrictEqual(result.omittedPaths, []);
  });

  it('omits whole-file units once the budget is exceeded', () => {
    const diff = [
      'diff --git a/src/large.ts b/src/large.ts',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      ...Array.from({ length: 30 }, (_, i) => `+line ${String(i)}`),
      'diff --git a/src/small.ts b/src/small.ts',
      '--- a/src/small.ts',
      '+++ b/src/small.ts',
      '+tiny',
    ].join('\n');
    const result = budgetDiffUnits(splitDiffUnits(diff), 250);

    assert.strictEqual(result.truncated, true);
    assert.match(result.diff, /src\/large\.ts/);
    assert.doesNotMatch(result.diff, /src\/small\.ts/);
    assert.deepStrictEqual(result.omittedPaths, ['src/small.ts']);
  });

  it('prefers high-risk source files over larger low-signal assets', () => {
    const diff = [
      'diff --git a/public/banner.png b/public/banner.png',
      '--- a/public/banner.png',
      '+++ b/public/banner.png',
      '+one',
      '+two',
      '+three',
      '+four',
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '+token',
    ].join('\n');
    const result = budgetDiffUnits(splitDiffUnits(diff), 120);

    assert.match(result.diff, /src\/auth\/session\.ts/);
    assert.doesNotMatch(result.diff, /public\/banner\.png/);
    assert.deepStrictEqual(result.omittedPaths, ['public/banner.png']);
  });

  it('gives config and routing changes higher risk scores than tests', () => {
    const configUnit = splitDiffUnits(
      [
        'diff --git a/tsconfig.json b/tsconfig.json',
        '--- a/tsconfig.json',
        '+++ b/tsconfig.json',
        '+{}',
      ].join('\n'),
    )[0];
    const testUnit = splitDiffUnits(
      [
        'diff --git a/tests/app.test.ts b/tests/app.test.ts',
        '--- a/tests/app.test.ts',
        '+++ b/tests/app.test.ts',
        '+expect(true).toBe(true)',
      ].join('\n'),
    )[0];

    assert.ok(configUnit);
    assert.ok(testUnit);
    assert.ok(scoreDiffUnitRisk(configUnit) > scoreDiffUnitRisk(testUnit));
  });
});

describe('buildLocalDiffSnapshot', () => {
  it('captures staged, unstaged, untracked, binary, large, and noisy paths from a temp repo', async () => {
    const repoRoot = await createTempRepo();

    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(join(repoRoot, 'assets'), { recursive: true });
      await mkdir(join(repoRoot, 'dist'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'staged.ts'), 'export const staged = 1;\n');
      await writeFile(join(repoRoot, 'src', 'unstaged.ts'), 'export const unstaged = 1;\n');
      runGit(repoRoot, ['add', '.']);
      runGit(repoRoot, ['commit', '-m', 'initial']);

      await writeFile(join(repoRoot, 'src', 'staged.ts'), 'export const staged = 2;\n');
      runGit(repoRoot, ['add', 'src/staged.ts']);
      await writeFile(join(repoRoot, 'src', 'unstaged.ts'), 'export const unstaged = 2;\n');
      await writeFile(join(repoRoot, 'src', 'new-file.ts'), 'export const created = true;\n');
      await writeFile(join(repoRoot, 'assets', 'logo.png'), Buffer.from([0, 1, 2, 3]));
      await writeFile(join(repoRoot, 'fixtures-large.json'), 'x'.repeat(1_100_000));
      await writeFile(join(repoRoot, 'dist', 'bundle.min.js'), 'console.log("skip");\n');

      const snapshot = await buildLocalDiffSnapshot(repoRoot);

      assert.strictEqual(snapshot.empty, false);
      assert.ok(snapshot.reviewedPaths.includes('src/staged.ts'));
      assert.ok(snapshot.reviewedPaths.includes('src/unstaged.ts'));
      assert.ok(snapshot.reviewedPaths.includes('src/new-file.ts'));
      assert.ok(snapshot.includedUntracked.includes('src/new-file.ts'));
      assert.ok(snapshot.skippedBinaryPaths.includes('assets/logo.png'));
      assert.ok(snapshot.skippedLargePaths.includes('fixtures-large.json'));
      assert.ok(!snapshot.reviewedPaths.includes('dist/bundle.min.js'));
      assert.match(snapshot.diff, /src\/staged\.ts/);
      assert.match(snapshot.diff, /src\/unstaged\.ts/);
      assert.match(snapshot.diff, /src\/new-file\.ts/);
      assert.doesNotMatch(snapshot.diff, /bundle\.min\.js/);
      assert.ok(snapshot.stats.files >= 3);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('buildAnalysisPrompt', () => {
  const stats = { files: 2, additions: 10, deletions: 5 };
  const reviewedPaths = ['src/a.ts', 'src/b.ts'];

  it('builds prompt without language', () => {
    const prompt = buildAnalysisPrompt('diff content', stats, reviewedPaths, [], [], []);
    assert.ok(prompt.includes('## Snapshot'));
    assert.ok(prompt.includes('Files: 2 | +10 -5'));
    assert.ok(prompt.includes('Paths:'));
    assert.ok(prompt.includes('- src/a.ts'));
    assert.ok(prompt.includes('```diff'));
    assert.ok(prompt.includes('diff content'));
    assert.ok(!prompt.includes('Lang:'));
  });

  it('includes untracked and skipped binary metadata when provided', () => {
    const prompt = buildAnalysisPrompt(
      'diff content',
      stats,
      reviewedPaths,
      ['src/new-file.ts'],
      ['assets/logo.png'],
      ['fixtures/big.json'],
      ['src/omitted.ts'],
      'TypeScript',
    );
    assert.ok(prompt.includes('Lang: TypeScript'));
    assert.ok(prompt.includes('Untracked:'));
    assert.ok(prompt.includes('- src/new-file.ts'));
    assert.ok(prompt.includes('Skipped binary:'));
    assert.ok(prompt.includes('- assets/logo.png'));
    assert.ok(prompt.includes('Skipped large (> 1048576 bytes):'));
    assert.ok(prompt.includes('- fixtures/big.json'));
    assert.ok(prompt.includes('Omitted:'));
    assert.ok(prompt.includes('- src/omitted.ts'));
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
