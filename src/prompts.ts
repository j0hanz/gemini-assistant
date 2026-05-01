import { completable, type McpServer } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import {
  enumField,
  goalText,
  optionalField,
  RESEARCH_MODE_OPTIONS,
  REVIEW_SUBJECT_OPTIONS,
  textField,
} from './schemas/fields.js';

import { findWorkflowEntry } from './catalog.js';
import type { PublicPromptName, PublicWorkflowName } from './public-contract.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function enumComplete<T extends string>(options: readonly T[]) {
  return (value: string | undefined): T[] =>
    options.filter((option) => option.startsWith(value ?? ''));
}

function renderWorkflowSteps(name: PublicWorkflowName): string {
  const workflow = findWorkflowEntry(name);
  if (!workflow) {
    return `Workflow: \`${name}\` (catalog entry unavailable)`;
  }
  return workflow.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

// ── Thinking Levels ──────────────────────────────────────────────────────────

type ThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

const THINKING_LEVEL_OPTIONS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  discover: 'MINIMAL',
  chat: 'LOW',
  'research:quick': 'LOW',
  'research:deep': 'HIGH',
  'analyze:file': 'LOW',
  'analyze:url': 'LOW',
  'analyze:multi': 'MEDIUM',
  'analyze:*:diagram': 'MEDIUM',
  'review:diff': 'MEDIUM',
  'review:comparison': 'MEDIUM',
  'review:failure': 'HIGH',
};

// ── Resource URIs ────────────────────────────────────────────────────────────

const EMBEDDED_RESOURCE_URI: Record<PublicPromptName, string> = {
  discover: 'assistant://discover/catalog',
  chat: 'assistant://discover/workflows',
  research: 'assistant://discover/workflows',
  analyze: 'assistant://discover/workflows',
  review: 'assistant://discover/workflows',
};

// ── Prompt Body Spec ─────────────────────────────────────────────────────────

interface PromptBodySpec {
  role: string;
  goal: string;
  variant?: string;
  context: string;
  constraints: string[];
  outputFormat: string;
  nextAction?: string;
}

function renderPromptBody(spec: PromptBodySpec): string {
  const parts: string[] = [`<role>${spec.role}</role>`, `<goal>${spec.goal}</goal>`];

  if (spec.variant) {
    parts.push(`<variant>${spec.variant}</variant>`);
  }

  parts.push(`<context>${spec.context}</context>`);
  parts.push(`<constraints>${spec.constraints.map((c) => `- ${c}`).join('\n')}</constraints>`);
  parts.push(`<output_format>${spec.outputFormat}</output_format>`);

  if (spec.nextAction) {
    parts.push(`<next_action>${spec.nextAction}</next_action>`);
  }

  return parts.join('\n\n');
}

// ── Meta Builder ─────────────────────────────────────────────────────────────

interface MetaArgs {
  promptName: PublicPromptName;
  thinkingLevelKey: string;
  suggestedArgs?: Record<string, unknown> | undefined;
  nextTool?: string | undefined;
}

interface PromptMeta {
  suggestedArgs?: Record<string, unknown> | undefined;
  thinkingLevel: ThinkingLevel;
  nextTool?: string | undefined;
  [key: string]: unknown;
}

function buildMeta(args: MetaArgs): PromptMeta {
  const thinkingLevel =
    (args.suggestedArgs?.thinkingLevel as ThinkingLevel | undefined) ??
    THINKING_LEVELS[args.thinkingLevelKey] ??
    'LOW';
  const meta: PromptMeta = { thinkingLevel };

  if (args.suggestedArgs) {
    meta.suggestedArgs = args.suggestedArgs;
  }

  if (args.nextTool !== undefined && args.promptName !== 'discover') {
    meta.nextTool = args.nextTool;
  }

  return meta;
}

// ── Result Builder ───────────────────────────────────────────────────────────

