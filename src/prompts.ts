import type { McpServer } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { stat as fsStat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

import ignore, { type Ignore } from 'ignore';
import { z } from 'zod/v4';

import {
  buildServerRootsFetcher,
  getAllowedRoots,
  isPathWithinRoot,
  resolveWorkspacePath,
  type RootsFetcher,
} from './lib/validation.js';
import {
  optionalText,
  requiredText,
  withCurrentWorkspaceRoot,
  workspacePath,
} from './schemas/shared.js';

import { findWorkflowEntry, type WorkflowName } from './catalog.js';

const MAX_PROMPT_TEXT_LENGTH = 100_000;
const MAX_CONTEXT_TEXT_LENGTH = 10_000;

export const COMMON_LANGUAGES = [
  'python',
  'typescript',
  'javascript',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'swift',
  'kotlin',
  'php',
  'sql',
  'shell',
] as const;

export const SUMMARY_STYLES = ['brief', 'detailed', 'bullet-points'] as const;
export const PUBLIC_PROMPT_NAMES = [
  'analyze-file',
  'code-review',
  'summarize',
  'explain-error',
  'getting-started',
  'deep-research',
  'project-memory',
  'diff-review',
] as const;

type SummaryStyle = (typeof SUMMARY_STYLES)[number];
type PromptName = (typeof PUBLIC_PROMPT_NAMES)[number];
type PromptMessageResult = ReturnType<typeof userPromptMessage>;
type BuildMessageResult = PromptMessageResult | Promise<PromptMessageResult>;

interface PromptDefinition {
  name: PromptName;
  title: string;
  description: string;
  argsSchema?: z.ZodType;
  buildMessage: (args: Record<string, unknown>) => BuildMessageResult;
}

function definePrompt<Schema extends z.ZodType>(config: {
  name: PromptName;
  title: string;
  description: string;
  argsSchema: Schema;
  buildMessage: (args: z.infer<Schema>) => BuildMessageResult;
}): PromptDefinition;
function definePrompt(config: {
  name: PromptName;
  title: string;
  description: string;
  buildMessage: () => BuildMessageResult;
}): PromptDefinition;
function definePrompt(config: {
  name: PromptName;
  title: string;
  description: string;
  argsSchema?: z.ZodType;
  buildMessage: (args: never) => BuildMessageResult;
}): PromptDefinition {
  const { argsSchema, buildMessage, ...rest } = config;
  return {
    ...rest,
    ...(argsSchema ? { argsSchema } : {}),
    buildMessage: (args) => buildMessage(args as never),
  };
}

function promptText(description: string) {
  return requiredText(description, MAX_PROMPT_TEXT_LENGTH);
}

function optionalPromptText(description: string) {
  return optionalText(description, MAX_PROMPT_TEXT_LENGTH);
}

function completeByPrefix<T extends string>(
  values: readonly T[],
  transform: (value: string | undefined) => string = (value) => value ?? '',
): (value: string | undefined) => T[] {
  return (value) => {
    const prefix = transform(value);
    return values.filter((item) => item.startsWith(prefix));
  };
}

function userPromptMessage(text: string) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text,
        },
      },
    ],
  };
}

function toPortablePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function fencedCodeBlock(code: string, language?: string): string {
  return `\`\`\`${language ?? ''}\n${code}\n\`\`\``;
}

function summarizeConstraint(style: SummaryStyle | undefined): string {
  switch (style) {
    case 'brief':
      return ' Maximum 3 sentences.';
    case 'bullet-points':
      return ' Use dash-prefixed bullets, one per key point.';
    default:
      return '';
  }
}

