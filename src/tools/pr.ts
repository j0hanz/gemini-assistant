import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { reportCompletion, sendProgress } from '../lib/errors.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { type AnalyzePrInput, AnalyzePrInputSchema } from '../schemas/inputs.js';
import { AnalyzePrOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const execFileAsync = promisify(execFile);

const TOOL_LABEL = 'Analyze PR';
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_DIFF_CHARS = 500_000;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const EMPTY_DIFF_STATS: DiffStats = { files: 0, additions: 0, deletions: 0 };
const UTF8_DECODER = new TextDecoder('utf-8');

const NOISY_EXCLUDE_PATHSPECS = [
  ':!package-lock.json',
  ':!yarn.lock',
  ':!pnpm-lock.yaml',
  ':!bun.lockb',
  ':!*.map',
  ':!*.min.js',
  ':!*.min.css',
];

const SYSTEM_INSTRUCTION =
  'Senior code reviewer. Input: unified git diff.\n\n' +
  'Produce a structured PR review in Markdown.\n\n' +
  '## Summary\n2-3 sentences: what changed and why.\n' +
  '## Impact\nAffected modules, APIs, and downstream dependencies.\n' +
  '## Risks\nBugs, regressions, security issues, edge cases. Flag severity (low/medium/high).\n' +
  '## Suggestions\nActionable fixes. Reference file paths and line ranges from the diff.\n\n' +
  'Constraints:\n' +
  '- Only analyze code logic and behavior changes. Ignore formatting and whitespace.\n' +
  '- Cite specific files and hunks. Never invent content not in the diff.\n' +
  '- If the diff is clean, say so briefly — do not pad the review.';

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

interface LocalDiffSnapshot {
  diff: string;
  stats: DiffStats;
  reviewedPaths: string[];
  includedUntracked: string[];
  skippedBinaryPaths: string[];
  skippedLargePaths: string[];
  empty: boolean;
}

interface UntrackedPatchResult {
  patch?: string;
  path: string;
  skipReason?: 'binary' | 'too_large';
}

type AnalyzePrStructuredContent = Record<string, unknown> & {
  analysis: string;
  stats: DiffStats;
  reviewedPaths: string[];
  includedUntracked: string[];
  skippedBinaryPaths: string[];
  skippedLargePaths: string[];
  empty: boolean;
  truncated?: boolean;
};

export function matchesNoisyPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = normalized.split('/').pop()?.toLowerCase() ?? '';
  return (
    basename === 'package-lock.json' ||
    basename === 'yarn.lock' ||
    basename === 'pnpm-lock.yaml' ||
    basename === 'bun.lockb' ||
    basename.endsWith('.map') ||
    basename.endsWith('.min.js') ||
    basename.endsWith('.min.css')
  );
}

export function computeDiffStats(diff: string): DiffStats {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/.exec(line);
      files.add(match ? (match[3] ?? match[4] ?? line) : line);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { files: files.size, additions, deletions };
}

export function buildGitDiffArgs(staged: boolean): string[] {
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--cached');
  args.push('--', ...NOISY_EXCLUDE_PATHSPECS);
  return args;
}

function buildGitHeadDiffArgs(): string[] {
  return ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', ...NOISY_EXCLUDE_PATHSPECS];
}

function buildGitNameOnlyArgs(staged: boolean): string[] {
  const args = ['diff', '--name-only'];
  if (staged) args.push('--cached');
  args.push('--', ...NOISY_EXCLUDE_PATHSPECS);
  return args;
}

function buildGitHeadNameOnlyArgs(): string[] {
  return ['diff', '--name-only', 'HEAD', '--', ...NOISY_EXCLUDE_PATHSPECS];
}

function parseGitPathList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !matchesNoisyPath(line));
}

function joinNonEmptyParts(parts: string[]): string {
  return parts.filter((part) => part.trim()).join('\n');
}

async function findGitRoot(signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return stdout.trim();
}

async function runGit(gitRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: gitRoot,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

async function hasHeadCommit(gitRoot: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(gitRoot, ['rev-parse', '--verify', 'HEAD'], signal);
    return true;
  } catch {
    return false;
  }
}

async function generateFallbackTrackedDiff(gitRoot: string, signal?: AbortSignal): Promise<string> {
  const [stagedDiff, unstagedDiff] = await Promise.all([
    runGit(gitRoot, buildGitDiffArgs(true), signal),
    runGit(gitRoot, buildGitDiffArgs(false), signal),
  ]);

  return joinNonEmptyParts([stagedDiff, unstagedDiff]);
}

