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
const DIFF_HEADER_PATTERN = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/;
const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

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
  'Review the unified diff for bugs, regressions, and behavior risk. Ignore formatting-only changes. ' +
  'Cite file paths and hunk context from the diff. Do not invent content or line numbers. ' +
  'If clean, say so briefly.\n\n' +
  'Output:\n' +
  '## Findings\n' +
  'List issues by severity with file references.\n' +
  '## Fixes\n' +
  'Short next steps.';

interface DiffStats {
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
  omittedPaths?: string[];
  empty: boolean;
  truncated?: boolean;
};

interface DiffUnit {
  additions: number;
  deletions: number;
  path: string;
  text: string;
}

interface BudgetedSnapshotDiff {
  diff: string;
  omittedPaths: string[];
  summary: string;
  truncated: boolean;
}

interface GitDiffArgsOptions {
  againstHead?: boolean;
  nameOnly?: boolean;
  staged?: boolean;
}

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

function isAdditionLine(line: string): boolean {
  return line.startsWith('+') && !line.startsWith('+++');
}

function isDeletionLine(line: string): boolean {
  return line.startsWith('-') && !line.startsWith('---');
}

function parseDiffPath(diffHeader: string): string {
  const match = DIFF_HEADER_PATTERN.exec(diffHeader);
  return match ? (match[3] ?? match[4] ?? diffHeader) : diffHeader;
}

export function computeDiffStats(diff: string): DiffStats {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files.add(parseDiffPath(line));
      continue;
    }
    if (isAdditionLine(line)) {
      additions++;
      continue;
    }
    if (isDeletionLine(line)) {
      deletions++;
    }
  }

  return { files: files.size, additions, deletions };
}

function buildGitArgs({
  againstHead = false,
  nameOnly = false,
  staged = false,
}: GitDiffArgsOptions): string[] {
  return [
    'diff',
    ...(nameOnly ? ['--name-only'] : ['--no-color', '--no-ext-diff']),
    ...(staged ? ['--cached'] : []),
    ...(againstHead ? ['HEAD'] : []),
    '--',
    ...NOISY_EXCLUDE_PATHSPECS,
  ];
}

export function buildGitDiffArgs(staged: boolean): string[] {
  return buildGitArgs({ staged });
}

