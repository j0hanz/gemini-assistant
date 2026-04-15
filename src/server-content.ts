import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { completable, ResourceTemplate } from '@modelcontextprotocol/server';

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, sep } from 'node:path';

import { z } from 'zod/v4';

import { formatError } from './lib/errors.js';
import {
  buildServerRootsFetcher,
  getAllowedRoots,
  isPathWithinRoot,
  type RootsFetcher,
} from './lib/validation.js';

import { findWorkflowEntry, listDiscoveryEntries, listWorkflowEntries } from './catalog.js';
import { completeCacheNames, getCacheSummary, listCacheSummaries } from './client.js';
import {
  completeSessionIds,
  getSessionEntry,
  listSessionEntries,
  listSessionTranscriptEntries,
} from './sessions.js';

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
export const PUBLIC_RESOURCE_URIS = [
  'sessions://list',
  'sessions://{sessionId}',
  'sessions://{sessionId}/transcript',
  'caches://list',
  'caches://{cacheName}',
  'tools://list',
  'workflows://list',
] as const;

type SummaryStyle = (typeof SUMMARY_STYLES)[number];

interface ResourceListEntry {
  uri: string;
  name: string;
}

export interface PromptDefinition {
  name: (typeof PUBLIC_PROMPT_NAMES)[number];
  title: string;
  description: string;
  argsSchema?: z.ZodType;
  buildMessage: (args: Record<string, unknown>) => ReturnType<typeof userPromptMessage>;
}

const SESSION_LIST_RESOURCE: ResourceListEntry = {
  uri: 'sessions://list',
  name: 'List of active multi-turn chat session IDs',
};

const CACHE_LIST_RESOURCE: ResourceListEntry = {
  uri: 'caches://list',
  name: 'List of active Gemini context caches',
};

const TOOLS_LIST_RESOURCE: ResourceListEntry = {
  uri: 'tools://list',
  name: 'Discovery catalog for tools, prompts, and resources',
};

const WORKFLOWS_LIST_RESOURCE: ResourceListEntry = {
  uri: 'workflows://list',
  name: 'Guided workflows for common gemini-assistant jobs',
};

function promptText(description: string) {
  return z.string().max(MAX_PROMPT_TEXT_LENGTH).describe(description);
}

function optionalPromptText(description: string) {
  return promptText(description).optional();
}

function contextText(description: string) {
  return z.string().max(MAX_CONTEXT_TEXT_LENGTH).optional().describe(description);
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

function jsonResource(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        text: JSON.stringify(data),
      },
    ],
  };
}

function resourceList(resources: ResourceListEntry[]) {
  return {
    list: () => ({ resources }),
  };
}

function singleResource(resource: ResourceListEntry) {
  return resourceList([resource]);
}

function normalizeTemplateParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asyncJsonResource(
  load: () => Promise<unknown>,
  mapError: (err: unknown) => unknown,
): (uri: URL) => Promise<ReadResourceResult> {
  return async (uri) => {
    try {
      return jsonResource(uri.href, await load());
    } catch (err) {
      return jsonResource(uri.href, mapError(err));
    }
  };
}

function toResourceUri(uri: URL | string): string {
  return typeof uri === 'string' ? uri : uri.href;
}

const completeLanguage = completeByPrefix(COMMON_LANGUAGES, (value) => value?.toLowerCase() ?? '');
const completeSummaryStyle = completeByPrefix(SUMMARY_STYLES);

export function createAnalyzeFilePromptSchema(rootsFetcher: RootsFetcher) {
  return z.object({
    filePath: completable(
      promptText('Absolute path to the file to analyze from workspace roots'),
      buildPathAcFetcher(rootsFetcher),
    ),
    question: promptText('Your question or analysis request about the file'),
  });
}

export const CodeReviewPromptSchema = z.object({
  code: promptText('The code to review'),
  language: completable(optionalPromptText('Programming language of the code'), completeLanguage),
});

export const SummarizePromptSchema = z.object({
  text: promptText('The text to summarize'),
  style: completable(
    z.enum(SUMMARY_STYLES).optional().describe('Summary style'),
    completeSummaryStyle,
  ),
});

export const ExplainErrorPromptSchema = z.object({
  error: promptText('The error message or stack trace'),
  context: contextText('Additional context about what was being done'),
});

export const GettingStartedPromptSchema = z.object({});

