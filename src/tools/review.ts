import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod/v4';

import { withUploadsAndPipeline } from '../lib/file.js';
import { logger, mcpLog, type ScopedLogger } from '../lib/logger.js';
import { buildDiffReviewPrompt, buildErrorDiagnosisPrompt } from '../lib/model-prompts.js';
import { resolveOrchestration, type ToolsSpecInput } from '../lib/orchestration.js';
import { buildSuccessfulStructuredContent, tryParseJsonResponse } from '../lib/response.js';
import {
  getTaskEmitter,
  getWorkSignal,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerWorkTool,
} from '../lib/tasks.js';
import {
  createDefaultToolServices,
  isPathWithinRoot,
  type ToolRootsFetcher,
  type ToolServices,
  type ToolWorkspaceCacheManager,
} from '../lib/tool-context.js';
import { createToolContext, executor } from '../lib/tool-executor.js';
import {
  getAllowedRoots,
  isSensitiveUntrackedPath as isSensitiveUntrackedPathFromValidation,
} from '../lib/validation.js';
import {
  type GeminiResponseSchema,
  type ReviewInput,
  ReviewInputSchema,
} from '../schemas/inputs.js';
import { DocumentationDriftSchema, ReviewOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig, getAI } from '../client.js';
import { getGeminiModel, getReviewDocs } from '../config.js';
import { TOOL_LABELS } from '../public-contract.js';

const execFileAsync = promisify(execFile);
let reviewGitRunner = execFileAsync;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_DIFF_CHARS = 200_000;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const TRUNCATED_DIFF_NOTICE = '\n# Review truncated to fit diff budget.';
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
  skippedSensitivePaths: string[];
  empty: boolean;
}

interface UntrackedPatchResult {
  patch?: string;
  path: string;
  skipReason?: 'binary' | 'sensitive' | 'too_large';
}

type AnalyzePrStructuredContent = Record<string, unknown> & {
  summary: string;
  schemaWarnings?: string[];
  stats: DiffStats;
  reviewedPaths: string[];
  includedUntracked: string[];
  skippedBinaryPaths: string[];
  skippedLargePaths: string[];
  skippedSensitivePaths: string[];
  omittedPaths?: string[];
  empty: boolean;
  truncated?: boolean;
  documentationDrift?: { file: string; driftDescription: string; suggestedUpdate: string }[];
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

type ReviewCompareWork = ReturnType<typeof createCompareFileWork>;
type ReviewDiffInput = Extract<ReviewInput, { subjectKind: 'diff' }>;
type ReviewComparisonInput = Extract<ReviewInput, { subjectKind: 'comparison' }>;
type ReviewFailureInput = Extract<ReviewInput, { subjectKind: 'failure' }>;

type ReviewDiagnoseFailureWork = typeof diagnoseFailureWork;
type ReviewAnalyzePrWork = typeof analyzePrWork;

const AnalyzePrModelOutputSchema = z.strictObject({
  summary: z.string(),
  documentationDrift: z.array(DocumentationDriftSchema).optional(),
});

const AnalyzePrModelResponseSchema = {
  type: 'object',
  description:
    'Structured review result with a required summary and optional documentation drift findings.',
  properties: {
    summary: {
      type: 'string',
      description: 'Concise review summary for the analyzed diff.',
    },
    documentationDrift: {
      type: 'array',
      description: 'Documentation files made outdated or misleading by the diff.',
      items: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Documentation file path that needs an update.',
          },
          driftDescription: {
            type: 'string',
            description: 'Why the current documentation no longer matches the code changes.',
          },
          suggestedUpdate: {
            type: 'string',
            description: 'Brief suggestion for the documentation change.',
          },
        },
        required: ['file', 'driftDescription', 'suggestedUpdate'],
      },
    },
  },
  required: ['summary'],
} satisfies GeminiResponseSchema;

export interface ReviewWorkDeps {
  compareWork: ReviewCompareWork;
  rootsFetcher: ToolRootsFetcher;
  analyzePrWork?: ReviewAnalyzePrWork;
  diagnoseFailureWork?: ReviewDiagnoseFailureWork;
}

export function __setReviewGitRunnerForTests(mockRunner: typeof execFileAsync): () => void {
  const previousRunner = reviewGitRunner;
  reviewGitRunner = mockRunner;
  return () => {
    reviewGitRunner = previousRunner;
  };
}

