import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';
import type { ParsePayload } from 'zod/v4/core';

import { AppError } from '../lib/errors.js';

import {
  analyzeOutputKind,
  analyzeTargetKind,
  DIAGRAM_TYPES,
  FunctionResponsesSchema,
  goalText,
  mediaResolution,
  optionalField,
  OptionalFileSearchSpecSchema,
  OptionalFunctionsSpecSchema,
  requiredText,
  researchMode,
  REVIEW_SUBJECT_OPTIONS,
  ServerSideToolInvocationsSchema,
  sessionId,
  temperatureField,
  textField,
  thinkingBudget,
  thinkingLevel,
  withFieldMetadata,
  workspacePath,
  workspacePathArray,
} from './fields.js';
import {
  createFilePairFields,
  createGenerationConfigFields,
  createUrlContextFields,
} from './fragments.js';
import { GeminiResponseSchema } from './json-schema.js';
import {
  validateExclusiveSourceFileFields,
  validateFlatAnalyzeInput,
  validateFlatResearchInput,
  validateFlatReviewInput,
} from './validators.js';
import { validateGeminiJsonSchema } from './validators.js';

type SessionIdCompleter = (prefix?: string) => string[];

const thinkingLevelField = thinkingLevel();
const thinkingBudgetField = thinkingBudget();
const generationConfigFields = createGenerationConfigFields();

export function parseResponseSchemaJsonValue(raw: string): GeminiResponseSchema {
  const parsed = JSON.parse(raw) as unknown;
  const compatibilityErrors = validateGeminiJsonSchema(parsed);
  if (compatibilityErrors.length > 0) {
    throw new AppError(
      'chat',
      `responseSchemaJson is not supported by Gemini's JSON-schema subset.\n${compatibilityErrors
        .map((error) => `- ${error}`)
        .join('\n')}`,
    );
  }
  return GeminiResponseSchema.parse(parsed);
}

function validateResponseSchemaJson(payload: ParsePayload<string>): void {
  try {
    parseResponseSchemaJsonValue(payload.value);
    return;
  } catch (error) {
    payload.issues.push({
      code: 'custom',
      input: payload.value,
      message:
        error instanceof SyntaxError
          ? 'responseSchemaJson must be valid JSON.'
          : error instanceof AppError
            ? error.message
            : error instanceof z.ZodError
              ? `responseSchemaJson must match the supported schema.\n${z.prettifyError(error)}`
              : 'responseSchemaJson must be valid JSON.',
    });
  }
}

function responseSchemaJsonField() {
  return withFieldMetadata(
    z.string().trim().min(1).check(validateResponseSchemaJson).optional(),
    'JSON Schema (2020-12) for structured output. Single-turn / new-session only.',
  );
}