interface PromptResult {
  [x: string]: unknown;
  description: string;
  messages: (
    | {
        role: 'user';
        content: {
          type: 'text';
          text: string;
        };
      }
    | {
        role: 'user';
        content: {
          type: 'resource';
          resource: {
            uri: string;
            text: string;
          };
        };
      }
  )[];
  _meta: PromptMeta;
}

interface PromptError {
  [x: string]: unknown;
  isError: true;
  description: string;
  messages: never[];
  _meta: Record<string, unknown>;
}

interface ResultArgs {
  promptName: PublicPromptName;
  description: string;
  bodyText: string;
  suggestedArgs?: Record<string, unknown> | undefined;
  thinkingLevelKey: string;
  nextTool?: string | undefined;
}

function buildResult(args: ResultArgs): PromptResult {
  const resourceUri = EMBEDDED_RESOURCE_URI[args.promptName];
  return {
    description: args.description,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: args.bodyText,
        },
      },
      {
        role: 'user' as const,
        content: {
          type: 'resource' as const,
          resource: {
            uri: resourceUri,
            text: '',
          },
        },
      },
    ],
    _meta: buildMeta({
      promptName: args.promptName,
      thinkingLevelKey: args.thinkingLevelKey,
      suggestedArgs: args.suggestedArgs,
      nextTool: args.nextTool,
    }),
  };
}

function promptError(message: string): PromptError {
  return {
    isError: true,
    description: message,
    messages: [] as never[],
    _meta: {},
  };
}

// ── Utility: Pick Defined ────────────────────────────────────────────────────

function pickDefined<K extends string>(
  src: Record<K, unknown>,
  keys: readonly K[],
): Partial<Record<K, unknown>> {
  const result: Partial<Record<K, unknown>> = {};
  for (const key of keys) {
    if (src[key] !== undefined) {
      result[key] = src[key];
    }
  }
  return result;
}

// ── Prompt Schemas ───────────────────────────────────────────────────────────

const ChatPromptSchema = z
  .strictObject({
    goal: goalText('User goal or requested outcome'),
    sessionId: optionalField(textField('Session ID to resume', 256)),
    systemInstruction: optionalField(textField('Custom system instruction for this chat')),
    thinkingLevel: optionalField(enumField(THINKING_LEVEL_OPTIONS, 'Thinking level override')),
  })
  .describe('Chat with direct Gemini interaction and optional server-managed sessions.');

const ResearchPromptSchema = z
  .strictObject({
    goal: goalText('Research goal or question'),
    mode: optionalField(enumField(RESEARCH_MODE_OPTIONS, 'Research mode (quick or deep)')),
    deliverable: optionalField(textField('Requested output form')),
    searchDepth: optionalField(z.int().positive()),
    systemInstruction: optionalField(textField('Custom system instruction')),
  })
  .describe('Research with quick or deep web-grounded lookup.');

const ANALYZE_TARGET_OPTIONS = ['file', 'url', 'multi'] as const;
const ANALYZE_OUTPUT_OPTIONS = ['summary', 'diagram'] as const;
const DIAGRAM_TYPE_OPTIONS = ['mermaid', 'plantuml'] as const;

const AnalyzePromptSchema = z
  .strictObject({
    goal: goalText('Analysis goal or requested outcome'),
    targetKind: enumField(ANALYZE_TARGET_OPTIONS, 'Analysis target type'),
    outputKind: optionalField(enumField(ANALYZE_OUTPUT_OPTIONS, 'Output format')),
    filePath: optionalField(textField('Path to file for analysis')),
    urls: optionalField(z.array(z.string())),
    filePaths: optionalField(z.array(z.string()).min(2)),
    diagramType: optionalField(enumField(DIAGRAM_TYPE_OPTIONS, 'Diagram syntax type')),
  })
  .describe('Analyze files, URLs, or generate diagrams.');

