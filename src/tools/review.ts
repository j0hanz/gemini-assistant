import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createPartFromUri } from '@google/genai';

import { cleanupErrorLogger } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildErrorDiagnosisPrompt } from '../lib/model-prompts.js';
import { buildDiffReviewPrompt } from '../lib/model-prompts.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { buildBaseStructuredOutput } from '../lib/response.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { buildServerRootsFetcher, type RootsFetcher, validateUrls } from '../lib/validation.js';
import {
  type AnalyzePrInput,
  type CompareFilesInput,
  type ReviewInput,
  ReviewInputSchema,
} from '../schemas/inputs.js';
import { ReviewOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig, getAI, MODEL } from '../client.js';

const execFileAsync = promisify(execFile);

const COMPARE_FILE_TOOL_LABEL = 'Compare Files';
const REVIEW_DIFF_TOOL_LABEL = 'Review Diff';
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_DIFF_CHARS = 500_000;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const EMPTY_DIFF_STATS: DiffStats = { files: 0, additions: 0, deletions: 0 };
const DIFF_HEADER_PATTERN = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/;
const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });
const SOURCE_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.ts',
  '.tsx',
]);
const ASSET_FILE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.wav',
  '.webm',
  '.webp',
]);
const HIGH_RISK_SEGMENTS = new Set([
  'api',
  'apis',
  'auth',
  'config',
  'configs',
  'data',
  'database',
  'db',
  'middleware',
  'migrations',
  'route',
  'routes',
  'router',
  'routers',
  'schema',
  'schemas',
  'server',
  'services',
  'store',
  'stores',
]);
const HIGH_RISK_BASENAMES = [
  'dockerfile',
  'eslint.config.',
  'package.json',
  'tsconfig',
  'vite.config.',
  'webpack.config.',
];
const LOW_SIGNAL_SEGMENTS = new Set([
  '__snapshots__',
  '__tests__',
  'assets',
  'coverage',
  'dist',
  'docs',
  'example',
  'examples',
  'fixture',
  'fixtures',
  'node_modules',
  'public',
  'snapshot',
  'snapshots',
  'test',
  'tests',
  'vendor',
]);
const NOISY_EXACT_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);
const NOISY_SUFFIXES = ['.map', '.min.js', '.min.css'];

const NOISY_EXCLUDE_PATHSPECS = [
  ...[...NOISY_EXACT_BASENAMES].map((basename) => `:!${basename}`),
  ...NOISY_SUFFIXES.map((suffix) => `:!*${suffix}`),
];

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
  reviewedPaths: string[];
  summary: string;
  truncated: boolean;
}

interface GitDiffArgsOptions {
  againstHead?: boolean;
  nameOnly?: boolean;
  staged?: boolean;
}

function createCompareFileWork(rootsFetcher: RootsFetcher) {
  return async function compareFileWork(
    { filePathA, filePathB, question, thinkingLevel, googleSearch, cacheName }: CompareFilesInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const uploadedNames: string[] = [];

    const progress = new ProgressReporter(ctx, COMPARE_FILE_TOOL_LABEL);

    try {
      await progress.step(0, 4, 'Uploading file A');
      const fileA = await uploadFile(filePathA, ctx.mcpReq.signal, rootsFetcher);
      uploadedNames.push(fileA.name);

      await progress.step(1, 4, 'Uploading file B');
      const fileB = await uploadFile(filePathB, ctx.mcpReq.signal, rootsFetcher);
      uploadedNames.push(fileB.name);

      await ctx.mcpReq.log('info', `Comparing: ${fileA.displayPath} vs ${fileB.displayPath}`);
      await progress.step(2, 4, 'Analyzing differences');

      const prompt = buildDiffReviewPrompt({
        cacheName,
        focus: question,
        mode: 'compare',
        promptParts: [
          { text: `File A: ${fileA.displayPath}` },
          createPartFromUri(fileA.uri, fileA.mimeType),
          { text: `File B: ${fileB.displayPath}` },
          createPartFromUri(fileB.uri, fileB.mimeType),
        ],
      });

      return await executor.runStream(
        ctx,
        'compare_files',
        COMPARE_FILE_TOOL_LABEL,
        () =>
          getAI().models.generateContentStream({
            model: MODEL,
            contents: prompt.promptParts,
            config: buildGenerateContentConfig(
              {
                systemInstruction: prompt.systemInstruction,
                thinkingLevel,
                cacheName,
                ...buildOrchestrationConfig({
                  toolProfile: googleSearch ? 'search' : 'none',
                }),
              },
              ctx.mcpReq.signal,
            ),
          }),
        (_streamResult, textContent: string) => ({
          structuredContent: {
            comparison: textContent || '',
          },
        }),
      );
    } finally {
      await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx));
    }
  };
}