function renderWorkflowSection(name: WorkflowName): string {
  const workflow = findWorkflowEntry(name);
  if (!workflow) {
    throw new Error(`Unknown workflow: ${name}`);
  }

  return [
    `Workflow: \`${workflow.name}\``,
    `Goal: ${workflow.goal}`,
    `When to use: ${workflow.whenToUse}`,
    `Steps:\n${workflow.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
    `Recommended tools: ${workflow.recommendedTools.map((tool) => `\`${tool}\``).join(', ')}`,
    `Recommended prompts: ${workflow.recommendedPrompts.map((prompt) => `\`${prompt}\``).join(', ')}`,
    `Related resources: ${workflow.relatedResources.map((resource) => `\`${resource}\``).join(', ')}`,
  ].join('\n\n');
}

const completeLanguage = completeByPrefix(COMMON_LANGUAGES, (value) => value?.toLowerCase() ?? '');
const completeSummaryStyle = completeByPrefix(SUMMARY_STYLES);

export function createAnalyzeFilePromptSchema(rootsFetcher: RootsFetcher) {
  return z.strictObject({
    filePath: completable(
      workspacePath('Path to the file to analyze, either absolute or workspace-relative.'),
      buildPathAcFetcher(rootsFetcher),
    ),
    question: promptText('Your question or analysis request about the file'),
  });
}

export const CodeReviewPromptSchema = z.strictObject({
  code: promptText('The code to review'),
  language: completable(optionalPromptText('Programming language of the code'), completeLanguage),
});

export const SummarizePromptSchema = z.strictObject({
  text: promptText('The text to summarize'),
  style: completable(
    z.enum(SUMMARY_STYLES).describe('Summary style').optional(),
    completeSummaryStyle,
  ),
});

export const ExplainErrorPromptSchema = z.strictObject({
  error: promptText('The error message or stack trace'),
  context: optionalText('Additional context about what was being done', MAX_CONTEXT_TEXT_LENGTH),
});

export const GettingStartedPromptSchema = z.strictObject({});

export const DeepResearchPromptSchema = z.strictObject({
  topic: promptText('Topic or question to research'),
  deliverable: optionalPromptText('Optional requested output format or deliverable'),
});

export const ProjectMemoryPromptSchema = z.strictObject({
  project: optionalPromptText('Optional project or codebase label'),
  currentTask: optionalPromptText(
    'Optional current task that should influence cache/session advice',
  ),
});

export const DiffReviewPromptSchema = z.strictObject({
  focus: optionalPromptText('Optional review focus, such as tests, performance, or regressions'),
});

async function buildAnalyzeFilePrompt(
  args: z.infer<ReturnType<typeof createAnalyzeFilePromptSchema>>,
  rootsFetcher: RootsFetcher,
) {
  const { displayPath } = await resolveWorkspacePath(args.filePath, rootsFetcher);
  return userPromptMessage(`File: ${displayPath}\nQ: ${args.question}\nUse only file content.`);
}

function buildCodeReviewPrompt(args: z.infer<typeof CodeReviewPromptSchema>) {
  return userPromptMessage(
    `Review this${args.language ? ` ${args.language}` : ''} code.\n\n${fencedCodeBlock(args.code, args.language)}\n\nOutput:\n1. Bugs\n2. Improvements\nBe actionable.`,
  );
}

function buildSummarizePrompt(args: z.infer<typeof SummarizePromptSchema>) {
  return userPromptMessage(
    `Summarize${args.style ? ` (${args.style})` : ''}:\n\n${args.text}\n\nReturn only the summary.${summarizeConstraint(args.style)}`,
  );
}

function buildExplainErrorPrompt(args: z.infer<typeof ExplainErrorPromptSchema>) {
  return userPromptMessage(
    `${args.context ? `Context: ${args.context}\n\n` : ''}Error:\n${args.error}\n\nOutput:\n1. Cause\n2. Fix\n3. Prevention`,
  );
}

export function buildGettingStartedPrompt() {
  return userPromptMessage(
    [
      'Help a first-time user understand gemini-assistant and what to try first.',
      renderWorkflowSection('getting-started'),
      'Be practical. Say what to try first, what it returns, and what to inspect next.',
    ].join('\n\n'),
  );
}

export function buildDeepResearchPrompt(args: z.infer<typeof DeepResearchPromptSchema>) {
  return userPromptMessage(
    [
      `Research topic: ${args.topic}`,
      ...(args.deliverable ? [`Requested deliverable: ${args.deliverable}`] : []),
      renderWorkflowSection('deep-research'),
      'Explain the path and expected grounded result.',
    ].join('\n\n'),
  );
}

export function buildProjectMemoryPrompt(args: z.infer<typeof ProjectMemoryPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.project ? [`Project: ${args.project}`] : []),
      ...(args.currentTask ? [`Current task: ${args.currentTask}`] : []),
      renderWorkflowSection('project-memory'),
      'Explain when to use a session vs a cache. Mention transcript and event inspection.',
    ].join('\n\n'),
  );
}

export function buildDiffReviewPrompt(args: z.infer<typeof DiffReviewPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.focus ? [`Review focus: ${args.focus}`] : []),
      renderWorkflowSection('diff-review'),
      'Explain when to use repo review, file compare, or error diagnosis.',
    ].join('\n\n'),
  );
}

export function createPromptDefinitions(rootsFetcher: RootsFetcher): PromptDefinition[] {
  const analyzeFileSchema = createAnalyzeFilePromptSchema(rootsFetcher);

  return [
    definePrompt({
      name: 'analyze-file',
      title: 'Analyze File',
      description: withCurrentWorkspaceRoot('Analyze a specific file with a custom question.'),
      argsSchema: analyzeFileSchema,
      buildMessage: (args) => buildAnalyzeFilePrompt(args, rootsFetcher),
    }),
    definePrompt({
      name: 'code-review',
      title: 'Code Review',
      description: 'Review code for bugs, best practices, and potential improvements.',
      argsSchema: CodeReviewPromptSchema,
      buildMessage: buildCodeReviewPrompt,
    }),
    definePrompt({
      name: 'summarize',
      title: 'Summarize Text',
      description: 'Condense text into a concise summary.',
      argsSchema: SummarizePromptSchema,
      buildMessage: buildSummarizePrompt,
    }),
    definePrompt({
      name: 'explain-error',
      title: 'Explain Error',
      description: 'Explain an error message and suggest fixes.',
      argsSchema: ExplainErrorPromptSchema,
      buildMessage: buildExplainErrorPrompt,
    }),
    definePrompt({
      name: 'getting-started',
      title: 'Getting Started',
      description: 'Guide a first-time user through the recommended MCP onboarding path.',
      argsSchema: GettingStartedPromptSchema,
      buildMessage: () => buildGettingStartedPrompt(),
    }),
    definePrompt({
      name: 'deep-research',
      title: 'Deep Research',
      description: 'Guide a grounded research workflow with the recommended tools and resources.',
      argsSchema: DeepResearchPromptSchema,
      buildMessage: buildDeepResearchPrompt,
    }),
    definePrompt({
      name: 'project-memory',
      title: 'Project Memory',
      description: 'Explain when to use sessions, caches, and transcript inspection together.',
      argsSchema: ProjectMemoryPromptSchema,
      buildMessage: buildProjectMemoryPrompt,
    }),
    definePrompt({
      name: 'diff-review',
      title: 'Diff Review',
      description: 'Guide a local diff review workflow without adding remote integrations.',
      argsSchema: DiffReviewPromptSchema,
      buildMessage: buildDiffReviewPrompt,
    }),
  ];
}

function buildPathAcFetcher(rootsFetcher: RootsFetcher) {
  return async (value: string | undefined): Promise<string[]> => {
    try {
      const allowedRoots = await getAllowedRoots(rootsFetcher);
      const clientRoots = await rootsFetcher().catch(() => []);
      const workspaceRoots =
        clientRoots.length > 0
          ? clientRoots.map((root) => normalize(root)).filter(Boolean)
          : [normalize(process.cwd())];
      const rawValue = value ?? '';

      if (!rawValue) {
        const suggestions = await collectRelativePathSuggestions('', workspaceRoots, allowedRoots);
        return suggestions.length > 0 ? suggestions : workspaceRoots.map(toPortablePath);
      }

      if (isAbsolute(rawValue)) {
        return await collectAbsolutePathSuggestions(rawValue, allowedRoots, workspaceRoots);
      }

      return await collectRelativePathSuggestions(rawValue, workspaceRoots, allowedRoots);
    } catch {
      return [];
    }
  };
}

interface GitignoreCacheEntry {
  matcher: Ignore | null;
  mtimeMs: number;
}

const gitignoreCache = new Map<string, GitignoreCacheEntry>();

async function loadGitignoreMatcher(root: string): Promise<Ignore | null> {
  const gitignorePath = join(root, '.gitignore');
  try {
    const info = await fsStat(gitignorePath);
    const cached = gitignoreCache.get(root);
    if (cached?.mtimeMs === info.mtimeMs) return cached.matcher;
    const content = await readFile(gitignorePath, 'utf-8');
    const matcher = ignore().add(content).add('.git');
    gitignoreCache.set(root, { matcher, mtimeMs: info.mtimeMs });
    return matcher;
  } catch {
    gitignoreCache.set(root, { matcher: null, mtimeMs: 0 });
    return null;
  }
}

function isIgnored(matcher: Ignore | null, relativePath: string, isDirectory: boolean): boolean {
  if (!matcher || !relativePath) return false;
  // `ignore` requires a trailing slash hint for directories so rules like
  // `node_modules/` match correctly.
  const candidate = isDirectory ? `${relativePath}/` : relativePath;
  return matcher.ignores(candidate);
}

function pickContainingRoot(target: string, roots: readonly string[]): string | undefined {
  return roots.find((root) => isPathWithinRoot(target, root));
}

async function collectAbsolutePathSuggestions(
  rawValue: string,
  allowedRoots: string[],
  workspaceRoots: readonly string[],
): Promise<string[]> {
  const normalized = normalize(rawValue);
  const targetDir =
    rawValue.endsWith('/') || rawValue.endsWith('\\') ? normalized : dirname(normalized);
  const targetPrefix =
    rawValue.endsWith('/') || rawValue.endsWith('\\') ? '' : basename(normalized);

  const isAllowed = allowedRoots.some((root) => isPathWithinRoot(targetDir, root));
  if (!isAllowed) {
    return allowedRoots
      .filter((root) => root.toLowerCase().startsWith(normalized.toLowerCase()))
      .map(toPortablePath);
  }

  const containingWorkspaceRoot = pickContainingRoot(targetDir, workspaceRoots);
  const matcher = containingWorkspaceRoot
    ? await loadGitignoreMatcher(containingWorkspaceRoot)
    : null;

  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      if (targetPrefix && !entry.name.toLowerCase().startsWith(targetPrefix.toLowerCase())) {
        continue;
      }
      const absolutePath = join(targetDir, entry.name);
      if (containingWorkspaceRoot) {
        const relativePath = toPortablePath(relative(containingWorkspaceRoot, absolutePath));
        if (isIgnored(matcher, relativePath, entry.isDirectory())) continue;
      }
      results.push(toPortablePath(absolutePath) + (entry.isDirectory() ? '/' : ''));
      if (results.length >= 50) break;
    }
    return results;
  } catch {
    return allowedRoots
      .filter((root) => root.toLowerCase().startsWith(normalized.toLowerCase()))
      .map(toPortablePath);
  }
}

async function collectRelativePathSuggestions(
  rawValue: string,
  workspaceRoots: string[],
  allowedRoots: string[],
): Promise<string[]> {
  const normalized = rawValue ? normalize(rawValue) : '';
  const hasTrailingSeparator = /[\\/]$/.test(rawValue);
  const relativeDir =
    !normalized || normalized === '.'
      ? ''
      : hasTrailingSeparator
        ? normalized
        : dirname(normalized) === '.'
          ? ''
          : dirname(normalized);
  const targetPrefix =
    !normalized || normalized === '.' ? '' : hasTrailingSeparator ? '' : basename(normalized);

  const suggestions = new Set<string>();

  for (const workspaceRoot of workspaceRoots) {
    const targetDir = resolve(workspaceRoot, relativeDir || '.');
    if (!isPathWithinRoot(targetDir, workspaceRoot)) continue;
    if (!allowedRoots.some((root) => isPathWithinRoot(targetDir, root))) continue;

    const matcher = await loadGitignoreMatcher(workspaceRoot);

    try {
      const entries = await readdir(targetDir, { withFileTypes: true });
      for (const entry of entries) {
        if (targetPrefix && !entry.name.toLowerCase().startsWith(targetPrefix.toLowerCase())) {
          continue;
        }

        const relativePath = toPortablePath(relative(workspaceRoot, join(targetDir, entry.name)));
        if (isIgnored(matcher, relativePath, entry.isDirectory())) continue;
        suggestions.add(relativePath + (entry.isDirectory() ? '/' : ''));
        if (suggestions.size >= 50) {
          return [...suggestions];
        }
      }
    } catch {
      continue;
    }
  }

  return [...suggestions];
}

export function registerPrompts(server: McpServer, rootsFetcher?: RootsFetcher): void {
  const fetcher = rootsFetcher ?? buildServerRootsFetcher(server);

  for (const definition of createPromptDefinitions(fetcher)) {
    server.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        ...(definition.argsSchema ? { argsSchema: definition.argsSchema } : {}),
      },
      (args) => definition.buildMessage((args ?? {}) as Record<string, unknown>),
    );
  }
}