async function listFallbackTrackedPaths(gitRoot: string, signal?: AbortSignal): Promise<string[]> {
  const [stagedPaths, unstagedPaths] = await Promise.all([
    runGit(gitRoot, buildGitNameOnlyArgs(true), signal),
    runGit(gitRoot, buildGitNameOnlyArgs(false), signal),
  ]);

  return [...parseGitPathList(stagedPaths), ...parseGitPathList(unstagedPaths)];
}

async function buildTrackedSnapshot(
  gitRoot: string,
  signal?: AbortSignal,
): Promise<{ diff: string; paths: string[] }> {
  if (await hasHeadCommit(gitRoot, signal)) {
    const [diff, paths] = await Promise.all([
      runGit(gitRoot, buildGitHeadDiffArgs(), signal),
      runGit(gitRoot, buildGitHeadNameOnlyArgs(), signal),
    ]);
    return {
      diff,
      paths: parseGitPathList(paths),
    };
  }

  const [diff, paths] = await Promise.all([
    generateFallbackTrackedDiff(gitRoot, signal),
    listFallbackTrackedPaths(gitRoot, signal),
  ]);
  return { diff, paths };
}

async function listUntrackedPaths(gitRoot: string, signal?: AbortSignal): Promise<string[]> {
  const stdout = await runGit(gitRoot, ['ls-files', '--others', '--exclude-standard'], signal);
  return parseGitPathList(stdout);
}