interface GitDiffArgsOptions {
  againstHead?: boolean;
  nameOnly?: boolean;
  staged?: boolean;
}

function createCompareFileWork(rootsFetcher: ToolRootsFetcher) {
  return async function compareFileWork(
    {
      filePathA,
      filePathB,
      question,
      thinkingLevel,
      thinkingBudget,
      maxOutputTokens,
      safetySettings,
      tools,
    }: ReviewComparisonInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const resolved = await resolveOrchestration(tools as ToolsSpecInput | undefined, ctx, {
      toolKey: 'review',
      mode: 'comparison',
    });
    if (resolved.error) return resolved.error;

    const { progress } = createToolContext('compareFiles', ctx);

    return await withUploadsAndPipeline(
      ctx,
      rootsFetcher,
      [filePathA, filePathB],
      progress,
      (filePath, index) => `Uploading file ${index === 0 ? 'A' : 'B'}`,
      async (contents) => {
        const fileA = contents[0];
        const fileB = contents[1];

        await mcpLog(ctx, 'info', `Comparing: ${filePathA} vs ${filePathB}`);
        await progress.step(2, 3, 'Analyzing differences');

        const prompt = buildDiffReviewPrompt({
          focus: question,
          mode: 'compare',
          promptParts: [
            { text: `File A: ${filePathA}` },
            fileA ?? { text: '' },
            { text: `File B: ${filePathB}` },
            fileB ?? { text: '' },
          ],
        });

        return await executor.runStream(
          ctx,
          'compare_files',
          TOOL_LABELS.compareFiles,
          () =>
            getAI().models.generateContentStream({
              model: getGeminiModel(),
              contents: prompt.promptParts,
              config: buildGenerateContentConfig(
                {
                  systemInstruction: prompt.systemInstruction,
                  costProfile: 'review.comparison',
                  thinkingLevel,
                  thinkingBudget,
                  maxOutputTokens,
                  safetySettings,
                  tools: resolved.config.tools,
                  toolConfig: resolved.config.toolConfig,
                },
                getWorkSignal(ctx),
              ),
            }),
          (_streamResult, textContent: string) => ({
            structuredContent: {
              summary: textContent || '',
            },
          }),
        );
      },
      0,
    );
  };
}

interface FailureReviewSubject {
  codeContext?: ReviewFailureInput['codeContext'];
  error: ReviewFailureInput['error'];
  language?: ReviewFailureInput['language'];
  maxOutputTokens?: ReviewFailureInput['maxOutputTokens'];
  safetySettings?: ReviewFailureInput['safetySettings'];
  thinkingBudget?: ReviewFailureInput['thinkingBudget'];
  tools?: ReviewFailureInput['tools'];
}

async function diagnoseFailureWork(
  subject: FailureReviewSubject,
  focus: string | undefined,
  thinkingLevel: ReviewInput['thinkingLevel'],
  ctx: ServerContext,
): Promise<CallToolResult> {
  const { error, codeContext, language, maxOutputTokens, safetySettings, thinkingBudget, tools } =
    subject;

  const resolved = await resolveOrchestration(tools as ToolsSpecInput | undefined, ctx, {
    toolKey: 'review',
    mode: 'failure',
  });
  if (resolved.error) return resolved.error;

  const googleSearchEnabled = resolved.config.activeCapabilities.has('googleSearch');
  const resolvedUrls = resolved.config.resolvedProfile?.overrides.urls;

  const prompt = buildErrorDiagnosisPrompt({
    codeContext: focus
      ? [codeContext, 'Review focus: ' + focus].filter(Boolean).join('\n\n')
      : codeContext,
    error,
    googleSearchEnabled,
    language,
    urls: resolvedUrls,
  });

  const { progress } = createToolContext('reviewFailure', ctx);
  await progress.send(0, undefined, 'Diagnosing');
  await mcpLog(ctx, 'info', `Review failure: ${error.length} chars`);

  return await executor.runStream(
    ctx,
    'review_failure',
    TOOL_LABELS.reviewFailure,
    () =>
      getAI().models.generateContentStream({
        model: getGeminiModel(),
        contents: [prompt.promptText],
        config: buildGenerateContentConfig(
          {
            systemInstruction: prompt.systemInstruction,
            costProfile: 'review.failure',
            thinkingLevel,
            thinkingBudget,
            maxOutputTokens,
            safetySettings,
            tools: resolved.config.tools,
            toolConfig: resolved.config.toolConfig,
          },
          getWorkSignal(ctx),
        ),
      }),
    (_streamResult, textContent: string) => ({
      structuredContent: {
        summary: textContent || '',
      },
    }),
  );
}