export const DeepResearchPromptSchema = z.object({
  topic: promptText('Topic or question to research'),
  deliverable: optionalPromptText('Optional requested output format or deliverable'),
});

export const ProjectMemoryPromptSchema = z.object({
  project: optionalPromptText('Optional project or codebase label'),
  currentTask: optionalPromptText(
    'Optional current task that should influence cache/session advice',
  ),
});

export const DiffReviewPromptSchema = z.object({
  focus: optionalPromptText('Optional review focus, such as tests, performance, or regressions'),
});

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

export function buildAnalyzeFilePrompt(
  args: z.infer<ReturnType<typeof createAnalyzeFilePromptSchema>>,
) {
  return userPromptMessage(
    `Please analyze this file: ${args.filePath}\n\nQuestion: ${args.question}\n\nRead the file context and answer the question.`,
  );
}

export function buildCodeReviewPrompt(args: z.infer<typeof CodeReviewPromptSchema>) {
  return userPromptMessage(
    `Review this${args.language ? ` ${args.language}` : ''} code.\n\n${fencedCodeBlock(args.code, args.language)}\n\nStructure: 1) Bugs 2) Best practices 3) Improvements. Focus on actionable findings only.`,
  );
}

export function buildSummarizePrompt(args: z.infer<typeof SummarizePromptSchema>) {
  return userPromptMessage(
    `Summarize this text${args.style ? ` (${args.style})` : ''}:\n\n${args.text}\n\nReturn only the summary.${summarizeConstraint(args.style)}`,
  );
}

export function buildExplainErrorPrompt(args: z.infer<typeof ExplainErrorPromptSchema>) {
  return userPromptMessage(
    `Explain this error${args.context ? ` (context: ${args.context})` : ''}:\n\n${args.error}\n\nStructure: 1) Root cause 2) Fix 3) Prevention.`,
  );
}

export function buildGettingStartedPrompt() {
  return userPromptMessage(
    [
      'Help a first-time user understand gemini-assistant and what to try first.',
      renderWorkflowSection('getting-started'),
      'Keep the guidance practical. Name the first tool or prompt to try, what result shape to expect, and which discovery resource to inspect next.',
    ].join('\n\n'),
  );
}

export function buildDeepResearchPrompt(args: z.infer<typeof DeepResearchPromptSchema>) {
  return userPromptMessage(
    [
      `Research topic: ${args.topic}`,
      ...(args.deliverable ? [`Requested deliverable: ${args.deliverable}`] : []),
      renderWorkflowSection('deep-research'),
      'Explain how to use the recommended tools and resources for this research job, and state what kind of grounded result the user should expect.',
    ].join('\n\n'),
  );
}

export function buildProjectMemoryPrompt(args: z.infer<typeof ProjectMemoryPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.project ? [`Project: ${args.project}`] : []),
      ...(args.currentTask ? [`Current task: ${args.currentTask}`] : []),
      renderWorkflowSection('project-memory'),
      'Explain when to keep work in a live session versus a reusable cache, and mention how the transcript resource helps inspect an active conversation.',
    ].join('\n\n'),
  );
}

export function buildDiffReviewPrompt(args: z.infer<typeof DiffReviewPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.focus ? [`Review focus: ${args.focus}`] : []),
      renderWorkflowSection('diff-review'),
      'Explain how to review local changes with the recommended tools, including when to escalate from repo-wide review to targeted file comparison or error diagnosis.',
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

function sessionDetailResources(): ResourceListEntry[] {
  return listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}`,
    name: `Session ${session.id}`,
  }));
}

function sessionTranscriptResources(): ResourceListEntry[] {
  return listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}/transcript`,
    name: `Transcript ${session.id}`,
  }));
}

function cacheDetailResources(
  caches: Awaited<ReturnType<typeof listCacheSummaries>>,
): ResourceListEntry[] {
  return caches
    .filter((cache): cache is typeof cache & { name: string } => typeof cache.name === 'string')
    .map((cache) => ({
      uri: `caches://${encodeURIComponent(cache.name)}`,
      name: cache.displayName ?? cache.name,
    }));
}

export function readToolsListResource(
  uri: URL | string = TOOLS_LIST_RESOURCE.uri,
): ReadResourceResult {
  return jsonResource(toResourceUri(uri), listDiscoveryEntries());
}

