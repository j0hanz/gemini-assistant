import {
  completable,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';

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
const META_NS = 'gemini-assistant';
interface MetaArgs {
  promptName: PublicPromptName;
  thinkingLevelKey: string;
  suggestedArgs?: Record<string, unknown> | undefined;
  nextTool?: string | undefined;
}

type PromptMeta = Record<string, unknown>;

function buildMeta(args: MetaArgs): PromptMeta {
  const thinkingLevel =
    (args.suggestedArgs?.thinkingLevel as ThinkingLevel | undefined) ??
    THINKING_LEVELS[args.thinkingLevelKey] ??
    'LOW';
  const meta: PromptMeta = { [`${META_NS}/thinkingLevel`]: thinkingLevel };

  if (args.suggestedArgs) {
    meta[`${META_NS}/suggestedArgs`] = args.suggestedArgs;
  }

  if (args.nextTool !== undefined && args.promptName !== 'discover') {
    meta[`${META_NS}/nextTool`] = args.nextTool;
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
          type: 'resource_link';
          uri: string;
          name: string;
          mimeType: string;
        };
      }
  )[];
  _meta: PromptMeta;
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
          type: 'resource_link' as const,
          uri: resourceUri,
          name: args.promptName,
          mimeType: 'application/json',
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

// ── Utility: Pick Defined ────────────────────────────────────────────────────

function pickDefined(
  src: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (src[key] !== undefined) {
      result[key] = src[key];
    }
  }
  return result;
}

// ── Prompt Schemas ───────────────────────────────────────────────────────────

const ChatPromptSchema = z.strictObject({
  goal: goalText('User goal or requested outcome'),
  sessionId: optionalField(textField('Session ID to resume', 256)),
  systemInstruction: optionalField(textField('Custom system instruction for this chat')),
  thinkingLevel: optionalField(
    completable(
      enumField(THINKING_LEVEL_OPTIONS, 'Thinking level override'),
      enumComplete(THINKING_LEVEL_OPTIONS),
    ),
  ),
});

const ResearchPromptSchema = z.strictObject({
  goal: goalText('Research goal or question'),
  mode: optionalField(
    completable(
      enumField(RESEARCH_MODE_OPTIONS, 'Research mode (quick or deep)'),
      enumComplete(RESEARCH_MODE_OPTIONS),
    ),
  ),
  deliverable: optionalField(textField('Requested output form')),
  systemInstruction: optionalField(textField('Custom system instruction')),
});

const ANALYZE_TARGET_OPTIONS = ['file', 'url', 'multi'] as const;
const ANALYZE_OUTPUT_OPTIONS = ['summary', 'diagram'] as const;
const DIAGRAM_TYPE_OPTIONS = ['mermaid', 'plantuml'] as const;

const AnalyzePromptSchema = z.strictObject({
  goal: goalText('Analysis goal or requested outcome'),
  targetKind: completable(
    enumField(ANALYZE_TARGET_OPTIONS, 'Analysis target type'),
    enumComplete(ANALYZE_TARGET_OPTIONS),
  ),
  outputKind: optionalField(
    completable(
      enumField(ANALYZE_OUTPUT_OPTIONS, 'Output format'),
      enumComplete(ANALYZE_OUTPUT_OPTIONS),
    ),
  ),
  filePath: optionalField(textField('Path to file for analysis')),
  diagramType: optionalField(
    completable(
      enumField(DIAGRAM_TYPE_OPTIONS, 'Diagram syntax type'),
      enumComplete(DIAGRAM_TYPE_OPTIONS),
    ),
  ),
});

const ReviewPromptSchema = z.strictObject({
  subjectKind: completable(
    enumField(REVIEW_SUBJECT_OPTIONS, 'Review variant type'),
    enumComplete(REVIEW_SUBJECT_OPTIONS),
  ),
  language: optionalField(textField('Primary language hint for code review')),
  filePathA: optionalField(textField('First file path for comparison')),
  filePathB: optionalField(textField('Second file path for comparison')),
  question: optionalField(textField('Comparison focus question')),
  error: optionalField(textField('Error message or stack trace', 32000)),
  codeContext: optionalField(textField('Relevant source code context', 16000)),
});

// ── Validation Functions ─────────────────────────────────────────────────────

function validateAnalyze(args: z.infer<typeof AnalyzePromptSchema>): void {
  const { targetKind, outputKind, filePath, diagramType } = args;

  if (targetKind === 'file' && !filePath) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'targetKind=file requires filePath');
  }

  if (outputKind === 'diagram' && !diagramType) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'outputKind=diagram requires diagramType',
    );
  }
}

function validateReview(args: z.infer<typeof ReviewPromptSchema>): void {
  const { subjectKind, filePathA, filePathB, error } = args;

  if (subjectKind === 'comparison' && (!filePathA || !filePathB)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'subjectKind=comparison requires filePathA and filePathB',
    );
  }

  if (subjectKind === 'failure' && !error) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'subjectKind=failure requires error');
  }
}

// ── Discover Prompt ──────────────────────────────────────────────────────────

const DiscoverPromptSchema = z.strictObject({
  job: optionalField(
    completable(
      enumField(['chat', 'research', 'analyze', 'review'] as const, 'Public job to focus on'),
      enumComplete(['chat', 'research', 'analyze', 'review'] as const),
    ),
  ),
  goal: optionalField(textField('User outcome to optimize for')),
});

function buildDiscover(args: z.infer<typeof DiscoverPromptSchema>): PromptResult {
  const suggestedArgs = pickDefined(args, ['job', 'goal']);

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
  const suggestedArgs = pickDefined(args, [
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
    'Respect deliverable preference if supplied.',
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

  const suggestedArgs = pickDefined(args, ['goal', 'mode', 'deliverable', 'systemInstruction']);

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

function buildAnalyze(args: z.infer<typeof AnalyzePromptSchema>): PromptResult {
  validateAnalyze(args);

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

  const suggestedArgs = pickDefined(args, [
    'goal',
    'targetKind',
    'outputKind',
    'filePath',
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

function buildReview(args: z.infer<typeof ReviewPromptSchema>): PromptResult {
  validateReview(args);

  const variant = `Review ${args.subjectKind}`;
  const thinkingLevelKey = `review:${args.subjectKind}`;

  const body: PromptBodySpec = {
    ...REVIEW_BODY,
    variant,
  };

  const suggestedArgs = pickDefined(args, [
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