export function createChatInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z.strictObject({
    goal: goalText(),
    sessionId: completable(
      optionalField(
        sessionId(
          'Server-managed in-memory session identifier. Omitting sessionId enables structured output (responseSchemaJson) and JSON schema-repair retry.',
        ),
      ),
      completeSessionIds,
    ),
    systemInstruction: optionalField(
      textField('System instructions for response style, constraints, or behavior.'),
    ),
    thinkingLevel: thinkingLevelField,
    thinkingBudget: thinkingBudgetField,
    ...generationConfigFields,
    responseSchemaJson: responseSchemaJsonField(),
    temperature: temperatureField(),
    seed: withFieldMetadata(z.int().optional(), 'Fixed random seed for reproducible outputs.'),
    codeExecution: withFieldMetadata(
      z.boolean().optional(),
      'Enable native Python code execution within the chat session. Useful for math, logic, or data processing.',
    ),
    googleSearch: withFieldMetadata(
      z.boolean().optional(),
      'Enable Google Search grounding for chat. Optional; additive. Combine with `urls` for URL Context.',
    ),
    ...createUrlContextFields({
      itemDescription: 'Public URL to analyze with URL Context during chat',
      description: 'Public URLs to analyze with URL Context during chat.',
      min: 1,
      max: 20,
      optional: true,
    }),
    fileSearch: withFieldMetadata(
      OptionalFileSearchSpecSchema,
      'Enable Gemini File Search over named stores for retrieval-augmented chat.',
    ),
    functions: withFieldMetadata(
      OptionalFunctionsSpecSchema,
      'Typed Gemini function declarations. The MCP client owns function execution and returns function responses through the session.',
    ),
    functionResponses: withFieldMetadata(
      FunctionResponsesSchema.optional(),
      'Caller-executed Gemini function responses for an existing session. Requires sessionId and continues the model after functionCalls returned by a previous turn.',
    ),
    serverSideToolInvocations: ServerSideToolInvocationsSchema,
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

const ResearchInputBaseSchema = z.strictObject({
  mode: researchMode(),
  goal: goalText('Question or research goal to answer quickly'),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze alongside search results',
    description: 'Public URLs to inspect alongside web search results.',
    max: 20,
    optional: true,
  }),
  systemInstruction: optionalField(
    textField('Instructions for output presentation (format, audience, tone).'),
  ),
  deliverable: optionalField(textField('Requested output form (brief, report, checklist, etc.).')),
  searchDepth: withFieldMetadata(
    z.int().min(1).max(5).default(2).optional(),
    'Search depth, default 2; deep research only when `mode=deep` is explicit.',
  ),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
  fileSearch: withFieldMetadata(
    OptionalFileSearchSpecSchema,
    'Enable Gemini File Search over named stores alongside research retrieval.',
  ),
});
export const ResearchInputSchema = ResearchInputBaseSchema.superRefine(validateFlatResearchInput);
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

const AnalyzeInputBaseSchema = z.strictObject({
  goal: goalText('Question or analysis goal for the selected targets'),
  targetKind: analyzeTargetKind(),
  filePath: optionalField(
    workspacePath('Workspace-relative or absolute path to analyze when targetKind=file'),
  ),
  urls: createUrlContextFields({
    itemDescription: 'Public URL to analyze',
    description: 'Public URLs to analyze when targetKind=url.',
    min: 1,
    max: 20,
    optional: true,
  }).urls,
  filePaths: workspacePathArray({
    description: 'Local files to analyze when targetKind=multi.',
    itemDescription: 'Workspace-relative or absolute path to a local file',
    min: 2,
    max: 5,
    optional: true,
  }),
  outputKind: analyzeOutputKind(),
  diagramType: withFieldMetadata(
    z.enum(DIAGRAM_TYPES).default('mermaid').optional(),
    'Diagram syntax to generate when outputKind=diagram.',
  ),
  validateSyntax: z
    .boolean()
    .optional()
    .describe('Validate generated diagram syntax when outputKind=diagram.'),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search grounding. Optional; additive. Extra tokens when enabled.',
  ),
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
});
export const AnalyzeInputSchema = AnalyzeInputBaseSchema.superRefine(validateFlatAnalyzeInput);
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
const reviewCommonShape = {
  focus: optionalField(textField('Review priorities (e.g. regressions, security, performance).')),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
};

const ReviewInputBaseSchema = z.strictObject({
  subjectKind: withFieldMetadata(
    z.enum(REVIEW_SUBJECT_OPTIONS).default('diff'),
    'What to review: the current diff, a file comparison, or a failure report.',
  ),
  dryRun: withFieldMetadata(z.boolean().optional(), 'Skip model review for subjectKind=diff.'),
  language: optionalField(textField('Primary language hint for diff or failure review.')),
  filePathA: optionalField(
    workspacePath(
      'Workspace-relative or absolute path to the first file when subjectKind=comparison',
    ),
  ),
  filePathB: optionalField(
    workspacePath(
      'Workspace-relative or absolute path to the second file when subjectKind=comparison',
    ),
  ),
  question: optionalField(
    textField('Comparison focus when subjectKind=comparison (behavior, APIs, security, etc.).'),
  ),
  error: optionalField(textField('Error message or stack trace when subjectKind=failure.')),
  codeContext: optionalField(textField('Relevant source code context when subjectKind=failure.')),
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search when subjectKind=comparison or subjectKind=failure.',
  ),
  ...createUrlContextFields({
    itemDescription: 'Public URL to include via URL Context',
    description: 'Public URLs for additional context when subjectKind=comparison or failure.',
    max: 20,
    optional: true,
  }),
  ...reviewCommonShape,
});
export const ReviewInputSchema = ReviewInputBaseSchema.superRefine(validateFlatReviewInput);
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

function createAskInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  const askCommonShape = {
    message: requiredText('User message or prompt', 100_000),
    sessionId: completable(
      optionalField(sessionId('Session ID for multi-turn chat. Omit for single-turn.')),
      completeSessionIds,
    ),
    systemInstruction: optionalField(
      textField('System instructions for response style, constraints, or behavior.'),
    ),
    thinkingLevel: thinkingLevelField,
    thinkingBudget: thinkingBudgetField,
    ...generationConfigFields,
    responseSchema: withFieldMetadata(
      GeminiResponseSchema.optional(),
      'JSON Schema for structured output.',
    ),
    temperature: temperatureField(),
    seed: withFieldMetadata(z.int().optional(), 'Fixed random seed for reproducible outputs.'),
    codeExecution: withFieldMetadata(
      z.boolean().optional(),
      'Enable native Python code execution within the chat session. Useful for math, logic, or data processing.',
    ),
    fileSearch: withFieldMetadata(
      OptionalFileSearchSpecSchema,
      'Enable Gemini File Search over named stores for retrieval-augmented chat.',
    ),
    functions: withFieldMetadata(
      OptionalFunctionsSpecSchema,
      'Typed Gemini function declarations. The MCP client owns function execution and returns function responses through the session.',
    ),
    functionResponses: withFieldMetadata(
      FunctionResponsesSchema.optional(),
      'Caller-executed Gemini function responses for an existing session. Requires sessionId and continues the model after functionCalls returned by a previous turn.',
    ),
    serverSideToolInvocations: ServerSideToolInvocationsSchema,
    googleSearch: withFieldMetadata(
      z.boolean().optional(),
      'Enable Google Search grounding. Optional; additive. Combine with `urls` for URL Context.',
    ),
  };

  return z.union([
    z.strictObject({
      ...askCommonShape,
    }),
    z.strictObject({
      ...askCommonShape,
      ...createUrlContextFields({
        itemDescription: 'Public URL to analyze with URL Context',
        description: 'URLs for URL Context (max 20). Enables URL Context automatically.',
        min: 1,
        max: 20,
      }),
    }),
  ]);
}

export const AskInputSchema = createAskInputSchema();
export type AskInput = z.infer<typeof AskInputSchema>;

export const ExecuteCodeInputSchema = z.strictObject({
  task: requiredText('Code task to perform'),
  language: optionalField(
    textField(
      'Preferred language for the generated solution. Use to steer the model toward a target language even though Gemini executes code in Python.',
    ),
  ),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
});

export const SearchInputSchema = z.strictObject({
  query: requiredText('Question or topic to research'),
  systemInstruction: optionalField(
    textField(
      'Instructions for how search results should be synthesized. Use for output format, audience, tone, or filtering constraints.',
    ),
  ),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze alongside search results',
    description: 'URLs to deeply analyze alongside search results (max 20). Enables URL Context.',
    max: 20,
    optional: true,
  }),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  fileSearch: withFieldMetadata(
    OptionalFileSearchSpecSchema,
    'Enable Gemini File Search over named stores alongside web search.',
  ),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const AgenticSearchInputSchema = z.strictObject({
  topic: requiredText('Topic or question for deep multi-step research'),
  searchDepth: withFieldMetadata(
    z.int().min(1).max(5).optional().default(2),
    'Search depth, default 2; deep research only when `mode=deep` is explicit.',
  ),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  fileSearch: withFieldMetadata(
    OptionalFileSearchSpecSchema,
    'Enable Gemini File Search over named stores alongside agentic research.',
  ),
});
export type AgenticSearchInput = z.infer<typeof AgenticSearchInputSchema>;