function buildGitNameOnlyArgs(staged: boolean): string[] {
  return buildGitArgs({ nameOnly: true, staged });
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

function uniqueSortedPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
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
      runGit(gitRoot, buildGitArgs({ againstHead: true }), signal),
      runGit(gitRoot, buildGitArgs({ againstHead: true, nameOnly: true }), signal),
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

async function collectUntrackedResults(
  gitRoot: string,
  untrackedPaths: string[],
): Promise<UntrackedPatchResult[]> {
  const results: UntrackedPatchResult[] = [];

  for (const relativePath of untrackedPaths) {
    results.push(await buildUntrackedPatch(gitRoot, relativePath));
  }

  return results;
}

function isBinaryContent(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  try {
    UTF8_FATAL_DECODER.decode(buffer);
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

function computeUnitStats(text: string): Pick<DiffUnit, 'additions' | 'deletions'> {
  let additions = 0;
  let deletions = 0;

  for (const line of text.split('\n')) {
    if (isAdditionLine(line)) additions++;
    if (isDeletionLine(line)) deletions++;
  }

  return { additions, deletions };
}

export function splitDiffUnits(diff: string): DiffUnit[] {
  if (!diff.trim()) return [];

  return diff
    .split(/(?=^diff --git )/m)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((text) => {
      const header = text.split('\n', 1)[0] ?? text;
      return {
        path: parseDiffPath(header),
        text,
        ...computeUnitStats(text),
      };
    });
}

export function budgetDiffUnits(
  units: DiffUnit[],
  maxChars = MAX_DIFF_CHARS,
): { diff: string; omittedPaths: string[]; truncated: boolean } {
  const orderedUnits = [...units].sort((a, b) => {
    const scoreDelta = b.additions + b.deletions - (a.additions + a.deletions);
    return scoreDelta !== 0 ? scoreDelta : a.path.localeCompare(b.path);
  });

  const keptUnits: DiffUnit[] = [];
  const omittedPaths: string[] = [];
  let currentLength = 0;

  for (const unit of orderedUnits) {
    const separatorLength = keptUnits.length > 0 ? 1 : 0;
    const nextLength = currentLength + separatorLength + unit.text.length;

    if (keptUnits.length > 0 && nextLength > maxChars) {
      omittedPaths.push(unit.path);
      continue;
    }

    keptUnits.push(unit);
    currentLength = nextLength;
  }

  return {
    diff: keptUnits.map((unit) => unit.text).join('\n'),
    ...(omittedPaths.length > 0 ? { omittedPaths: omittedPaths.sort() } : { omittedPaths: [] }),
    truncated: omittedPaths.length > 0,
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

function appendPromptSection(parts: string[], title: string, entries: string[]): void {
  if (entries.length === 0) return;
  parts.push('', title, ...entries.map((entry) => `- ${entry}`));
}

export function buildAnalysisPrompt(
  diff: string,
  stats: DiffStats,
  reviewedPaths: string[],
  includedUntracked: string[],
  skippedBinaryPaths: string[],
  skippedLargePaths: string[],
  omittedPaths: string[] = [],
  language?: string,
): string {
  const parts = [
    '## Snapshot',
    `Files: ${String(stats.files)} | +${String(stats.additions)} -${String(stats.deletions)}`,
    ...(language ? [`Lang: ${language}`] : []),
    '',
    'Paths:',
    ...reviewedPaths.map((filePath) => `- ${filePath}`),
  ];

  appendPromptSection(parts, 'Untracked:', includedUntracked);
  appendPromptSection(parts, 'Skipped binary:', skippedBinaryPaths);
  appendPromptSection(
    parts,
    `Skipped large (> ${String(MAX_UNTRACKED_FILE_BYTES)} bytes):`,
    skippedLargePaths,
  );
  appendPromptSection(parts, 'Omitted:', omittedPaths);
  parts.push('', '```diff', diff, '```');

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

function buildSnapshotDiff(diff: string, untrackedPatches: string[]): string {
  return joinNonEmptyParts([diff, ...untrackedPatches]);
}

function buildSnapshotStats(diff: string): Pick<LocalDiffSnapshot, 'empty' | 'stats'> {
  const empty = !diff.trim();
  return {
    empty,
    stats: empty ? EMPTY_DIFF_STATS : computeDiffStats(diff),
  };
}

function buildBudgetedSnapshotDiff(snapshot: LocalDiffSnapshot): BudgetedSnapshotDiff {
  const { diff, omittedPaths, truncated } = budgetDiffUnits(splitDiffUnits(snapshot.diff));
  return {
    diff,
    omittedPaths,
    summary: formatSnapshotSummary(snapshot.stats, omittedPaths),
    truncated,
  };
}

function buildStructuredContent(
  snapshot: LocalDiffSnapshot,
  analysis: string,
  omittedPaths: string[] = [],
  truncated?: boolean,
): AnalyzePrStructuredContent {
  return {
    analysis,
    stats: snapshot.stats,
    reviewedPaths: snapshot.reviewedPaths,
    includedUntracked: snapshot.includedUntracked,
    skippedBinaryPaths: snapshot.skippedBinaryPaths,
    skippedLargePaths: snapshot.skippedLargePaths,
    ...(omittedPaths.length > 0 ? { omittedPaths } : {}),
    empty: snapshot.empty,
    ...(truncated ? { truncated } : {}),
  };
}

function buildNoChangesAnalysis(snapshot: LocalDiffSnapshot): string {
  const skippedNotes = [
    snapshot.skippedBinaryPaths.length > 0
      ? `binary untracked files: ${snapshot.skippedBinaryPaths.join(', ')}`
      : '',
    snapshot.skippedLargePaths.length > 0
      ? `large untracked files over ${String(MAX_UNTRACKED_FILE_BYTES)} bytes: ${snapshot.skippedLargePaths.join(', ')}`
      : '',
  ].filter(Boolean);

  return skippedNotes.length > 0
    ? `No reviewable local text changes to review. Skipped ${skippedNotes.join('; ')}.`
    : 'No local changes to review.';
}

function formatSnapshotSummary(stats: DiffStats, omittedPaths: string[] = []): string {
  return `${String(stats.files)} files (+${String(stats.additions)}, -${String(stats.deletions)})${omittedPaths.length > 0 ? `, omitted ${String(omittedPaths.length)}` : ''}`;
}

function buildTextResult(
  snapshot: LocalDiffSnapshot,
  text: string,
  omittedPaths: string[] = [],
  truncated?: boolean,
): CallToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: buildStructuredContent(snapshot, text, omittedPaths, truncated),
  };
}

function buildAnalyzePrErrorResult(err: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: `${TOOL_LABEL}: ${formatAnalyzePrError(err)}` }],
    isError: true,
  };
}

async function logSnapshotStats(
  ctx: ServerContext,
  snapshot: LocalDiffSnapshot,
  truncated: boolean,
): Promise<void> {
  await ctx.mcpReq.log(
    'info',
    `analyze_pr: ${String(snapshot.stats.files)} files, +${String(snapshot.stats.additions)}/-${String(snapshot.stats.deletions)}${truncated ? ' (truncated)' : ''}`,
  );
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

  const untrackedResults = await collectUntrackedResults(gitRoot, untrackedPaths);
  const { includedUntracked, skippedBinaryPaths, skippedLargePaths, untrackedPatches } =
    summarizeUntrackedResults(untrackedResults);
  const reviewedPaths = uniqueSortedPaths([...trackedSnapshot.paths, ...includedUntracked]);
  const diff = buildSnapshotDiff(trackedSnapshot.diff, untrackedPatches);
  const { empty, stats } = buildSnapshotStats(diff);

  return {
    diff,
    stats,
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
    return buildAnalyzePrErrorResult(err);
  }

  const budgetedDiff = buildBudgetedSnapshotDiff(snapshot);
  await sendProgress(ctx, 1, 3, `${TOOL_LABEL}: ${budgetedDiff.summary}`);

  if (snapshot.empty) {
    const analysis = buildNoChangesAnalysis(snapshot);
    await reportCompletion(ctx, TOOL_LABEL, 'no changes');
    return buildTextResult(snapshot, analysis);
  }

  if (dryRun) {
    await reportCompletion(ctx, TOOL_LABEL, 'snapshot ready');
    return buildTextResult(
      snapshot,
      budgetedDiff.diff,
      budgetedDiff.omittedPaths,
      budgetedDiff.truncated,
    );
  }

  await sendProgress(ctx, 2, 3, `${TOOL_LABEL}: Analyzing generated diff`);
  await logSnapshotStats(ctx, snapshot, budgetedDiff.truncated);

  const prompt = buildAnalysisPrompt(
    budgetedDiff.diff,
    snapshot.stats,
    snapshot.reviewedPaths,
    snapshot.includedUntracked,
    snapshot.skippedBinaryPaths,
    snapshot.skippedLargePaths,
    budgetedDiff.omittedPaths,
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
      structuredContent: buildStructuredContent(
        snapshot,
        textContent || '',
        budgetedDiff.omittedPaths,
        budgetedDiff.truncated,
      ),
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