function isBinaryContent(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

export function buildUntrackedFilePatch(
  filePath: string,
  content: string,
  executable = false,
): string {
  const normalizedContent = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const hasTrailingNewline = normalizedContent.endsWith('\n');
  const body = hasTrailingNewline ? normalizedContent.slice(0, -1) : normalizedContent;
  const lines = normalizedContent === '' ? [] : body.split('\n');
  const patchLines = [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode ${executable ? '100755' : '100644'}`,
    '--- /dev/null',
    `+++ b/${filePath}`,
  ];

  if (lines.length === 0) {
    return patchLines.join('\n');
  }

  patchLines.push(`@@ -0,0 +1,${String(lines.length)} @@`);
  patchLines.push(...lines.map((line) => `+${line}`));
  if (!hasTrailingNewline) {
    patchLines.push('\\ No newline at end of file');
  }

  return patchLines.join('\n');
}

async function buildUntrackedPatch(
  gitRoot: string,
  relativePath: string,
): Promise<UntrackedPatchResult> {
  const absolutePath = join(gitRoot, relativePath);
  const fileStats = await stat(absolutePath).catch(() => null);

  if (!fileStats?.isFile()) {
    return { path: relativePath };
  }

  if (fileStats.size > MAX_UNTRACKED_FILE_BYTES) {
    return { path: relativePath, skipReason: 'too_large' };
  }

  const fileBuffer = await readFile(absolutePath);
  if (isBinaryContent(fileBuffer)) {
    return { path: relativePath, skipReason: 'binary' };
  }

  const fileContent = UTF8_DECODER.decode(fileBuffer);
  return {
    path: relativePath,
    patch: buildUntrackedFilePatch(relativePath, fileContent, (fileStats.mode & 0o111) !== 0),
  };
}

export function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return {
    diff: `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[... diff truncated due to size ...]`,
    truncated: true,
  };
}

export function formatGitError(err: unknown): string {
  if (!(err instanceof Error)) {
    return `Failed to run git: ${String(err)}. Ensure git is installed.`;
  }
  const gitErr = err as Error & { code?: number | string; stderr?: string };
  if (typeof gitErr.code === 'number') {
    const stderr = gitErr.stderr?.trim() ?? 'unknown error';
    return `git exited with code ${String(gitErr.code)}: ${stderr}`;
  }
  return `Failed to run git: ${gitErr.message}. Ensure git is installed.`;
}

function formatAnalyzePrError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const nodeErr = err as Error & { code?: number | string; stderr?: string; syscall?: string };
  if (typeof nodeErr.code === 'number' || nodeErr.stderr || nodeErr.syscall === 'spawn git') {
    return formatGitError(err);
  }
  return nodeErr.message;
}

export function buildAnalysisPrompt(
  diff: string,
  stats: DiffStats,
  reviewedPaths: string[],
  includedUntracked: string[],
  skippedBinaryPaths: string[],
  skippedLargePaths: string[],
  language?: string,
): string {
  const parts = [
    '## Local Diff Snapshot',
    `Files: ${String(stats.files)} | +${String(stats.additions)} -${String(stats.deletions)}`,
    ...(language ? [`Language: ${language}`] : []),
    '',
    'Reviewed Paths:',
    ...reviewedPaths.map((filePath) => `- ${filePath}`),
    ...(includedUntracked.length > 0
      ? [
          '',
          'Included Untracked Text Files:',
          ...includedUntracked.map((filePath) => `- ${filePath}`),
        ]
      : []),
    ...(skippedBinaryPaths.length > 0
      ? [
          '',
          'Skipped Binary Untracked Files:',
          ...skippedBinaryPaths.map((filePath) => `- ${filePath}`),
        ]
      : []),
    ...(skippedLargePaths.length > 0
      ? [
          '',
          `Skipped Large Untracked Files (> ${String(MAX_UNTRACKED_FILE_BYTES)} bytes):`,
          ...skippedLargePaths.map((filePath) => `- ${filePath}`),
        ]
      : []),
    '',
    '```diff',
    diff,
    '```',
  ];
  return parts.join('\n');
}

function summarizeUntrackedResults(untrackedResults: UntrackedPatchResult[]): {
  includedUntracked: string[];
  skippedBinaryPaths: string[];
  skippedLargePaths: string[];
  untrackedPatches: string[];
} {
  const includedUntracked: string[] = [];
  const skippedBinaryPaths: string[] = [];
  const skippedLargePaths: string[] = [];
  const untrackedPatches: string[] = [];

  for (const result of untrackedResults) {
    if (result.skipReason === 'binary') {
      skippedBinaryPaths.push(result.path);
      continue;
    }
    if (result.skipReason === 'too_large') {
      skippedLargePaths.push(result.path);
      continue;
    }
    if (!result.patch?.trim()) {
      continue;
    }
    includedUntracked.push(result.path);
    untrackedPatches.push(result.patch);
  }

  includedUntracked.sort();
  skippedBinaryPaths.sort();
  skippedLargePaths.sort();

  return { includedUntracked, skippedBinaryPaths, skippedLargePaths, untrackedPatches };
}

function buildStructuredContent(
  snapshot: LocalDiffSnapshot,
  analysis: string,
  truncated?: boolean,
): AnalyzePrStructuredContent {
  return {
    analysis,
    stats: snapshot.stats,
    reviewedPaths: snapshot.reviewedPaths,
    includedUntracked: snapshot.includedUntracked,
    skippedBinaryPaths: snapshot.skippedBinaryPaths,
    skippedLargePaths: snapshot.skippedLargePaths,
    empty: snapshot.empty,
    ...(truncated ? { truncated } : {}),
  };
}

function buildNoChangesAnalysis(snapshot: LocalDiffSnapshot): string {
  const skippedNotes: string[] = [];

  if (snapshot.skippedBinaryPaths.length > 0) {
    skippedNotes.push(`binary untracked files: ${snapshot.skippedBinaryPaths.join(', ')}`);
  }

  if (snapshot.skippedLargePaths.length > 0) {
    skippedNotes.push(
      `large untracked files over ${String(MAX_UNTRACKED_FILE_BYTES)} bytes: ${snapshot.skippedLargePaths.join(', ')}`,
    );
  }

  return skippedNotes.length > 0
    ? `No reviewable local text changes to review. Skipped ${skippedNotes.join('; ')}.`
    : 'No local changes to review.';
}

function formatSnapshotSummary(stats: DiffStats): string {
  return `${String(stats.files)} files (+${String(stats.additions)}, -${String(stats.deletions)})`;
}

function buildModelPrompt(
  prompt: string,
  cacheName?: string,
): {
  effectivePrompt: string;
  effectiveSystemInstruction: string | undefined;
} {
  if (cacheName) {
    return {
      effectivePrompt: `${SYSTEM_INSTRUCTION}\n\n${prompt}`,
      effectiveSystemInstruction: undefined,
    };
  }

  return {
    effectivePrompt: prompt,
    effectiveSystemInstruction: SYSTEM_INSTRUCTION,
  };
}

async function buildLocalDiffSnapshot(signal?: AbortSignal): Promise<LocalDiffSnapshot> {
  const gitRoot = await findGitRoot(signal);
  const [trackedSnapshot, untrackedPaths] = await Promise.all([
    buildTrackedSnapshot(gitRoot, signal),
    listUntrackedPaths(gitRoot, signal),
  ]);

  const untrackedResults: UntrackedPatchResult[] = [];
  for (const relativePath of untrackedPaths) {
    untrackedResults.push(await buildUntrackedPatch(gitRoot, relativePath));
  }

  const { includedUntracked, skippedBinaryPaths, skippedLargePaths, untrackedPatches } =
    summarizeUntrackedResults(untrackedResults);

  const reviewedPaths = [...new Set([...trackedSnapshot.paths, ...includedUntracked])].sort();
  const diff = joinNonEmptyParts([trackedSnapshot.diff, ...untrackedPatches]);
  const empty = !diff.trim();

  return {
    diff,
    stats: empty ? EMPTY_DIFF_STATS : computeDiffStats(diff),
    reviewedPaths,
    includedUntracked,
    skippedBinaryPaths,
    skippedLargePaths,
    empty,
  };
}

async function analyzePrWork(
  { thinkingLevel, language, dryRun, cacheName }: AnalyzePrInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  await sendProgress(ctx, 0, 3, `${TOOL_LABEL}: Inspecting local changes`);

  let snapshot: LocalDiffSnapshot;
  try {
    snapshot = await buildLocalDiffSnapshot(ctx.mcpReq.signal);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${TOOL_LABEL}: ${formatAnalyzePrError(err)}` }],
      isError: true,
    };
  }

  const snapshotSummary = formatSnapshotSummary(snapshot.stats);
  await sendProgress(ctx, 1, 3, `${TOOL_LABEL}: ${snapshotSummary}`);

  if (snapshot.empty) {
    const analysis = buildNoChangesAnalysis(snapshot);
    await reportCompletion(ctx, TOOL_LABEL, 'no changes');
    return {
      content: [{ type: 'text' as const, text: analysis }],
      structuredContent: buildStructuredContent(snapshot, analysis),
    };
  }

  const { diff, truncated } = truncateDiff(snapshot.diff);

  if (dryRun) {
    await reportCompletion(ctx, TOOL_LABEL, 'snapshot ready');
    return {
      content: [{ type: 'text' as const, text: diff }],
      structuredContent: buildStructuredContent(snapshot, diff, truncated),
    };
  }

  await sendProgress(ctx, 2, 3, `${TOOL_LABEL}: Analyzing generated diff`);
  await ctx.mcpReq.log(
    'info',
    `analyze_pr: ${String(snapshot.stats.files)} files, +${String(snapshot.stats.additions)}/-${String(snapshot.stats.deletions)}${truncated ? ' (truncated)' : ''}`,
  );

  const prompt = buildAnalysisPrompt(
    diff,
    snapshot.stats,
    snapshot.reviewedPaths,
    snapshot.includedUntracked,
    snapshot.skippedBinaryPaths,
    snapshot.skippedLargePaths,
    language,
  );

  const { effectivePrompt, effectiveSystemInstruction } = buildModelPrompt(prompt, cacheName);

  return await handleToolExecution(
    ctx,
    'analyze_pr',
    TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: effectivePrompt,
        config: buildGenerateContentConfig(
          {
            systemInstruction: effectiveSystemInstruction,
            thinkingLevel: thinkingLevel ?? 'HIGH',
            cacheName,
          },
          ctx.mcpReq.signal,
        ),
      }),
    (_streamResult, textContent) => ({
      structuredContent: buildStructuredContent(snapshot, textContent || '', truncated),
      reportMessage: `${String(snapshot.stats.files)} files reviewed (+${String(snapshot.stats.additions)}, -${String(snapshot.stats.deletions)})`,
    }),
  );
}

export function registerAnalyzePrTool(server: McpServer): void {
  registerTaskTool(
    server,
    'analyze_pr',
    {
      title: TOOL_LABEL,
      description:
        'Inspect the current local git repository, auto-generate a diff of all local changes, ' +
        'and review that generated diff with Gemini. Use dryRun to preview the generated diff ' +
        'without AI analysis. Use cacheName to provide project context during review.',
      inputSchema: AnalyzePrInputSchema,
      outputSchema: AnalyzePrOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    analyzePrWork,
  );
}