export const AnalyzeFileInputSchema = z.strictObject({
  filePath: workspacePath('Workspace-relative or absolute path to the file'),
  question: requiredText('What to analyze or ask about the file'),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
});
export type AnalyzeFileInput = z.infer<typeof AnalyzeFileInputSchema>;

export const AnalyzeUrlInputSchema = z.strictObject({
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze',
    description: 'URLs to analyze (max 20). Must be publicly accessible.',
    min: 1,
    max: 20,
  }),
  question: requiredText('What to analyze or ask about the URL content'),
  systemInstruction: optionalField(
    textField('Instructions for output presentation (format, rubric, audience).'),
  ),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  fileSearch: withFieldMetadata(
    OptionalFileSearchSpecSchema,
    'Enable Gemini File Search over named stores alongside URL analysis.',
  ),
});
export type AnalyzeUrlInput = z.infer<typeof AnalyzeUrlInputSchema>;

export interface AnalyzePrInput {
  dryRun?: boolean | undefined;
  focus?: string | undefined;
  language?: string | undefined;
  thinkingBudget?: ReviewInput['thinkingBudget'];
  thinkingLevel?: ReviewInput['thinkingLevel'];
}

export const ExplainErrorInputSchema = z.strictObject({
  error: requiredText('Error message, stack trace, or log output to diagnose'),
  codeContext: optionalField(textField('Relevant source code context.')),
  language: optionalField(textField('Programming language hint.')),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search to look up error messages in docs, issues, and forums.',
  ),
  ...createUrlContextFields({
    itemDescription: 'Public URL for additional context',
    description: 'URLs for additional context (docs, issues). Enables URL Context (max 20).',
    max: 20,
    optional: true,
  }),
});

export const CompareFilesInputSchema = z.strictObject({
  ...createFilePairFields(
    'Workspace-relative or absolute path to the first file',
    'Workspace-relative or absolute path to the second file',
  ),
  question: optionalField(textField('Comparison focus (e.g., API changes, behavior, security).')),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search for best practices or migration context.',
  ),
  ...createUrlContextFields({
    itemDescription: 'Public URL to include via URL Context',
    description: 'Public URLs for additional context (max 20). Enables URL Context.',
    max: 20,
    optional: true,
  }),
});
export type CompareFilesInput = z.infer<typeof CompareFilesInputSchema>;

export const GenerateDiagramInputSchema = z
  .strictObject({
    description: requiredText('What to diagram: architecture, flow, sequence, etc.'),
    diagramType: withFieldMetadata(
      z.enum(DIAGRAM_TYPES).optional().default('mermaid'),
      'Diagram syntax to generate. Use `mermaid` for common Markdown workflows or `plantuml` when that ecosystem is required.',
    ),
    sourceFilePath: workspacePath(
      'Workspace-relative or absolute path to a single source file to derive the diagram from',
    ).optional(),
    sourceFilePaths: workspacePathArray({
      description:
        'Multiple source files to derive the diagram from. Use when architecture or flow understanding depends on more than one file.',
      itemDescription:
        'Workspace-relative or absolute path to a source file for diagram generation',
      min: 1,
      max: 10,
      optional: true,
    }),
    thinkingLevel: thinkingLevelField,
    googleSearch: withFieldMetadata(
      z.boolean().optional(),
      'Enable Google Search for diagram syntax help or pattern reference.',
    ),
    validateSyntax: withFieldMetadata(
      z.boolean().optional(),
      'Validate generated diagram syntax in execution sandbox.',
    ),
  })
  .superRefine(validateExclusiveSourceFileFields);
