import type { McpServer } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { goalText, optionalText, PublicJobNameSchema } from './schemas/fields.js';

import { findWorkflowEntry } from './catalog.js';
import type { PublicPromptName, PublicWorkflowName } from './public-contract.js';

export { PUBLIC_PROMPT_NAMES } from './public-contract.js';

type PromptMessageResult = ReturnType<typeof userPromptMessage>;
type BuildMessageResult = PromptMessageResult | Promise<PromptMessageResult>;

interface PromptDefinition {
  name: PublicPromptName;
  title: string;
  description: string;
  argsSchema?: z.ZodType;
  buildMessage: (args: Record<string, unknown>) => BuildMessageResult;
}

function definePrompt<Schema extends z.ZodType>(config: {
  name: PublicPromptName;
  title: string;
  description: string;
  argsSchema: Schema;
  buildMessage: (args: z.infer<Schema>) => BuildMessageResult;
}): PromptDefinition;
function definePrompt(config: {
  name: PublicPromptName;
  title: string;
  description: string;
  buildMessage: () => BuildMessageResult;
}): PromptDefinition;
function definePrompt(config: {
  name: PublicPromptName;
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

function renderWorkflowSection(name: PublicWorkflowName): string {
  const workflow = findWorkflowEntry(name);
  if (!workflow) {
    throw new Error(`Unknown workflow: ${name}`);
  }

  return [
    `Workflow: \`${workflow.name}\``,
    `Goal: ${workflow.goal}`,
    `When to use: ${workflow.whenToUse}`,
    `Steps:\n${workflow.steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n')}`,
    `Recommended tools: ${workflow.recommendedTools.map((tool) => `\`${tool}\``).join(', ')}`,
    `Recommended prompts: ${workflow.recommendedPrompts.map((prompt) => `\`${prompt}\``).join(', ')}`,
    `Related resources: ${workflow.relatedResources.map((resource) => `\`${resource}\``).join(', ')}`,
  ].join('\n\n');
}

const RESEARCH_MODE_OPTIONS = ['quick', 'deep'] as const;
const REVIEW_SUBJECT_OPTIONS = ['diff', 'comparison', 'failure'] as const;
const MEMORY_ACTION_OPTIONS = [
  'sessions.list',
  'sessions.get',
  'sessions.transcript',
  'sessions.events',
  'caches.list',
  'caches.get',
  'caches.create',
  'caches.update',
  'caches.delete',
  'workspace.context',
  'workspace.cache',
] as const;

function filterByPrefix<T extends string>(values: readonly T[], prefix: string): T[] {
  if (!prefix) return [...values];
  const lowered = prefix.toLowerCase();
  return values.filter((value) => value.toLowerCase().startsWith(lowered));
}

export const DiscoverPromptSchema = z
  .strictObject({
    job: completable(PublicJobNameSchema.optional(), (value) =>
      filterByPrefix(['chat', 'research', 'analyze', 'review', 'memory', 'discover'], value ?? ''),
    ),
    goal: optionalText('Optional user goal to narrow the recommendation'),
  })
  .describe('Guide a client to the best public job, prompt, and resource.');

export const ResearchPromptSchema = z
  .strictObject({
    goal: goalText('Research goal or question'),
    mode: completable(z.enum(RESEARCH_MODE_OPTIONS).optional(), (value) =>
      filterByPrefix(RESEARCH_MODE_OPTIONS, value ?? ''),
    ),
    deliverable: optionalText('Optional requested deliverable'),
  })
  .describe('Explain the quick-versus-deep research decision flow.');

export const ReviewPromptSchema = z
  .strictObject({
    subject: completable(z.enum(REVIEW_SUBJECT_OPTIONS).optional(), (value) =>
      filterByPrefix(REVIEW_SUBJECT_OPTIONS, value ?? ''),
    ),
    focus: optionalText('Optional review focus'),
  })
  .describe('Guide diff review, file comparison, or failure triage.');

export const MemoryPromptSchema = z
  .strictObject({
    action: completable(z.enum(MEMORY_ACTION_OPTIONS).optional(), (value) =>
      filterByPrefix(MEMORY_ACTION_OPTIONS, value ?? ''),
    ),
    task: optionalText('Optional task or context that should shape the memory advice'),
  })
  .describe('Explain how sessions, caches, and workspace memory fit together.');

export function buildDiscoverPrompt(args: z.infer<typeof DiscoverPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.job ? [`Preferred job: ${args.job}`] : []),
      ...(args.goal ? [`User goal: ${args.goal}`] : []),
      renderWorkflowSection('start-here'),
      'Recommend the best next job, prompt, and resource to inspect first.',
    ].join('\n\n'),
  );
}

export function buildResearchPrompt(args: z.infer<typeof ResearchPromptSchema>) {
  return userPromptMessage(
    [
      `Research goal: ${args.goal}`,
      ...(args.mode ? [`Preferred mode: ${args.mode}`] : []),
      ...(args.deliverable ? [`Requested deliverable: ${args.deliverable}`] : []),
      renderWorkflowSection('research'),
      'Explain whether quick or deep research is the better fit and why.',
    ].join('\n\n'),
  );
}

export function buildReviewPrompt(args: z.infer<typeof ReviewPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.subject ? [`Review subject: ${args.subject}`] : []),
      ...(args.focus ? [`Focus: ${args.focus}`] : []),
      renderWorkflowSection('review'),
      'Recommend the correct review subject variant and the information to gather first.',
    ].join('\n\n'),
  );
}

export function buildMemoryPrompt(args: z.infer<typeof MemoryPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.action ? [`Preferred memory action: ${args.action}`] : []),
      ...(args.task ? [`Task context: ${args.task}`] : []),
      renderWorkflowSection('memory'),
      'Explain whether the job needs session state, reusable caches, or workspace memory inspection.',
    ].join('\n\n'),
  );
}

export function createPromptDefinitions(): PromptDefinition[] {
  return [
    definePrompt({
      name: 'discover',
      title: 'Discover',
      description: 'Guide a client to the best public job, prompt, and resource.',
      argsSchema: DiscoverPromptSchema,
      buildMessage: buildDiscoverPrompt,
    }),
    definePrompt({
      name: 'research',
      title: 'Research',
      description: 'Explain the quick-versus-deep research decision flow.',
      argsSchema: ResearchPromptSchema,
      buildMessage: buildResearchPrompt,
    }),
    definePrompt({
      name: 'review',
      title: 'Review',
      description: 'Guide diff review, file comparison, or failure triage.',
      argsSchema: ReviewPromptSchema,
      buildMessage: buildReviewPrompt,
    }),
    definePrompt({
      name: 'memory',
      title: 'Memory',
      description: 'Explain how sessions, caches, and workspace memory fit together.',
      argsSchema: MemoryPromptSchema,
      buildMessage: buildMemoryPrompt,
    }),
  ];
}

export function registerPrompts(server: McpServer): void {
  for (const definition of createPromptDefinitions()) {
    server.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        ...(definition.argsSchema ? { argsSchema: definition.argsSchema } : {}),
      },
      async (args) => {
        const built = await definition.buildMessage((args ?? {}) as Record<string, unknown>);
        return {
          description: definition.description,
          ...built,
        };
      },
    );
  }
}