interface FailureReviewSubject {
  codeContext?: string | undefined;
  error: string;
  googleSearch?: boolean | undefined;
  kind: 'failure';
  language?: string | undefined;
  urls?: readonly string[] | undefined;
}

async function diagnoseFailureWork(
  subject: FailureReviewSubject,
  focus: string | undefined,
  cacheName: string | undefined,
  thinkingLevel: ReviewInput['thinkingLevel'],
  ctx: ServerContext,
): Promise<CallToolResult> {
  const { urls, error, codeContext, language, googleSearch } = subject;

  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) return invalidUrlResult;

  const prompt = buildErrorDiagnosisPrompt({
    cacheName,
    codeContext: focus
      ? [codeContext, 'Review focus: ' + focus].filter(Boolean).join('\n\n')
      : codeContext,
    error,
    language,
    urls,
  });

  const orchestration = buildOrchestrationConfig({
    toolProfile:
      googleSearch && (urls?.length ?? 0) > 0
        ? 'search_url'
        : googleSearch
          ? 'search'
          : (urls?.length ?? 0) > 0
            ? 'url'
            : 'none',
  });

  const progress = new ProgressReporter(ctx, 'Review Failure');
  await progress.send(0, undefined, 'Diagnosing');
  await ctx.mcpReq.log('info', `Review failure: ${error.length} chars`);

  return await executor.runStream(
    ctx,
    'review_failure',
    'Review Failure',
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: prompt.systemInstruction,
            thinkingLevel,
            cacheName,
            ...orchestration,
          },
          ctx.mcpReq.signal,
        ),
      }),
    (_streamResult, textContent: string) => ({
      structuredContent: {
        explanation: textContent || '',
      },
    }),
  );
}

export function matchesNoisyPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = normalized.split('/').pop()?.toLowerCase() ?? '';
  return (
    NOISY_EXACT_BASENAMES.has(basename) ||
    NOISY_SUFFIXES.some((suffix) => basename.endsWith(suffix))
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

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').toLowerCase();
}

function splitPathSegments(filePath: string): string[] {
  return normalizePath(filePath).split('/').filter(Boolean);
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
  const cwd = process.cwd();
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return stdout.trim();
}