export function matchesNoisyPath(filePath: string): boolean {
  return PATH_RULES.isNoisy(filePath);
}

export function isSensitiveUntrackedPath(relativePath: string): boolean {
  return isSensitiveUntrackedPathFromValidation(relativePath);
}

const PATH_RULES = {
  isNoisy(filePath: string): boolean {
    const normalized = filePath.replaceAll('\\', '/');
    const basename = normalized.split('/').pop()?.toLowerCase() ?? '';
    return (
      NOISY_EXACT_BASENAMES.has(basename) ||
      NOISY_SUFFIXES.some((suffix) => basename.endsWith(suffix))
    );
  },
  isHighRiskBasename(basename: string): boolean {
    return HIGH_RISK_BASENAMES.some(
      (needle) => basename === needle || basename.startsWith(needle) || basename.includes(needle),
    );
  },
  scoreLocation(normalizedPath: string): number {
    let score = 0;
    if (normalizedPath.includes('.github/workflows/')) score += 25;
    if (normalizedPath.includes('/build/') || normalizedPath.includes('/scripts/')) score += 15;
    if (normalizedPath.includes('/src/')) score += 10;
    return score;
  },
} as const;

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
  const { stdout } = await reviewGitRunner('git', ['rev-parse', '--show-toplevel'], {
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
  const { stdout } = await reviewGitRunner('git', ['rev-parse', '--show-toplevel'], {
    cwd: workingDirectory,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return stdout.trim();
}

async function runGit(gitRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await reviewGitRunner('git', args, {
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
  signal?: AbortSignal,
): Promise<UntrackedPatchResult[]> {
  const results: UntrackedPatchResult[] = [];

  for (const relativePath of untrackedPaths) {
    signal?.throwIfAborted();
    results.push(await buildUntrackedPatch(gitRoot, relativePath, signal));
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

export async function buildUntrackedPatch(
  gitRoot: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<UntrackedPatchResult> {
  signal?.throwIfAborted();
  const absolutePath = join(gitRoot, relativePath);
  if (!isPathWithinRoot(absolutePath, gitRoot)) {
    return { path: relativePath, skipReason: 'sensitive' };
  }

  if (isSensitiveUntrackedPath(relativePath)) {
    return { path: relativePath, skipReason: 'sensitive' };
  }

  const fileStats = await lstat(absolutePath).catch(() => null);

  if (!fileStats?.isFile()) {
    return { path: relativePath };
  }

  if (fileStats.size > MAX_UNTRACKED_FILE_BYTES) {
    return { path: relativePath, skipReason: 'too_large' };
  }

  const fileBuffer = await readFile(absolutePath, { signal });
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

function getExtension(basename: string): string {
  return basename.includes('.') ? `.${basename.split('.').pop() ?? ''}` : '';
}

function hasHighRiskBasename(basename: string): boolean {
  return PATH_RULES.isHighRiskBasename(basename);
}

function scorePathLocation(normalizedPath: string): number {
  return PATH_RULES.scoreLocation(normalizedPath);
}

export function scoreDiffUnitRisk(unit: DiffUnit): number {
  const normalizedPath = normalizePath(unit.path);
  const segments = splitPathSegments(unit.path);
  const basename = segments.at(-1) ?? normalizedPath;
  const extension = getExtension(basename);
  const changeSize = unit.additions + unit.deletions;
  let score = 0;

  if (matchesNoisyPath(unit.path)) score -= 120;
  if (segments.some((segment) => LOW_SIGNAL_SEGMENTS.has(segment))) score -= 35;
  if (ASSET_FILE_EXTENSIONS.has(extension)) score -= 25;
  if (SOURCE_FILE_EXTENSIONS.has(extension)) score += 25;
  if (segments.some((segment) => HIGH_RISK_SEGMENTS.has(segment))) score += 30;
  if (hasHighRiskBasename(basename)) score += 35;

  score += scorePathLocation(normalizedPath);

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
  let partiallyTruncated = false;

  for (const [index, unit] of orderedUnits.entries()) {
    const separatorLength = keptUnits.length > 0 ? 1 : 0;
    const nextLength = currentLength + separatorLength + unit.text.length;

    if (nextLength > maxChars) {
      const remainingChars = maxChars - currentLength - separatorLength;
      if (keptUnits.length > 0 && remainingChars > TRUNCATED_DIFF_NOTICE.length + 1) {
        const truncatedText = buildTruncatedDiffUnitText(unit.text, remainingChars);
        if (truncatedText) {
          keptUnits.push({
            ...unit,
            text: truncatedText,
          });
          partiallyTruncated = true;
          omittedPaths.push(...orderedUnits.slice(index + 1).map((candidate) => candidate.path));
          break;
        }
      }

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
    truncated: partiallyTruncated || omittedPaths.length > 0,
  };
}

function buildTruncatedDiffUnitText(text: string, remainingChars: number): string | undefined {
  const contentBudget = remainingChars - TRUNCATED_DIFF_NOTICE.length;
  if (contentBudget <= 0) {
    return undefined;
  }

  const slicedText = text.slice(0, contentBudget);
  const lastNewlineIndex = slicedText.lastIndexOf('\n');
  const preservedText = lastNewlineIndex > 0 ? slicedText.slice(0, lastNewlineIndex) : slicedText;
  const normalizedText = preservedText.trimEnd();

  if (!normalizedText) {
    return undefined;
  }

  return `${normalizedText}${TRUNCATED_DIFF_NOTICE}`;
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
  focus?: string,
  skippedSensitivePaths: string[] = [],
): string {
  const parts = [
    '## Snapshot',
    `Files: ${String(stats.files)} | +${String(stats.additions)} -${String(stats.deletions)}`,
    ...(language ? [`Lang: ${language}`] : []),
    ...(focus ? ['', 'Focus:', focus] : []),
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
  appendPromptSection(parts, 'Skipped sensitive:', skippedSensitivePaths);
  appendPromptSection(parts, 'Omitted:', omittedPaths);
  parts.push('', '```diff', diff, '```');

  return parts.join('\n');
}

function summarizeUntrackedResults(untrackedResults: UntrackedPatchResult[]): {
  includedUntracked: string[];
  skippedBinaryPaths: string[];
  skippedLargePaths: string[];
  skippedSensitivePaths: string[];
  untrackedPatches: string[];
} {
  const includedUntracked: string[] = [];
  const skippedBinaryPaths: string[] = [];
  const skippedLargePaths: string[] = [];
  const skippedSensitivePaths: string[] = [];
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
    if (result.skipReason === 'sensitive') {
      skippedSensitivePaths.push(result.path);
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
  skippedSensitivePaths.sort();

  return {
    includedUntracked,
    skippedBinaryPaths,
    skippedLargePaths,
    skippedSensitivePaths,
    untrackedPatches,
  };
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
  summary: string,
  reviewedPaths: string[],
  omittedPaths: string[] = [],
  truncated?: boolean,
  documentationDrift?: { file: string; driftDescription: string; suggestedUpdate: string }[],
  schemaWarnings?: string[],
): AnalyzePrStructuredContent {
  return {
    summary,
    ...(schemaWarnings && schemaWarnings.length > 0 ? { schemaWarnings } : {}),
    stats: snapshot.stats,
    reviewedPaths,
    includedUntracked: snapshot.includedUntracked,
    skippedBinaryPaths: snapshot.skippedBinaryPaths,
    skippedLargePaths: snapshot.skippedLargePaths,
    skippedSensitivePaths: snapshot.skippedSensitivePaths,
    ...(omittedPaths.length > 0 ? { omittedPaths } : {}),
    empty: snapshot.empty,
    ...(truncated ? { truncated } : {}),
    ...(documentationDrift && documentationDrift.length > 0 ? { documentationDrift } : {}),
  };
}

export function parseAnalyzePrModelOutput(textContent: string): {
  summary: string;
  documentationDrift?: { file: string; driftDescription: string; suggestedUpdate: string }[];
  schemaWarnings: string[];
} {
  if (textContent.trim().length === 0) {
    return {
      summary: '',
      schemaWarnings: [],
    };
  }

  let summary = textContent || '';
  const schemaWarnings: string[] = [];
  let documentationDrift:
    | { file: string; driftDescription: string; suggestedUpdate: string }[]
    | undefined;

  const parsedJson = tryParseJsonResponse(textContent);
  const parsedData = AnalyzePrModelOutputSchema.safeParse(parsedJson);

  if (parsedData.success) {
    summary = parsedData.data.summary.trim();
    if (parsedData.data.documentationDrift?.length) {
      documentationDrift = parsedData.data.documentationDrift;
    }
    return {
      summary,
      ...(documentationDrift ? { documentationDrift } : {}),
      schemaWarnings,
    };
  }

  schemaWarnings.push(
    `review structured output failed schema validation: ${z.prettifyError(parsedData.error)}`,
  );

  const parsedFallback = z
    .object({
      summary: z.string().optional(),
      documentationDrift: z.unknown().optional(),
    })
    .safeParse(parsedJson);

  if (parsedFallback.success) {
    summary = parsedFallback.data.summary?.trim() ?? summary;

    if (parsedFallback.data.documentationDrift !== undefined) {
      const parsedDocumentationDrift = z
        .array(DocumentationDriftSchema)
        .safeParse(parsedFallback.data.documentationDrift);
      if (parsedDocumentationDrift.success && parsedDocumentationDrift.data.length > 0) {
        documentationDrift = parsedDocumentationDrift.data;
      } else if (!parsedDocumentationDrift.success) {
        schemaWarnings.push(
          `documentationDrift structured output failed schema validation: ${z.prettifyError(parsedDocumentationDrift.error)}`,
        );
      }
    }
  }

  return {
    summary,
    ...(documentationDrift ? { documentationDrift } : {}),
    schemaWarnings,
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
    snapshot.skippedSensitivePaths.length > 0
      ? `sensitive untracked files: ${snapshot.skippedSensitivePaths.join(', ')}`
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
    content: [{ type: 'text', text: `${TOOL_LABELS.review}: ${formatAnalyzePrError(err)}` }],
    isError: true,
  };
}

async function logSnapshotStats(
  ctx: ServerContext,
  snapshot: LocalDiffSnapshot,
  truncated: boolean,
): Promise<void> {
  await mcpLog(
    ctx,
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

  const untrackedResults = await collectUntrackedResults(gitRoot, untrackedPaths, signal);
  const {
    includedUntracked,
    skippedBinaryPaths,
    skippedLargePaths,
    skippedSensitivePaths,
    untrackedPatches,
  } = summarizeUntrackedResults(untrackedResults);
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
    skippedSensitivePaths,
    empty,
  };
}

export async function resolveReviewWorkingDirectory(
  rootsFetcher: ToolRootsFetcher,
  log: ScopedLogger,
): Promise<string> {
  const roots = await rootsFetcher();
  if (roots.length === 0) {
    return process.cwd();
  }

  const selectedRoot = roots[0] ?? process.cwd();
  if (roots.length > 1) {
    log.warn('Multiple MCP roots advertised for review; using first root', {
      rootCount: roots.length,
      selectedRoot,
    });
  }

  const allowedRoots = await getAllowedRoots(rootsFetcher);
  if (!allowedRoots.some((root) => isPathWithinRoot(selectedRoot, root))) {
    throw new Error('Review root is outside ROOTS allow-list.');
  }

  return selectedRoot;
}

async function readDocFiles(
  workingDirectory: string,
  paths: string[],
): Promise<{ filename: string; content: string }[]> {
  const results: { filename: string; content: string }[] = [];
  for (const p of paths) {
    try {
      const content = await readFile(join(workingDirectory, p), 'utf-8');
      results.push({ filename: p, content });
    } catch {
      // ignore missing files silently
    }
  }
  return results;
}

export async function analyzePrWork(
  {
    thinkingLevel,
    language,
    dryRun,
    focus,
    maxOutputTokens,
    thinkingBudget,
    safetySettings,
  }: ReviewDiffInput,
  ctx: ServerContext,
  workspaceCacheManagerOrRootsFetcher?: ToolWorkspaceCacheManager | ToolRootsFetcher,
  rootsFetcher: ToolRootsFetcher = () => Promise.resolve([]),
  services?: ToolServices,
): Promise<CallToolResult> {
  const resolvedRootsFetcher =
    typeof workspaceCacheManagerOrRootsFetcher === 'function'
      ? workspaceCacheManagerOrRootsFetcher
      : rootsFetcher;
  const { progress } = createToolContext('review', ctx);
  await progress.step(0, 3, 'Inspecting local changes');
  const log = logger.child('review');
  const tasks = getTaskEmitter(ctx);

  let snapshot: LocalDiffSnapshot;
  let workingDirectory: string;
  try {
    workingDirectory = await resolveReviewWorkingDirectory(resolvedRootsFetcher, log);
    snapshot = await buildLocalDiffSnapshot(workingDirectory, ctx.mcpReq.signal);
  } catch (err) {
    return buildAnalyzePrErrorResult(err);
  }

  await tasks.phase('parsing-diff');
  const allUnits = splitDiffUnits(snapshot.diff);
  const budgetedDiff = buildBudgetedSnapshotDiff(snapshot);

  for (const unit of allUnits) {
    if (budgetedDiff.reviewedPaths.includes(unit.path)) {
      await tasks.finding({
        kind: 'file-stat',
        data: { path: unit.path, additions: unit.additions, deletions: unit.deletions },
      });
    }
  }

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

  await tasks.phase('analyzing');

  const envDocs = getReviewDocs();
  const docPathsToCheck = envDocs ?? [...(services?.workspace.scanFileNames() ?? [])];
  const docContexts = await readDocFiles(workingDirectory, docPathsToCheck);

  const prompt = buildAnalysisPrompt(
    budgetedDiff.diff,
    snapshot.stats,
    budgetedDiff.reviewedPaths,
    snapshot.includedUntracked,
    snapshot.skippedBinaryPaths,
    snapshot.skippedLargePaths,
    budgetedDiff.omittedPaths,
    language,
    focus,
    snapshot.skippedSensitivePaths,
  );

  const modelPrompt = buildDiffReviewPrompt({
    mode: 'review',
    promptText: prompt,
    docContexts,
  });

  await tasks.phase('composing');
  const result = await executor.executeGeminiPipeline(ctx, {
    toolName: 'analyze_pr',
    label: TOOL_LABELS.review,
    cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,
    buildContents: () => ({
      contents: [modelPrompt.promptText],
      systemInstruction: modelPrompt.systemInstruction,
    }),
    config: {
      costProfile: 'review.diff',
      thinkingLevel,
      thinkingBudget,
      responseSchema: AnalyzePrModelResponseSchema,
      maxOutputTokens,
      safetySettings,
    },
    responseBuilder: (_streamResult, textContent: string) => {
      const parsedOutput = parseAnalyzePrModelOutput(textContent);
      let finalSummary = parsedOutput.summary;
      const { documentationDrift, schemaWarnings } = parsedOutput;

      if (documentationDrift && documentationDrift.length > 0) {
        finalSummary = `⚠️ **Documentation Drift Detected**\n\nThe following documentation files may need updates based on this diff:\n${documentationDrift.map((d) => `- **${d.file}**: ${d.driftDescription} (Suggestion: ${d.suggestedUpdate})`).join('\n')}\n\n---\n\n${finalSummary}`;
      }

      return {
        resultMod: (_result: CallToolResult) => ({
          content: [{ type: 'text', text: finalSummary }],
        }),
        structuredContent: buildStructuredContent(
          snapshot,
          finalSummary,
          budgetedDiff.reviewedPaths,
          budgetedDiff.omittedPaths,
          budgetedDiff.truncated,
          documentationDrift,
          schemaWarnings,
        ),
        reportMessage: `${String(snapshot.stats.files)} files reviewed (+${String(snapshot.stats.additions)}, -${String(snapshot.stats.deletions)})`,
      };
    },
  });

  await tasks.phase('finalizing');
  if (!result.isError && result.structuredContent) {
    await tasks.finding({
      kind: 'finding-summary',
      data: result.structuredContent,
    });
  }

  return result;
}

function buildReviewStructuredContent(
  taskId: string | undefined,
  subjectKind: ReviewInput['subjectKind'],
  structured: Record<string, unknown>,
): z.infer<typeof ReviewOutputSchema> {
  return buildSuccessfulStructuredContent({
    requestId: taskId,
    domain: {
      subjectKind,
      summary: typeof structured.summary === 'string' ? structured.summary : '',
      schemaWarnings: Array.isArray(structured.schemaWarnings)
        ? structured.schemaWarnings.filter(
            (warning): warning is string => typeof warning === 'string',
          )
        : undefined,
      stats: structured.stats,
      reviewedPaths: structured.reviewedPaths,
      includedUntracked: structured.includedUntracked,
      skippedBinaryPaths: structured.skippedBinaryPaths,
      skippedLargePaths: structured.skippedLargePaths,
      skippedSensitivePaths: structured.skippedSensitivePaths,
      omittedPaths: structured.omittedPaths,
      empty: typeof structured.empty === 'boolean' ? structured.empty : undefined,
      truncated: typeof structured.truncated === 'boolean' ? structured.truncated : undefined,
      documentationDrift: structured.documentationDrift,
    },
    shared: structured,
  }) as unknown as z.infer<typeof ReviewOutputSchema>;
}

function requireReviewField(
  value: string | undefined,
  field: string,
  subjectKind: ReviewInput['subjectKind'],
): string {
  if (value) return value;
  throw new Error(`${field} is required when subjectKind=${subjectKind}.`);
}

export async function reviewWork(
  deps: ReviewWorkDeps,
  args: ReviewInput,
  ctx: ServerContext,
  services?: ToolServices,
): Promise<CallToolResult> {
  const compareWork = deps.compareWork;
  const rootsFetcher = deps.rootsFetcher;
  const runAnalyzePrWork = deps.analyzePrWork ?? analyzePrWork;
  const runDiagnoseFailureWork = deps.diagnoseFailureWork ?? diagnoseFailureWork;
  let result: CallToolResult;

  if (args.subjectKind === 'diff') {
    result = await runAnalyzePrWork(
      {
        subjectKind: 'diff',
        dryRun: args.dryRun,
        language: args.language,
        thinkingLevel: args.thinkingLevel,
        thinkingBudget: args.thinkingBudget,
        focus: args.focus,
        maxOutputTokens: args.maxOutputTokens,
        safetySettings: args.safetySettings,
      },
      ctx,
      rootsFetcher,
      undefined,
      services,
    );
  } else if (args.subjectKind === 'comparison') {
    const filePathA = requireReviewField(args.filePathA, 'filePathA', args.subjectKind);
    const filePathB = requireReviewField(args.filePathB, 'filePathB', args.subjectKind);

    result = await compareWork(
      {
        subjectKind: 'comparison',
        filePathA,
        filePathB,
        question: args.question ?? args.focus,
        thinkingLevel: args.thinkingLevel,
        thinkingBudget: args.thinkingBudget,
        maxOutputTokens: args.maxOutputTokens,
        safetySettings: args.safetySettings,
        tools: args.tools,
      },
      ctx,
    );
  } else {
    const error = requireReviewField(args.error, 'error', args.subjectKind);

    result = await runDiagnoseFailureWork(
      {
        error,
        codeContext: args.codeContext,
        language: args.language,
        maxOutputTokens: args.maxOutputTokens,
        thinkingBudget: args.thinkingBudget,
        safetySettings: args.safetySettings,
        tools: args.tools,
      },
      args.focus,
      args.thinkingLevel,
      ctx,
    );
  }

  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent ?? {};
  return createToolContext('review', ctx).validateOutput(
    ReviewOutputSchema,
    buildReviewStructuredContent(ctx.task?.id, args.subjectKind, structured),
    result,
  );
}

export function registerReviewTool(server: McpServer, services?: ToolServices): void {
  const resolvedServices = services ?? createDefaultToolServices();
  const compareWork = createCompareFileWork(resolvedServices.rootsFetcher);

  registerWorkTool<ReviewInput>({
    server,
    tool: {
      name: 'review',
      title: 'Review',
      description: 'Review a local diff, compare two files, or diagnose a failing change.',
      inputSchema: ReviewInputSchema,
      outputSchema: ReviewOutputSchema,
      annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    },
    work: (args, ctx) =>
      reviewWork(
        {
          compareWork,
          rootsFetcher: resolvedServices.rootsFetcher,
        },
        args,
        ctx,
        resolvedServices,
      ),
  });
}
