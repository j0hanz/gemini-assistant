import type { McpServer } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, sep } from 'node:path';

import { z } from 'zod/v4';

import {
  buildServerRootsFetcher,
  getAllowedRoots,
  isPathWithinRoot,
  type RootsFetcher,
} from './lib/validation.js';
import { absolutePath, optionalText, requiredText } from './schemas/shared.js';

import { findWorkflowEntry } from './catalog.js';

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

interface PromptDefinition {
  name: PromptName;
  title: string;
  description: string;
  argsSchema?: z.ZodType;
  buildMessage: (args: Record<string, unknown>) => ReturnType<typeof userPromptMessage>;
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

function renderWorkflowSection(name: string): string {
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
      absolutePath('Absolute path to the file to analyze from workspace roots'),
      buildPathAcFetcher(rootsFetcher),
    ),
    question: promptText('Your question or analysis request about the file'),
  });
}

export const CodeReviewPromptSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(MAX_PROMPT_TEXT_LENGTH)
    .refine((val) => val.trim().length > 0, { error: 'Code must not be blank' })
    .describe('The code to review'),
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
  error: z
    .string()
    .min(1)
    .max(MAX_PROMPT_TEXT_LENGTH)
    .refine((val) => val.trim().length > 0, { error: 'Error must not be blank' })
    .describe('The error message or stack trace'),
  context: z
    .string()
    .min(1)
    .max(MAX_CONTEXT_TEXT_LENGTH)
    .refine((val) => val.trim().length > 0, { error: 'Context must not be blank' })
    .optional()
    .describe('Additional context about what was being done'),
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

function buildAnalyzeFilePrompt(args: z.infer<ReturnType<typeof createAnalyzeFilePromptSchema>>) {
  return userPromptMessage(`File: ${args.filePath}\nQ: ${args.question}\nUse only file content.`);
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
    {
      name: 'analyze-file',
      title: 'Analyze File',
      description: 'Analyze a specific file with a custom question.',
      argsSchema: analyzeFileSchema,
      buildMessage: (args) =>
        buildAnalyzeFilePrompt(args as z.infer<ReturnType<typeof createAnalyzeFilePromptSchema>>),
    },
    {
      name: 'code-review',
      title: 'Code Review',
      description: 'Review code for bugs, best practices, and potential improvements.',
      argsSchema: CodeReviewPromptSchema,
      buildMessage: (args) => buildCodeReviewPrompt(args as z.infer<typeof CodeReviewPromptSchema>),
    },
    {
      name: 'summarize',
      title: 'Summarize Text',
      description: 'Condense text into a concise summary.',
      argsSchema: SummarizePromptSchema,
      buildMessage: (args) => buildSummarizePrompt(args as z.infer<typeof SummarizePromptSchema>),
    },
    {
      name: 'explain-error',
      title: 'Explain Error',
      description: 'Explain an error message and suggest fixes.',
      argsSchema: ExplainErrorPromptSchema,
      buildMessage: (args) =>
        buildExplainErrorPrompt(args as z.infer<typeof ExplainErrorPromptSchema>),
    },
    {
      name: 'getting-started',
      title: 'Getting Started',
      description: 'Guide a first-time user through the recommended MCP onboarding path.',
      argsSchema: GettingStartedPromptSchema,
      buildMessage: () => buildGettingStartedPrompt(),
    },
    {
      name: 'deep-research',
      title: 'Deep Research',
      description: 'Guide a grounded research workflow with the recommended tools and resources.',
      argsSchema: DeepResearchPromptSchema,
      buildMessage: (args) =>
        buildDeepResearchPrompt(args as z.infer<typeof DeepResearchPromptSchema>),
    },
    {
      name: 'project-memory',
      title: 'Project Memory',
      description: 'Explain when to use sessions, caches, and transcript inspection together.',
      argsSchema: ProjectMemoryPromptSchema,
      buildMessage: (args) =>
        buildProjectMemoryPrompt(args as z.infer<typeof ProjectMemoryPromptSchema>),
    },
    {
      name: 'diff-review',
      title: 'Diff Review',
      description: 'Guide a local diff review workflow without adding remote integrations.',
      argsSchema: DiffReviewPromptSchema,
      buildMessage: (args) => buildDiffReviewPrompt(args as z.infer<typeof DiffReviewPromptSchema>),
    },
  ];
}

function buildPathAcFetcher(rootsFetcher: RootsFetcher) {
  return async (value: string | undefined): Promise<string[]> => {
    try {
      const allowedRoots = await getAllowedRoots(rootsFetcher);
      const rawValue = value ?? '';

      if (!rawValue) {
        return allowedRoots;
      }

      const normalized = normalize(rawValue);
      let targetDir = normalized;
      let targetPrefix = '';

      try {
        const stats = await stat(normalized);
        if (stats.isDirectory()) {
          targetDir = normalized;
        } else {
          targetDir = dirname(normalized);
          targetPrefix = basename(normalized);
        }
      } catch {
        targetDir = dirname(normalized);
        targetPrefix = basename(normalized);
      }

      const isAllowed = allowedRoots.some((root) => isPathWithinRoot(targetDir, root));

      if (!isAllowed) {
        return allowedRoots.filter((root) =>
          root.toLowerCase().startsWith(normalized.toLowerCase()),
        );
      }

      try {
        const entries = await readdir(targetDir, { withFileTypes: true });
        return entries
          .filter(
            (entry) =>
              !targetPrefix || entry.name.toLowerCase().startsWith(targetPrefix.toLowerCase()),
          )
          .map((entry) => join(targetDir, entry.name) + (entry.isDirectory() ? sep : ''))
          .slice(0, 50);
      } catch {
        return allowedRoots.filter((root) =>
          root.toLowerCase().startsWith(normalized.toLowerCase()),
        );
      }
    } catch {
      return [];
    }
  };
}

export function registerPrompts(server: McpServer): void {
  const rootsFetcher = buildServerRootsFetcher(server);

  for (const definition of createPromptDefinitions(rootsFetcher)) {
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