async function findGitRootFromDirectory(
  workingDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workingDirectory,
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

export function scoreDiffUnitRisk(unit: DiffUnit): number {
  const normalizedPath = normalizePath(unit.path);
  const segments = splitPathSegments(unit.path);
  const basename = segments.at(-1) ?? normalizedPath;
  const extension = basename.includes('.') ? `.${basename.split('.').pop() ?? ''}` : '';
  const changeSize = unit.additions + unit.deletions;
  let score = 0;

  if (matchesNoisyPath(unit.path)) score -= 120;
  if (segments.some((segment) => LOW_SIGNAL_SEGMENTS.has(segment))) score -= 35;
  if (ASSET_FILE_EXTENSIONS.has(extension)) score -= 25;
  if (SOURCE_FILE_EXTENSIONS.has(extension)) score += 25;
  if (segments.some((segment) => HIGH_RISK_SEGMENTS.has(segment))) score += 30;
  if (
    HIGH_RISK_BASENAMES.some(
      (needle) => basename === needle || basename.startsWith(needle) || basename.includes(needle),
    )
  ) {
    score += 35;
  }
  if (normalizedPath.includes('.github/workflows/')) score += 25;
  if (normalizedPath.includes('/build/') || normalizedPath.includes('/scripts/')) score += 15;
  if (normalizedPath.includes('/src/')) score += 10;

  return score * 1_000 + changeSize;
}

export function budgetDiffUnits(
  units: DiffUnit[],
  maxChars = MAX_DIFF_CHARS,
): { diff: string; omittedPaths: string[]; reviewedPaths: string[]; truncated: boolean } {
  const orderedUnits = [...units].sort((a, b) => {
    const scoreDelta = scoreDiffUnitRisk(b) - scoreDiffUnitRisk(a);
    return scoreDelta !== 0 ? scoreDelta : a.path.localeCompare(b.path);
  });

  const keptUnits: DiffUnit[] = [];
  const omittedPaths: string[] = [];
  let currentLength = 0;

  for (const unit of orderedUnits) {
    const separatorLength = keptUnits.length > 0 ? 1 : 0;
    const nextLength = currentLength + separatorLength + unit.text.length;

    if (nextLength > maxChars) {
      omittedPaths.push(unit.path);
      continue;
    }

    keptUnits.push(unit);
    currentLength = nextLength;
  }

  return {
    diff: keptUnits.map((unit) => unit.text).join('\n'),
    ...(omittedPaths.length > 0 ? { omittedPaths: omittedPaths.sort() } : { omittedPaths: [] }),
    reviewedPaths: keptUnits.map((unit) => unit.path).sort(),
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
  const { diff, omittedPaths, reviewedPaths, truncated } = budgetDiffUnits(
    splitDiffUnits(snapshot.diff),
  );
  return {
    diff,
    omittedPaths,
    reviewedPaths,
    summary: formatSnapshotSummary(snapshot.stats, omittedPaths),
    truncated,
  };
}

function buildStructuredContent(
  snapshot: LocalDiffSnapshot,
  analysis: string,
  reviewedPaths: string[],
  omittedPaths: string[] = [],
  truncated?: boolean,
): AnalyzePrStructuredContent {
  return {
    analysis,
    stats: snapshot.stats,
    reviewedPaths,
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

function buildBudgetExceededAnalysis(omittedPaths: string[]): string {
  return `No local diff content fit the review size budget. Omitted ${String(omittedPaths.length)} path(s): ${omittedPaths.join(', ')}. Narrow the change set or run a more targeted review.`;
}

function formatSnapshotSummary(stats: DiffStats, omittedPaths: string[] = []): string {
  return `${String(stats.files)} files (+${String(stats.additions)}, -${String(stats.deletions)})${omittedPaths.length > 0 ? `, omitted ${String(omittedPaths.length)}` : ''}`;
}

function buildTextResult(
  snapshot: LocalDiffSnapshot,
  text: string,
  reviewedPaths: string[],
  omittedPaths: string[] = [],
  truncated?: boolean,
): CallToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: buildStructuredContent(
      snapshot,
      text,
      reviewedPaths,
      omittedPaths,
      truncated,
    ),
  };
}

function buildAnalyzePrErrorResult(err: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: `${REVIEW_DIFF_TOOL_LABEL}: ${formatAnalyzePrError(err)}` }],
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

export async function buildLocalDiffSnapshot(
  workingDirectory = process.cwd(),
  signal?: AbortSignal,
): Promise<LocalDiffSnapshot> {
  const gitRoot =
    workingDirectory === process.cwd()
      ? await findGitRoot(signal)
      : await findGitRootFromDirectory(workingDirectory, signal);
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

export async function analyzePrWork(
  { thinkingLevel, language, dryRun, cacheName }: AnalyzePrInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const progress = new ProgressReporter(ctx, REVIEW_DIFF_TOOL_LABEL);
  await progress.step(0, 3, 'Inspecting local changes');

  let snapshot: LocalDiffSnapshot;
  try {
    snapshot = await buildLocalDiffSnapshot(process.cwd(), ctx.mcpReq.signal);
  } catch (err) {
    return buildAnalyzePrErrorResult(err);
  }

  const budgetedDiff = buildBudgetedSnapshotDiff(snapshot);
  await progress.step(1, 3, budgetedDiff.summary);

  if (snapshot.empty) {
    const analysis = buildNoChangesAnalysis(snapshot);
    await progress.complete('no changes');
    return buildTextResult(snapshot, analysis, snapshot.reviewedPaths);
  }

  if (dryRun) {
    await progress.complete('snapshot ready');
    return buildTextResult(
      snapshot,
      budgetedDiff.diff,
      budgetedDiff.reviewedPaths,
      budgetedDiff.omittedPaths,
      budgetedDiff.truncated,
    );
  }

  if (budgetedDiff.reviewedPaths.length === 0) {
    const analysis = buildBudgetExceededAnalysis(budgetedDiff.omittedPaths);
    await progress.complete('all changes omitted');
    return buildTextResult(
      snapshot,
      analysis,
      budgetedDiff.reviewedPaths,
      budgetedDiff.omittedPaths,
      budgetedDiff.truncated,
    );
  }

  await progress.step(2, 3, 'Analyzing generated diff');
  await logSnapshotStats(ctx, snapshot, budgetedDiff.truncated);

  const prompt = buildAnalysisPrompt(
    budgetedDiff.diff,
    snapshot.stats,
    budgetedDiff.reviewedPaths,
    snapshot.includedUntracked,
    snapshot.skippedBinaryPaths,
    snapshot.skippedLargePaths,
    budgetedDiff.omittedPaths,
    language,
  );

  const modelPrompt = buildDiffReviewPrompt({
    cacheName,
    mode: 'review',
    promptText: prompt,
  });

  return await executor.runStream(
    ctx,
    'analyze_pr',
    REVIEW_DIFF_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: modelPrompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: modelPrompt.systemInstruction,
            thinkingLevel,
            cacheName,
          },
          ctx.mcpReq.signal,
        ),
      }),
    (_streamResult, textContent: string) => ({
      structuredContent: buildStructuredContent(
        snapshot,
        textContent || '',
        budgetedDiff.reviewedPaths,
        budgetedDiff.omittedPaths,
        budgetedDiff.truncated,
      ),
      reportMessage: `${String(snapshot.stats.files)} files reviewed (+${String(snapshot.stats.additions)}, -${String(snapshot.stats.deletions)})`,
    }),
  );
}