export function readWorkflowsListResource(
  uri: URL | string = WORKFLOWS_LIST_RESOURCE.uri,
): ReadResourceResult {
  return jsonResource(toResourceUri(uri), listWorkflowEntries());
}

export function getSessionTranscriptResourceData(sessionId: string | undefined) {
  if (!sessionId) {
    return { error: 'Session not found' } as const;
  }

  const transcript = listSessionTranscriptEntries(sessionId);
  return transcript ?? ({ error: 'Session not found' } as const);
}

export function readSessionTranscriptResource(
  uri: URL | string,
  sessionId: string | string[] | undefined,
): ReadResourceResult {
  return jsonResource(
    toResourceUri(uri),
    getSessionTranscriptResourceData(normalizeTemplateParam(sessionId)),
  );
}

function registerSessionResources(server: McpServer): void {
  server.registerResource(
    'sessions',
    new ResourceTemplate('sessions://list', singleResource(SESSION_LIST_RESOURCE)),
    {
      title: 'Active Chat Sessions',
      description: 'List of active multi-turn chat session IDs and their last access time.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => jsonResource(uri.href, listSessionEntries()),
  );

  server.registerResource(
    'session-detail',
    new ResourceTemplate('sessions://{sessionId}', {
      list: () => ({ resources: sessionDetailResources() }),
      complete: {
        sessionId: completeSessionIds,
      },
    }),
    {
      title: 'Chat Session Detail',
      description: 'Metadata for a single chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult => {
      const id = normalizeTemplateParam(sessionId);
      const entry = id ? getSessionEntry(id) : undefined;
      return jsonResource(uri.href, entry ?? { error: 'Session not found' });
    },
  );

  server.registerResource(
    'session-transcript',
    new ResourceTemplate('sessions://{sessionId}/transcript', {
      list: () => ({ resources: sessionTranscriptResources() }),
      complete: {
        sessionId: completeSessionIds,
      },
    }),
    {
      title: 'Chat Session Transcript',
      description: 'Transcript entries for a single active chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult => readSessionTranscriptResource(uri, sessionId),
  );
}

function registerCacheResources(server: McpServer): void {
  server.registerResource(
    'caches',
    new ResourceTemplate('caches://list', singleResource(CACHE_LIST_RESOURCE)),
    {
      title: 'Gemini Context Caches',
      description: 'List of active Gemini context caches with name, model, and expiry.',
      mimeType: 'application/json',
    },
    asyncJsonResource(
      () => listCacheSummaries(),
      (err) => ({
        error: `Failed to list caches: ${formatError(err)}`,
      }),
    ),
  );

  server.registerResource(
    'cache-detail',
    new ResourceTemplate('caches://{cacheName}', {
      list: async () => {
        try {
          return { resources: cacheDetailResources(await listCacheSummaries()) };
        } catch {
          return { resources: [] };
        }
      },
      complete: {
        cacheName: completeCacheNames,
      },
    }),
    {
      title: 'Cache Detail',
      description: 'Full detail for a single Gemini context cache including token count.',
      mimeType: 'application/json',
    },
    async (uri, { cacheName }) => {
      const name = normalizeTemplateParam(cacheName);
      if (!name) return jsonResource(uri.href, { error: 'Cache name required' });
      const decoded = decodeURIComponent(name);
      try {
        return jsonResource(uri.href, await getCacheSummary(decoded));
      } catch (err) {
        return jsonResource(uri.href, {
          error: `Failed to get cache: ${formatError(err)}`,
        });
      }
    },
  );
}

function registerDiscoveryResources(server: McpServer): void {
  server.registerResource(
    'tools-list',
    new ResourceTemplate('tools://list', singleResource(TOOLS_LIST_RESOURCE)),
    {
      title: 'Discovery Catalog',
      description: 'Machine-readable catalog of public tools, prompts, and resources.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => readToolsListResource(uri),
  );

  server.registerResource(
    'workflows-list',
    new ResourceTemplate('workflows://list', singleResource(WORKFLOWS_LIST_RESOURCE)),
    {
      title: 'Workflow Catalog',
      description: 'Machine-readable catalog of guided workflows for gemini-assistant.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => readWorkflowsListResource(uri),
  );
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

export function registerResources(server: McpServer): void {
  registerSessionResources(server);
  registerCacheResources(server);
  registerDiscoveryResources(server);
}
