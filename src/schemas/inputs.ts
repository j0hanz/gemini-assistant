import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';
import type { ParsePayload } from 'zod/v4/core';

import { AppError } from '../lib/errors.js';
import { parseJson } from '../lib/json.js';

import {
  analyzeOutputKind,
  analyzeTargetKind,
  createGenerationConfigFields,
  createUrlContextFields,
  DIAGRAM_TYPES,
  FunctionResponsesSchema,
  goalText,
  mediaResolution,
  optionalField,
  researchMode,
  REVIEW_SUBJECT_OPTIONS,
  sessionId,
  textField,
  thinkingBudget,
  thinkingLevel,
  ToolsSpecSchema,
  withFieldMetadata,
  workspacePath,
  workspacePathArray,
} from './fields.js';
import { validateGeminiJsonSchema, validatePropertyKeyList } from './validators.js';

const JSON_LITERAL_SCHEMA = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const JSON_SCHEMA_TYPE_SCHEMA = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
]);

const RESPONSE_SCHEMA_SHAPE_KEYS = [
  'type',
  'properties',
  'required',
  'enum',
  'format',
  'items',
  'description',
  'nullable',
] as const;

function hasSchemaShape(value: Record<string, unknown>): boolean {
  return RESPONSE_SCHEMA_SHAPE_KEYS.some((key) => key in value);
}

function geminiResponsePropertyName(description: string) {
  return z.string().min(1).describe(description);
}

function geminiResponseTextField(description: string) {
  return z.string().trim().min(1).describe(description);
}

export const GeminiResponseSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .strictObject({
      type: JSON_SCHEMA_TYPE_SCHEMA.optional().describe('JSON Schema type for the output value.'),

      nullable: z.boolean().optional().describe('Allows the value to be null.'),

      properties: z
        .record(z.string(), GeminiResponseSchema)
        .optional()
        .describe('Property definitions for an object response.'),

      required: z
        .array(geminiResponsePropertyName('Required property name.'))
        .optional()
        .describe('List of required object property names.'),

      enum: z
        .array(JSON_LITERAL_SCHEMA)
        .min(1)
        .optional()
        .describe('Fixed set of allowed literal values.'),

      format: geminiResponseTextField(
        'String format hint (e.g., "date-time", "email").',
      ).optional(),

      items: GeminiResponseSchema.optional().describe('Schema for array elements.'),

      title: geminiResponseTextField('Short human-readable label.').optional(),

      description: geminiResponseTextField(
        'Human-readable explanation of schema node. Crucial for guiding the LLM.',
      ).optional(),
    })
    .superRefine((schema, ctx) => {
      if (schema.required) {
        validatePropertyKeyList(
          ctx,
          schema.properties ? new Set(Object.keys(schema.properties)) : undefined,
          schema.required,
          'required',
          'required can only be used when properties is present.',
          'required must not contain duplicate property names.',
        );
      }
    })
    .refine(hasSchemaShape, {
      error:
        'responseSchema must contain at least one supported JSON Schema keyword (type, properties, required, enum, format, items, or description)',
    }),
);

export type GeminiResponseSchema = z.infer<typeof GeminiResponseSchema>;

type SessionIdCompleter = (prefix?: string) => string[];

const thinkingLevelField = thinkingLevel();
const thinkingBudgetField = thinkingBudget();
const generationConfigFields = createGenerationConfigFields();