const ReviewPromptSchema = z
  .strictObject({
    subjectKind: enumField(REVIEW_SUBJECT_OPTIONS, 'Review variant type'),
    language: optionalField(textField('Primary language hint for code review')),
    filePathA: optionalField(textField('First file path for comparison')),
    filePathB: optionalField(textField('Second file path for comparison')),
    question: optionalField(textField('Comparison focus question')),
    error: optionalField(textField('Error message or stack trace', 32000)),
    codeContext: optionalField(textField('Relevant source code context', 16000)),
  })
  .describe('Review diffs, compare files, or diagnose failures.');

// ── Validation Functions ─────────────────────────────────────────────────────

function validateAnalyze(args: z.infer<typeof AnalyzePromptSchema>): PromptError | null {
  const { targetKind, outputKind, filePath, urls, filePaths, diagramType } = args;

  if (targetKind === 'file' && !filePath) {
    return promptError('targetKind=file requires filePath');
  }

  if (targetKind === 'url' && (!urls || urls.length === 0)) {
    return promptError('targetKind=url requires urls (non-empty array)');
  }

  if (targetKind === 'multi' && (!filePaths || filePaths.length < 2)) {
    return promptError('targetKind=multi requires filePaths with at least 2 items');
  }

  if (outputKind === 'diagram' && !diagramType) {
    return promptError('outputKind=diagram requires diagramType');
  }

  return null;
}

function validateReview(args: z.infer<typeof ReviewPromptSchema>): PromptError | null {
  const { subjectKind, filePathA, filePathB, error } = args;

  if (subjectKind === 'comparison' && (!filePathA || !filePathB)) {
    return promptError('subjectKind=comparison requires filePathA and filePathB');
  }

  if (subjectKind === 'failure' && !error) {
    return promptError('subjectKind=failure requires error');
  }

  return null;
}

// ── Discover Prompt ──────────────────────────────────────────────────────────

const DiscoverPromptSchema = z
  .strictObject({
    job: optionalField(
      completable(
        enumField(['chat', 'research', 'analyze', 'review'] as const, 'Public job to focus on'),
        enumComplete(['chat', 'research', 'analyze', 'review'] as const),
      ),
    ),
    goal: optionalField(textField('User outcome to optimize for')),
  })
  .describe('Guide a client to the best public job, prompt, and resource.');

function buildDiscover(args: z.infer<typeof DiscoverPromptSchema>): PromptResult {
  const suggestedArgs = pickDefined(args as Record<string, unknown>, ['job', 'goal']);

  const body: PromptBodySpec = {
    role: 'Discovery guide for the public gemini-assistant MCP server.',
    goal: 'Orient the user to available public jobs and workflows.',
    context: renderWorkflowSteps('start-here'),
    constraints: [
      'Recommend the best public job or prompt given the user context.',
      'If no job or goal is provided, ask clarifying questions.',
      'Reference the embedded discover catalog for current metadata.',
    ],
    outputFormat: 'Natural language response with job/prompt recommendation and explanation.',
    nextAction: 'Read assistant://discover/workflows for the guided entry points.',
  };

  return buildResult({
    promptName: 'discover',
    description: 'Guide a client to the best public job, prompt, and resource.',
    bodyText: renderPromptBody(body),
    suggestedArgs: Object.keys(suggestedArgs).length > 0 ? suggestedArgs : undefined,
    thinkingLevelKey: 'discover',
  });
}

// ── Chat Prompt ──────────────────────────────────────────────────────────────

const CHAT_BODY: PromptBodySpec = {
  role: 'Direct Gemini chat assistant with optional server-managed sessions.',
  goal: 'Answer the user goal directly and handle multi-turn conversation state.',
  context: 'The user is interacting directly via chat with optional session continuity.',
  constraints: [
    'Provide direct answers to the user goal.',
    'Maintain state across turns using sessionId if provided.',
    'Honor systemInstruction and thinkingLevel overrides if supplied.',
    'Use functionResponses to handle client-executed function calls.',
  ],
  outputFormat:
    'Direct answer, optional structured data, usage/safety/citation metadata, and session resource links.',
  nextAction:
    'If functionCalls are returned, execute them in the MCP client and resume with functionResponses.',
};

