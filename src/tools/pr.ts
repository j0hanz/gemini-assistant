import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { errorResult, sendProgress } from '../lib/errors.js';
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

const NOISY_EXCLUDE_PATHSPECS = [
  ':!package-lock.json',
  ':!yarn.lock',
  ':!pnpm-lock.yaml',
  ':!*.lock',
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

type DiffMode = 'unstaged' | 'staged';

interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

// Single-slot diff storage — always overwritten on each tool call
let currentDiff: string | undefined;

export function getCurrentDiff(): string | undefined {
  return currentDiff;
}

function computeDiffStats(diff: string): DiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  return { files, additions, deletions };
}

function buildGitDiffArgs(mode: DiffMode): string[] {
  // '--' separates flags from pathspecs to prevent flag injection
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (mode === 'staged') args.push('--cached');
  args.push('--', ...NOISY_EXCLUDE_PATHSPECS);
  return args;
}

async function findGitRoot(signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return stdout.trim();
}

async function generateDiff(mode: DiffMode, signal?: AbortSignal): Promise<string> {
  const gitRoot = await findGitRoot(signal);
  const { stdout } = await execFileAsync('git', buildGitDiffArgs(mode), {
    cwd: gitRoot,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return {
    diff: diff.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated due to size ...]',
    truncated: true,
  };
}

function describeModeHint(mode: DiffMode): string {
  return mode === 'staged' ? 'staged with git add' : 'modified but not yet staged';
}

function formatGitError(err: unknown): string {
  const gitErr = err as Error & { code?: number | string; stderr?: string };
  if (typeof gitErr.code === 'number') {
    const stderr = gitErr.stderr?.trim() ?? 'unknown error';
    return `git exited with code ${String(gitErr.code)}: ${stderr}`;
  }
  return `Failed to run git: ${gitErr.message}. Ensure git is installed.`;
}

function buildAnalysisPrompt(
  diff: string,
  mode: DiffMode,
  stats: DiffStats,
  language?: string,
): string {
  const parts = [
    `## Git Diff (${mode})`,
    `Files: ${String(stats.files)} | +${String(stats.additions)} -${String(stats.deletions)}`,
    ...(language ? [`Language: ${language}`] : []),
    '',
    '```diff',
    diff,
    '```',
  ];
  return parts.join('\n');
}

async function analyzePrWork(
  { mode, thinkingLevel, language }: AnalyzePrInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  // Step 1: Generate diff
  await sendProgress(ctx, 0, 3, `${TOOL_LABEL}: Generating ${mode} diff`);

  let rawDiff: string;
  try {
    rawDiff = await generateDiff(mode, ctx.mcpReq.signal);
  } catch (err) {
    return errorResult(`${TOOL_LABEL}: ${formatGitError(err)}`);
  }

  if (!rawDiff.trim()) {
    return errorResult(
      `No ${mode} changes found. Ensure you have changes that are ${describeModeHint(mode)}.`,
    );
  }

  // Overwrite stored diff — single slot, always replaced
  currentDiff = rawDiff;

  const stats = computeDiffStats(rawDiff);
  const { diff, truncated } = truncateDiff(rawDiff);

  await sendProgress(
    ctx,
    1,
    3,
    `${TOOL_LABEL}: ${String(stats.files)} files (+${String(stats.additions)}, -${String(stats.deletions)})`,
  );

  // Step 2: Analyze with Gemini
  await sendProgress(ctx, 2, 3, `${TOOL_LABEL}: Analyzing changes`);
  await ctx.mcpReq.log(
    'info',
    `analyze_pr: ${String(stats.files)} files, +${String(stats.additions)}/-${String(stats.deletions)}${truncated ? ' (truncated)' : ''}`,
  );

  const prompt = buildAnalysisPrompt(diff, mode, stats, language);

  return await handleToolExecution(
    ctx,
    'analyze_pr',
    TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt,
        config: buildGenerateContentConfig(
          {
            systemInstruction: SYSTEM_INSTRUCTION,
            thinkingLevel: thinkingLevel ?? 'HIGH',
          },
          ctx.mcpReq.signal,
        ),
      }),
    (_streamResult, textContent) => ({
      structuredContent: {
        analysis: textContent || '',
        stats,
        mode,
      },
      reportMessage: `${String(stats.files)} files reviewed (+${String(stats.additions)}, -${String(stats.deletions)})`,
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
        'Generate a git diff and analyze it with Gemini in one step. ' +
        'Always overwrites the previous diff. ' +
        'Use "unstaged" for working-tree changes, "staged" for indexed changes.',
      inputSchema: AnalyzePrInputSchema,
      outputSchema: AnalyzePrOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    analyzePrWork,
  );
}