export function parseResponseSchemaJsonValue(raw: string): GeminiResponseSchema {
  const parsed = parseJson(raw);
  if (parsed === undefined) {
    throw new SyntaxError('responseSchemaJson must be valid JSON.');
  }
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
    const reason =
      error instanceof SyntaxError
        ? 'json_syntax'
        : error instanceof AppError
          ? 'unsupported_keyword'
          : error instanceof z.ZodError
            ? 'shape_mismatch'
            : 'json_syntax';

    payload.issues.push({
      code: 'custom',
      input: payload.value,
      params: { reason },
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
    'JSON Schema (2020-12) for structured output. Single-turn or new-session only; resumed sessions reject it.',
  );
}

export function createChatInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z.strictObject({
    goal: goalText(),
    sessionId: completable(
      optionalField(
        sessionId(
          'Server-managed in-memory session identifier. Provide it to start or resume a session; resumed sessions reject responseSchemaJson.',
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
    seed: withFieldMetadata(z.int().optional(), 'Fixed random seed for reproducible outputs.'),
    tools: withFieldMetadata(
      ToolsSpecSchema.optional(),
      'Tool profile and overrides for this chat turn. Selects Gemini built-in tools and thinking defaults.',
    ),
    functionResponses: withFieldMetadata(
      FunctionResponsesSchema.optional(),
      'Caller-executed Gemini function responses for an existing session. Requires sessionId and continues the model after functionCalls returned by a previous turn.',
    ),
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

const RESEARCH_MODE_DESCRIPTION = 'Research mode selector (`quick` or `deep`).';
const ANALYZE_TARGET_KIND_DESCRIPTION =
  'What to analyze: one file, one or more public URLs, or a small local file set.';
const ANALYZE_OUTPUT_KIND_DESCRIPTION =
  'Requested output format: summary text or a generated diagram.';
const REVIEW_SUBJECT_KIND_DESCRIPTION =
  'What to review: the current diff, a file comparison, or a failure report.';

function addSelectorIssue(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  field: string,
  message: string,
  input: unknown,
): void {
  ctx.addIssue({
    code: 'custom',
    message,
    path: [field],
    input,
  });
}

function validateAnalyzeOutputSelection(
  value: {
    outputKind?: 'diagram' | 'summary' | undefined;
    diagramType?: string | undefined;
    validateSyntax?: boolean | undefined;
  },
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  const outputKind = value.outputKind ?? 'summary';

  if (outputKind !== 'summary') {
    return;
  }

  if (value.validateSyntax !== undefined) {
    addSelectorIssue(
      ctx,
      'validateSyntax',
      'validateSyntax is not allowed when outputKind=summary.',
      value.validateSyntax,
    );
  }

  if (value.diagramType !== undefined) {
    addSelectorIssue(
      ctx,
      'diagramType',
      'diagramType is not allowed when outputKind=summary.',
      value.diagramType,
    );
  }
}

const researchSharedShape = {
  goal: goalText('Question or research goal to answer quickly'),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
  tools: withFieldMetadata(
    ToolsSpecSchema.optional(),
    'Tool profile and overrides for research. Defaults to web-research (quick) or deep-research (deep).',
  ),
};

const ResearchInputBaseSchema = z.strictObject({
  mode: researchMode(RESEARCH_MODE_DESCRIPTION),
  ...researchSharedShape,
  systemInstruction: optionalField(
    textField(
      'Instructions for output presentation (format, audience, tone). Allowed only when mode=quick.',
    ),
  ),
  deliverable: optionalField(
    textField(
      'Requested output form (brief, report, checklist, etc.). Allowed only when mode=deep.',
    ),
  ),
  searchDepth: withFieldMetadata(
    z.int().min(1).max(5).optional(),
    'Search depth, default 2. Allowed only when mode=deep.',
  ),
});

const ResearchQuickSchema = z.strictObject({
  mode: withFieldMetadata(z.literal('quick').default('quick'), RESEARCH_MODE_DESCRIPTION),
  ...researchSharedShape,
  systemInstruction: optionalField(
    textField('Instructions for output presentation (format, audience, tone).'),
  ),
});

const ResearchDeepSchema = z.strictObject({
  mode: withFieldMetadata(z.literal('deep'), RESEARCH_MODE_DESCRIPTION),
  ...researchSharedShape,
  deliverable: optionalField(textField('Requested output form (brief, report, checklist, etc.).')),
  searchDepth: withFieldMetadata(
    z.int().min(1).max(5).optional(),
    'Search depth, default 2. Only used for deep research.',
  ),
});

const ResearchVariantSchema = z.discriminatedUnion('mode', [
  ResearchQuickSchema,
  ResearchDeepSchema,
]);

export const ResearchInputSchema = ResearchInputBaseSchema.pipe(
  ResearchVariantSchema as unknown as z.ZodType<
    z.infer<typeof ResearchVariantSchema>,
    z.infer<typeof ResearchInputBaseSchema>
  >,
);
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

const AnalyzeInputBaseSchema = z.strictObject({
  goal: goalText('Question or analysis goal for the selected targets'),
  targetKind: analyzeTargetKind(ANALYZE_TARGET_KIND_DESCRIPTION),
  filePath: optionalField(
    workspacePath(
      'Workspace-relative or absolute path to analyze when targetKind=file. Allowed only when targetKind=file.',
    ),
  ),
  urls: createUrlContextFields({
    itemDescription: 'Public URL to analyze',
    description: 'Public URLs to analyze when targetKind=url. Allowed only when targetKind=url.',
    min: 1,
    max: 20,
    optional: true,
  }).urls,
  filePaths: workspacePathArray({
    description:
      'Local files to analyze when targetKind=multi. Allowed only when targetKind=multi.',
    itemDescription: 'Workspace-relative or absolute path to a local file',
    min: 2,
    max: 5,
    optional: true,
  }),
  outputKind: analyzeOutputKind(ANALYZE_OUTPUT_KIND_DESCRIPTION),
  diagramType: withFieldMetadata(
    z.enum(DIAGRAM_TYPES).optional(),
    'Diagram syntax to generate when outputKind=diagram. Defaults to mermaid. Allowed only when outputKind=diagram.',
  ),
  validateSyntax: z
    .boolean()
    .optional()
    .describe(
      'Validate generated diagram syntax when outputKind=diagram. Allowed only when outputKind=diagram.',
    ),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
  tools: withFieldMetadata(
    ToolsSpecSchema.optional(),
    'Tool profile and overrides for analysis. Defaults to code-math; auto-promotes to visual-inspect for image inputs with thinking >= medium.',
  ),
});

const analyzeSharedShape = {
  goal: goalText('Question or analysis goal for the selected targets'),
  outputKind: analyzeOutputKind(ANALYZE_OUTPUT_KIND_DESCRIPTION),
  diagramType: withFieldMetadata(
    z.enum(DIAGRAM_TYPES).optional(),
    'Diagram syntax to generate when outputKind=diagram. Defaults to mermaid.',
  ),
  validateSyntax: z.boolean().optional().describe('Validate generated diagram syntax.'),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
  tools: withFieldMetadata(ToolsSpecSchema.optional(), 'Tool profile and overrides for analysis.'),
};

const AnalyzeFileSchema = z
  .strictObject({
    targetKind: withFieldMetadata(
      z.literal('file').default('file'),
      ANALYZE_TARGET_KIND_DESCRIPTION,
    ),
    ...analyzeSharedShape,
    filePath: workspacePath('Workspace-relative or absolute path to analyze when targetKind=file'),
  })
  .superRefine(validateAnalyzeOutputSelection);

const AnalyzeUrlSchema = z
  .strictObject({
    targetKind: withFieldMetadata(z.literal('url'), ANALYZE_TARGET_KIND_DESCRIPTION),
    ...analyzeSharedShape,
    urls: createUrlContextFields({
      itemDescription: 'Public URL to analyze',
      description: 'Public URLs to analyze when targetKind=url.',
      min: 1,
      max: 20,
      optional: false,
    }).urls,
  })
  .superRefine(validateAnalyzeOutputSelection);

const AnalyzeMultiSchema = z
  .strictObject({
    targetKind: withFieldMetadata(z.literal('multi'), ANALYZE_TARGET_KIND_DESCRIPTION),
    ...analyzeSharedShape,
    filePaths: workspacePathArray({
      description: 'Local files to analyze when targetKind=multi.',
      itemDescription: 'Workspace-relative or absolute path to a local file',
      min: 2,
      max: 5,
    }),
  })
  .superRefine(validateAnalyzeOutputSelection);

const AnalyzeVariantSchema = z.discriminatedUnion('targetKind', [
  AnalyzeFileSchema,
  AnalyzeUrlSchema,
  AnalyzeMultiSchema,
]);

export const AnalyzeInputSchema = AnalyzeInputBaseSchema.pipe(
  AnalyzeVariantSchema as unknown as z.ZodType<
    z.infer<typeof AnalyzeVariantSchema>,
    z.infer<typeof AnalyzeInputBaseSchema>
  >,
);
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
const reviewCommonShape = {
  focus: optionalField(textField('Review priorities (e.g. regressions, security, performance).')),
  thinkingLevel: thinkingLevelField,
  thinkingBudget: thinkingBudgetField,
  ...generationConfigFields,
  tools: withFieldMetadata(
    ToolsSpecSchema.optional(),
    'Tool profile and overrides for review. Defaults to plain (diff), web-research (failure), or urls-only (comparison with URLs).',
  ),
};

const ReviewInputBaseSchema = z.strictObject({
  subjectKind: withFieldMetadata(
    z.enum(REVIEW_SUBJECT_OPTIONS).default('diff'),
    REVIEW_SUBJECT_KIND_DESCRIPTION,
  ),
  dryRun: withFieldMetadata(
    z.boolean().optional(),
    'Skip model review for subjectKind=diff. Allowed only when subjectKind=diff.',
  ),
  language: optionalField(
    textField(
      'Primary language hint for diff or failure review. Allowed only when subjectKind=diff or failure.',
    ),
  ),
  filePathA: optionalField(
    workspacePath(
      'Workspace-relative or absolute path to the first file when subjectKind=comparison. Allowed only when subjectKind=comparison.',
    ),
  ),
  filePathB: optionalField(
    workspacePath(
      'Workspace-relative or absolute path to the second file when subjectKind=comparison. Allowed only when subjectKind=comparison.',
    ),
  ),
  question: optionalField(
    textField(
      'Comparison focus when subjectKind=comparison (behavior, APIs, security, etc.). Allowed only when subjectKind=comparison.',
    ),
  ),
  error: optionalField(
    textField(
      'Error message or stack trace when subjectKind=failure. Allowed only when subjectKind=failure.',
      32_000,
    ),
  ),
  codeContext: optionalField(
    textField(
      'Relevant source code context when subjectKind=failure. Allowed only when subjectKind=failure.',
      16_000,
    ),
  ),
  ...reviewCommonShape,
});

const ReviewDiffSchema = z.strictObject({
  subjectKind: withFieldMetadata(
    z.literal('diff').default('diff'),
    REVIEW_SUBJECT_KIND_DESCRIPTION,
  ),
  dryRun: withFieldMetadata(z.boolean().optional(), 'Skip model review for subjectKind=diff.'),
  language: optionalField(textField('Primary language hint for diff or failure review.')),
  ...reviewCommonShape,
});

const ReviewComparisonSchema = z.strictObject({
  subjectKind: withFieldMetadata(z.literal('comparison'), REVIEW_SUBJECT_KIND_DESCRIPTION),
  filePathA: workspacePath(
    'Workspace-relative or absolute path to the first file when subjectKind=comparison',
  ),
  filePathB: workspacePath(
    'Workspace-relative or absolute path to the second file when subjectKind=comparison',
  ),
  question: optionalField(
    textField('Comparison focus when subjectKind=comparison (behavior, APIs, security, etc.).'),
  ),
  ...reviewCommonShape,
});

const ReviewFailureSchema = z.strictObject({
  subjectKind: withFieldMetadata(z.literal('failure'), REVIEW_SUBJECT_KIND_DESCRIPTION),
  language: optionalField(textField('Primary language hint for diff or failure review.')),
  error: textField('Error message or stack trace when subjectKind=failure.', 32_000),
  codeContext: optionalField(
    textField('Relevant source code context when subjectKind=failure.', 16_000),
  ),
  ...reviewCommonShape,
});

const ReviewVariantSchema = z.discriminatedUnion('subjectKind', [
  ReviewDiffSchema,
  ReviewComparisonSchema,
  ReviewFailureSchema,
]);

export const ReviewInputSchema = ReviewInputBaseSchema.pipe(
  ReviewVariantSchema as unknown as z.ZodType<
    z.infer<typeof ReviewVariantSchema>,
    z.infer<typeof ReviewInputBaseSchema>
  >,
);
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