function buildChat(args: z.infer<typeof ChatPromptSchema>): PromptResult {
  const suggestedArgs = pickDefined(args as Record<string, unknown>, [
    'goal',
    'sessionId',
    'systemInstruction',
    'thinkingLevel',
  ]);

  return buildResult({
    promptName: 'chat',
    description: 'Direct chat with optional server-managed sessions.',
    bodyText: renderPromptBody(CHAT_BODY),
    suggestedArgs: Object.keys(suggestedArgs).length > 0 ? suggestedArgs : undefined,
    thinkingLevelKey: 'chat',
    nextTool: 'chat',
  });
}

// ── Research Prompt ──────────────────────────────────────────────────────────

const RESEARCH_BODY: PromptBodySpec = {
  role: 'Web-grounded research assistant with quick and deep modes.',
  goal: 'Research the user goal using web-grounded lookup and return cited findings.',
  context:
    'The user is asking for research on a topic that may require current public information.',
  constraints: [
    'Choose quick mode for single-search grounded answers.',
    'Choose deep mode for multi-step research synthesis across sources.',
    'Provide source attribution and claim-level citations.',
    'Respect searchDepth and deliverable preferences if supplied.',
  ],
  outputFormat:
    'A summary with grounding status, grounding signals, claim-linked source attributions, and tool-usage details.',
  nextAction: 'Use the research job directly to execute the chosen mode.',
};

function buildResearch(args: z.infer<typeof ResearchPromptSchema>): PromptResult {
  const mode = args.mode ?? 'quick';
  const thinkingLevelKey = mode === 'deep' ? 'research:deep' : 'research:quick';
  const variant = mode === 'deep' ? 'Deep multi-step research' : 'Quick single-search research';

  const body: PromptBodySpec = {
    ...RESEARCH_BODY,
    variant,
  };

  const suggestedArgs = pickDefined(args as Record<string, unknown>, [
    'goal',
    'mode',
    'deliverable',
    'searchDepth',
    'systemInstruction',
  ]);

  return buildResult({
    promptName: 'research',
    description: 'Research with quick or deep web-grounded lookup.',
    bodyText: renderPromptBody(body),
    suggestedArgs: Object.keys(suggestedArgs).length > 0 ? suggestedArgs : undefined,
    thinkingLevelKey,
    nextTool: 'research',
  });
}

// ── Analyze Prompt ───────────────────────────────────────────────────────────

const ANALYZE_BODY: PromptBodySpec = {
  role: 'Focused analysis assistant for local files, URLs, and diagram generation.',
  goal: 'Analyze the bounded target and return focused insights or diagrams.',
  context: 'The user is asking for focused analysis of known artifacts or diagram generation.',
  constraints: [
    'Match the analysis target to the supplied targetKind (file, url, or multi).',
    'Return a summary by default or a diagram if outputKind=diagram.',
    'For diagram output, use the specified diagramType (mermaid or plantuml).',
    'Keep analysis bounded to the supplied target scope.',
  ],
  outputFormat:
    'An analysis summary or diagram tied to the requested target kind with optional URL retrieval metadata.',
  nextAction: 'Use the analyze job directly to execute the chosen analysis.',
};

