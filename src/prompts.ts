import { completable, type McpServer } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import {
  enumField,
  goalText,
  PublicJobNameSchema,
  RESEARCH_MODE_OPTIONS,
  REVIEW_SUBJECT_OPTIONS,
  textField,
} from './schemas/fields.js';

import { findWorkflowEntry } from './catalog.js';
import type { PublicPromptName, PublicWorkflowName } from './public-contract.js';

export { PUBLIC_PROMPT_NAMES } from './public-contract.js';

export const PUBLIC_JOB_OPTIONS = [...PublicJobNameSchema.options];

function enumComplete<T extends string>(options: readonly T[]) {
  return (value: string | undefined): T[] =>
    options.filter((option) => option.startsWith(value ?? ''));
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

export function renderWorkflowSection(name: PublicWorkflowName): string {
  const workflow = findWorkflowEntry(name);
  if (!workflow) {
    return [
      `Workflow: \`${name}\``,
      'Catalog entry unavailable.',
      'Read `discover://workflows` for the latest workflow details.',
    ].join('\n\n');
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

export const DiscoverPromptSchema = z
  .strictObject({
    job: completable(
      PublicJobNameSchema.describe('Public job to focus discovery guidance on.'),
      enumComplete(PublicJobNameSchema.options),
    ).optional(),
    goal: textField('User outcome to optimize for.').optional(),
  })
  .describe('Guide a client to the best public job, prompt, and resource.');

export const ResearchPromptSchema = z
  .strictObject({
    goal: goalText('Research goal or question'),
    mode: completable(
      enumField(RESEARCH_MODE_OPTIONS, 'Research mode (quick or deep).'),
      enumComplete(RESEARCH_MODE_OPTIONS),
    ).optional(),
    deliverable: textField('Requested output form.').optional(),
  })
  .describe('Explain the quick-versus-deep research decision flow.');

export const ReviewPromptSchema = z
  .strictObject({
    subject: completable(
      enumField(REVIEW_SUBJECT_OPTIONS, 'Review variant (diff, comparison, failure).'),
      enumComplete(REVIEW_SUBJECT_OPTIONS),
    ).optional(),
    focus: textField('Review priority (e.g. regressions, tests, security).').optional(),
  })
  .describe('Guide diff review, file comparison, or failure triage.');

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

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'discover' satisfies PublicPromptName,
    {
      title: 'Discover',
      description: 'Guide a client to the best public job, prompt, and resource.',
      argsSchema: DiscoverPromptSchema,
    },
    (args) => ({
      description: 'Guide a client to the best public job, prompt, and resource.',
      ...buildDiscoverPrompt(args),
    }),
  );

  server.registerPrompt(
    'research' satisfies PublicPromptName,
    {
      title: 'Research',
      description: 'Explain the quick-versus-deep research decision flow.',
      argsSchema: ResearchPromptSchema,
    },
    (args) => ({
      description: 'Explain the quick-versus-deep research decision flow.',
      ...buildResearchPrompt(args),
    }),
  );

  server.registerPrompt(
    'review' satisfies PublicPromptName,
    {
      title: 'Review',
      description: 'Guide diff review, file comparison, or failure triage.',
      argsSchema: ReviewPromptSchema,
    },
    (args) => ({
      description: 'Guide diff review, file comparison, or failure triage.',
      ...buildReviewPrompt(args),
    }),
  );
}