function buildReviewStructuredContent(
  taskId: string | undefined,
  subjectKind: string,
  structured: Record<string, unknown>,
): Record<string, unknown> {
  const summary =
    typeof structured.analysis === 'string'
      ? structured.analysis
      : typeof structured.comparison === 'string'
        ? structured.comparison
        : typeof structured.explanation === 'string'
          ? structured.explanation
          : '';

  return {
    ...buildBaseStructuredOutput(taskId),
    subjectKind,
    summary,
    ...(structured.stats ? { stats: structured.stats } : {}),
    ...(structured.reviewedPaths ? { reviewedPaths: structured.reviewedPaths } : {}),
    ...(structured.includedUntracked ? { includedUntracked: structured.includedUntracked } : {}),
    ...(structured.skippedBinaryPaths ? { skippedBinaryPaths: structured.skippedBinaryPaths } : {}),
    ...(structured.skippedLargePaths ? { skippedLargePaths: structured.skippedLargePaths } : {}),
    ...(structured.omittedPaths ? { omittedPaths: structured.omittedPaths } : {}),
    ...(typeof structured.empty === 'boolean' ? { empty: structured.empty } : {}),
    ...(typeof structured.truncated === 'boolean' ? { truncated: structured.truncated } : {}),
    ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
    ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
    ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
    ...(structured.usage ? { usage: structured.usage } : {}),
  };
}

async function reviewWork(
  compareWork: ReturnType<typeof createCompareFileWork>,
  args: ReviewInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  let result: CallToolResult;

  if (args.subject.kind === 'diff') {
    result = await analyzePrWork(
      {
        dryRun: args.subject.dryRun,
        cacheName: args.cacheName,
        language: args.subject.language,
        thinkingLevel: args.thinkingLevel,
      },
      ctx,
    );
  } else if (args.subject.kind === 'comparison') {
    result = await compareWork(
      {
        filePathA: args.subject.filePathA,
        filePathB: args.subject.filePathB,
        question: args.subject.question ?? args.focus,
        thinkingLevel: args.thinkingLevel,
        googleSearch: args.subject.googleSearch,
        cacheName: args.cacheName,
      },
      ctx,
    );
  } else {
    result = await diagnoseFailureWork(
      {
        error: args.subject.error,
        codeContext: args.subject.codeContext,
        kind: 'failure',
        language: args.subject.language,
        googleSearch: args.subject.googleSearch,
        urls: args.subject.urls,
      },
      args.focus,
      args.cacheName,
      args.thinkingLevel,
      ctx,
    );
  }

  if (result.isError) {
    return result;
  }

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;

  return {
    ...result,
    structuredContent: buildReviewStructuredContent(ctx.task?.id, args.subject.kind, structured),
  };
}

export function registerReviewTool(server: McpServer, taskMessageQueue: TaskMessageQueue): void {
  const compareWork = createCompareFileWork(buildServerRootsFetcher(server));

  registerTaskTool(
    server,
    'review',
    {
      title: 'Review',
      description: 'Review a local diff, compare two files, or diagnose a failing change.',
      inputSchema: ReviewInputSchema,
      outputSchema: ReviewOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: ReviewInput, ctx: ServerContext) => reviewWork(compareWork, args, ctx),
  );
}