function buildAnalyze(args: z.infer<typeof AnalyzePromptSchema>): PromptResult | PromptError {
  const validationError = validateAnalyze(args);
  if (validationError) {
    return validationError;
  }

  const outputKind = args.outputKind ?? 'summary';
  let variant = `Analyze ${args.targetKind}`;
  let thinkingLevelKey = `analyze:${args.targetKind}`;

  if (outputKind === 'diagram') {
    variant += ` as ${args.diagramType ?? 'mermaid'} diagram`;
    thinkingLevelKey = 'analyze:*:diagram';
  }

  const body: PromptBodySpec = {
    ...ANALYZE_BODY,
    variant,
  };

  const suggestedArgs = pickDefined(args as Record<string, unknown>, [
    'goal',
    'targetKind',
    'outputKind',
    'filePath',
    'urls',
    'filePaths',
    'diagramType',
  ]);

  return buildResult({
    promptName: 'analyze',
    description: 'Analyze files, URLs, or generate diagrams.',
    bodyText: renderPromptBody(body),
    suggestedArgs: Object.keys(suggestedArgs).length > 0 ? suggestedArgs : undefined,
    thinkingLevelKey,
    nextTool: 'analyze',
  });
}

// ── Review Prompt ────────────────────────────────────────────────────────────

const REVIEW_BODY: PromptBodySpec = {
  role: 'Evaluative review assistant for diffs, file comparisons, and failure triage.',
  goal: 'Review the supplied subject and return evaluative insights.',
  context: 'The user is asking for a review of diffs, file comparisons, or failure diagnostics.',
  constraints: [
    'Match the review type to the supplied subjectKind (diff, comparison, or failure).',
    'For diff review, inspect the local repository changes.',
    'For comparison, analyze the two supplied files.',
    'For failure, diagnose the error and provide root-cause guidance.',
    'Focus on the question or priority area if supplied.',
  ],
  outputFormat:
    'A review summary plus diff stats, comparison output, or failure guidance depending on the selected subjectKind.',
  nextAction: 'Use the review job directly to execute the chosen review type.',
};

function buildReview(args: z.infer<typeof ReviewPromptSchema>): PromptResult | PromptError {
  const validationError = validateReview(args);
  if (validationError) {
    return validationError;
  }

  const variant = `Review ${args.subjectKind}`;
  const thinkingLevelKey = `review:${args.subjectKind}`;

  const body: PromptBodySpec = {
    ...REVIEW_BODY,
    variant,
  };

  const suggestedArgs = pickDefined(args as Record<string, unknown>, [
    'subjectKind',
    'language',
    'filePathA',
    'filePathB',
    'question',
    'error',
    'codeContext',
  ]);

  return buildResult({
    promptName: 'review',
    description: 'Review diffs, compare files, or diagnose failures.',
    bodyText: renderPromptBody(body),
    suggestedArgs: Object.keys(suggestedArgs).length > 0 ? suggestedArgs : undefined,
    thinkingLevelKey,
    nextTool: 'review',
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'discover' satisfies PublicPromptName,
    {
      title: 'Discover',
      description: 'Guide a client to the best public job, prompt, and resource.',
      argsSchema: DiscoverPromptSchema,
    },
    (args) => buildDiscover(args),
  );

  server.registerPrompt(
    'chat' satisfies PublicPromptName,
    {
      title: 'Chat',
      description: 'Direct chat with optional server-managed sessions.',
      argsSchema: ChatPromptSchema,
    },
    (args) => buildChat(args),
  );

  server.registerPrompt(
    'research' satisfies PublicPromptName,
    {
      title: 'Research',
      description: 'Research with quick or deep web-grounded lookup.',
      argsSchema: ResearchPromptSchema,
    },
    (args) => buildResearch(args),
  );

  server.registerPrompt(
    'analyze' satisfies PublicPromptName,
    {
      title: 'Analyze',
      description: 'Analyze files, URLs, or generate diagrams.',
      argsSchema: AnalyzePromptSchema,
    },
    (args) => buildAnalyze(args),
  );

  server.registerPrompt(
    'review' satisfies PublicPromptName,
    {
      title: 'Review',
      description: 'Review diffs, compare files, or diagnose failures.',
      argsSchema: ReviewPromptSchema,
    },
    (args) => buildReview(args),
  );
}

// Export for testing purposes
export { buildDiscover };
