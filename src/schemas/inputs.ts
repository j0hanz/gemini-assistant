import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';
import type { ParsePayload } from 'zod/v4/core';

import {
  analyzeOutputKind,
  analyzeTargetKind,
  ASK_NON_URL_TOOL_PROFILES,
  ASK_URL_TOOL_PROFILES,
  completableCacheName,
  DIAGRAM_TYPES,
  enumField,
  goalText,
  mediaResolution,
  optionalField,
  requiredText,
  researchMode,
  sessionId,
  temperatureField,
  textField,
  thinkingLevel,
  ttlSeconds,
  withFieldMetadata,
  workspacePath,
  workspacePathArray,
} from './fields.js';
import {
  createFilePairFields,
  createOptionalCacheReferenceFields,
  createUrlContextFields,
} from './fragments.js';
import { GeminiResponseSchema } from './json-schema.js';
import {
  MEMORY_ACTIONS,
  type MemoryAction,
  validateExclusiveSourceFileFields,
  validateFlatAnalyzeInput,
  validateFlatResearchInput,
  validateMeaningfulCacheCreateInput,
} from './validators.js';

type SessionIdCompleter = (prefix?: string) => string[];

const thinkingLevelField = thinkingLevel();

export function parseResponseSchemaJsonValue(raw: string): GeminiResponseSchema {
  const parsed = JSON.parse(raw) as unknown;
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
        error instanceof z.ZodError
          ? `responseSchemaJson must match the supported schema.\n${z.prettifyError(error)}`
          : 'responseSchemaJson must be valid JSON.',
    });
  }
}

function responseSchemaJsonField() {
  return withFieldMetadata(
    z.string().trim().min(1).check(validateResponseSchemaJson).optional(),
    'Structured output schema as JSON. Use JSON input instead of nested form fields.',
  );
}

export function createChatInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z.strictObject({
    goal: goalText(),
    sessionId: completable(
      optionalField(sessionId('Server-managed in-memory session identifier.')),
      completeSessionIds,
    ),
    cacheName: completableCacheName(
      'Gemini cache resource name to attach as reusable context.',
      true,
    ),
    systemInstruction: optionalField(
      textField('System instructions for response style, constraints, or behavior.'),
    ),
    thinkingLevel: thinkingLevelField,
    responseSchemaJson: responseSchemaJsonField(),
    temperature: temperatureField(),
    seed: withFieldMetadata(z.int().optional(), 'Fixed random seed for reproducible outputs.'),
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

export const ResearchInputBaseSchema = z.strictObject({
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
    z.int().min(1).max(5).default(3).optional(),
    'How many search-and-synthesis passes to perform. Use higher values for broader or more thorough deep research.',
  ),
  thinkingLevel: thinkingLevelField,
});
export const ResearchInputSchema = ResearchInputBaseSchema.superRefine(validateFlatResearchInput);
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

export const AnalyzeInputBaseSchema = z.strictObject({
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
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
});
export const AnalyzeInputSchema = AnalyzeInputBaseSchema.superRefine(validateFlatAnalyzeInput);
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
const reviewSubjectKindLiteral = <T extends 'diff' | 'comparison' | 'failure'>(value: T) =>
  withFieldMetadata(
    value === 'diff' ? z.literal(value).default(value) : z.literal(value),
    'What to review: the current diff, a file comparison, or a failure report.',
  );

const reviewCommonShape = {
  focus: optionalField(textField('Review priorities (e.g. regressions, security, performance).')),
  thinkingLevel: thinkingLevelField,
  cacheName: completableCacheName(
    'Cache resource name to provide project context during review.',
    true,
  ),
};

const ReviewDiffInputSchema = z.strictObject({
  subjectKind: reviewSubjectKindLiteral('diff'),
  dryRun: withFieldMetadata(z.boolean().optional(), 'Skip model review for subjectKind=diff.'),
  language: optionalField(textField('Primary language hint for diff or failure review.')),
  ...reviewCommonShape,
});

const ReviewComparisonInputSchema = z.strictObject({
  subjectKind: reviewSubjectKindLiteral('comparison'),
  filePathA: workspacePath(
    'Workspace-relative or absolute path to the first file when subjectKind=comparison',
  ),
  filePathB: workspacePath(
    'Workspace-relative or absolute path to the second file when subjectKind=comparison',
  ),
  question: optionalField(
    textField('Comparison focus when subjectKind=comparison (behavior, APIs, security, etc.).'),
  ),
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search when subjectKind=comparison or subjectKind=failure.',
  ),
  ...reviewCommonShape,
});

const ReviewFailureInputSchema = z.strictObject({
  subjectKind: reviewSubjectKindLiteral('failure'),
  language: optionalField(textField('Primary language hint for diff or failure review.')),
  error: textField('Error message or stack trace when subjectKind=failure.'),
  codeContext: optionalField(textField('Relevant source code context when subjectKind=failure.')),
  ...createUrlContextFields({
    itemDescription: 'Public URL for additional context',
    description: 'Public URLs for additional context when subjectKind=failure.',
    max: 20,
    optional: true,
  }),
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search when subjectKind=comparison or subjectKind=failure.',
  ),
  ...reviewCommonShape,
});

const ReviewInputUnionSchema = z.discriminatedUnion('subjectKind', [
  ReviewDiffInputSchema,
  ReviewComparisonInputSchema,
  ReviewFailureInputSchema,
]);

export const ReviewInputSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && !('subjectKind' in value)) {
    return { ...value, subjectKind: 'diff' };
  }

  return value;
}, ReviewInputUnionSchema);
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const memoryActionField = <T extends MemoryAction>(action: T) =>
  withFieldMetadata(z.literal(action), 'Memory action selector.');

function createSessionIdField(completeSessionIds: SessionIdCompleter) {
  return completable(sessionId('Session identifier to inspect'), completeSessionIds);
}

function createMemoryNoArgumentSchema<T extends MemoryAction>(action: T) {
  return z.strictObject({
    action: memoryActionField(action),
  });
}

function createMemorySessionSchema<T extends MemoryAction>(
  action: T,
  completeSessionIds: SessionIdCompleter,
) {
  return z.strictObject({
    action: memoryActionField(action),
    sessionId: createSessionIdField(completeSessionIds),
  });
}

function createMemoryCacheGetSchema<T extends MemoryAction>(action: T) {
  return z.strictObject({
    action: memoryActionField(action),
    cacheName: completableCacheName('Cache resource name'),
  });
}

function createMemoryCacheCreateSchema() {
  return z
    .strictObject({
      action: memoryActionField('caches.create'),
      filePaths: workspacePathArray({
        description: 'Files to include in the cache.',
        itemDescription: 'Workspace-relative or absolute path to a file to cache',
        max: 50,
        optional: true,
      }),
      systemInstruction: optionalField(
        requiredText('System instruction to store alongside the cached files.'),
      ),
      ttl: optionalField(ttlSeconds('Time-to-live for the cache (e.g. "3600s").')),
      displayName: optionalField(textField('Human-readable label for the cache.')),
    })
    .superRefine(validateMeaningfulCacheCreateInput);
}

function createMemoryCacheUpdateSchema() {
  return z.strictObject({
    action: memoryActionField('caches.update'),
    cacheName: completableCacheName('Cache resource name'),
    ttl: ttlSeconds('Time-to-live for the cache (e.g. "3600s").'),
  });
}

function createMemoryCacheDeleteSchema() {
  return z.strictObject({
    action: memoryActionField('caches.delete'),
    cacheName: completableCacheName('Cache resource name'),
    confirm: withFieldMetadata(
      z.boolean().optional(),
      'Confirmation override for non-interactive clients.',
    ),
  });
}

export function createMemoryInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z.discriminatedUnion('action', [
    createMemoryNoArgumentSchema(MEMORY_ACTIONS[0]),
    createMemorySessionSchema(MEMORY_ACTIONS[1], completeSessionIds),
    createMemorySessionSchema(MEMORY_ACTIONS[2], completeSessionIds),
    createMemorySessionSchema(MEMORY_ACTIONS[3], completeSessionIds),
    createMemoryNoArgumentSchema(MEMORY_ACTIONS[4]),
    createMemoryCacheGetSchema(MEMORY_ACTIONS[5]),
    createMemoryCacheCreateSchema(),
    createMemoryCacheUpdateSchema(),
    createMemoryCacheDeleteSchema(),
    createMemoryNoArgumentSchema(MEMORY_ACTIONS[9]),
    createMemoryNoArgumentSchema(MEMORY_ACTIONS[10]),
  ]);
}

export const MemoryInputSchema = createMemoryInputSchema();
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

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
    cacheName: completableCacheName(
      'Cache name from memory action=caches.create. Cannot be applied to an existing chat session.',
      true,
    ),
    responseSchema: withFieldMetadata(
      GeminiResponseSchema.optional(),
      'JSON Schema for structured output.',
    ),
    temperature: temperatureField(),
    seed: withFieldMetadata(z.int().optional(), 'Fixed random seed for reproducible outputs.'),
    googleSearch: withFieldMetadata(
      z.boolean().optional(),
      'Legacy shortcut to enable Google Search (prefer toolProfile="search").',
    ),
  };

  return z.union([
    z.strictObject({
      ...askCommonShape,
    }),
    z.strictObject({
      ...askCommonShape,
      toolProfile: enumField(
        ASK_NON_URL_TOOL_PROFILES,
        'Built-in tool preset (`none`, `search`, `code`, or `search_code`).',
      ),
    }),
    z.strictObject({
      ...askCommonShape,
      toolProfile: enumField(
        ASK_URL_TOOL_PROFILES,
        'Built-in tool preset (`url` or `search_url`).',
      ),
      ...createUrlContextFields({
        itemDescription: 'Public URL to analyze with URL Context',
        description: 'URLs for URL Context when using toolProfile=url or search_url (max 20).',
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
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const AgenticSearchInputSchema = z.strictObject({
  topic: requiredText('Topic or question for deep multi-step research'),
  searchDepth: withFieldMetadata(
    z.int().min(1).max(5).optional().default(3),
    'How many search iterations to perform during deep research. Use higher values for more exhaustive investigation.',
  ),
  thinkingLevel: thinkingLevelField,
});
export type AgenticSearchInput = z.infer<typeof AgenticSearchInputSchema>;

export const AnalyzeFileInputSchema = z.strictObject({
  filePath: workspacePath('Workspace-relative or absolute path to the file'),
  question: requiredText('What to analyze or ask about the file'),
  thinkingLevel: thinkingLevelField,
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
});
export type AnalyzeUrlInput = z.infer<typeof AnalyzeUrlInputSchema>;

export const AnalyzePrInputSchema = z.strictObject({
  dryRun: withFieldMetadata(
    z.boolean().optional(),
    'Skip model review, return diff snapshot only.',
  ),
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during review.',
  ),
  thinkingLevel: thinkingLevelField,
  language: optionalField(textField('Primary language hint.')),
  focus: optionalField(textField('Optional review focus hint.')),
});
export type AnalyzePrInput = z.infer<typeof AnalyzePrInputSchema>;

const createCacheSystemInstructionSchema = requiredText(
  'System instruction to store in the cache.',
);
const createCacheSharedShape = {
  ttl: optionalField(ttlSeconds('Time-to-live for the cache (e.g., "3600s").')),
  displayName: optionalField(textField('Human-readable label for the cache.')),
};

export const CreateCacheInputSchema = z
  .strictObject({
    filePaths: workspacePathArray({
      description: 'Workspace-relative or absolute paths to files to cache.',
      itemDescription: 'Workspace-relative or absolute path to a file to cache',
      max: 50,
      optional: true,
    }),
    systemInstruction: createCacheSystemInstructionSchema.optional(),
    ...createCacheSharedShape,
  })
  .superRefine(validateMeaningfulCacheCreateInput)
  .describe('Create a Gemini API cache for reusable large context (requires ~32k tokens min).');
export type CreateCacheInput = z.infer<typeof CreateCacheInputSchema>;

function createCacheNameSchema(action: 'delete' | 'update') {
  return completableCacheName(`Cache resource name to ${action} (e.g., "cachedContents/...")`);
}

export const DeleteCacheInputSchema = z.strictObject({
  cacheName: createCacheNameSchema('delete'),
  confirm: withFieldMetadata(
    z.boolean().optional(),
    'Confirmation override for non-interactive clients.',
  ),
});
export type DeleteCacheInput = z.infer<typeof DeleteCacheInputSchema>;

export const UpdateCacheInputSchema = z.strictObject({
  cacheName: createCacheNameSchema('update'),
  ttl: ttlSeconds('New TTL from now (e.g., "7200s" for 2 hours)'),
});
export type UpdateCacheInput = z.infer<typeof UpdateCacheInputSchema>;

export const ExplainErrorInputSchema = z.strictObject({
  error: requiredText('Error message, stack trace, or log output to diagnose'),
  codeContext: optionalField(textField('Relevant source code context.')),
  language: optionalField(textField('Programming language hint.')),
  thinkingLevel: thinkingLevelField,
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
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during diagnosis.',
  ),
});

export const CompareFilesInputSchema = z.strictObject({
  ...createFilePairFields(
    'Workspace-relative or absolute path to the first file',
    'Workspace-relative or absolute path to the second file',
  ),
  question: optionalField(textField('Comparison focus (e.g., API changes, behavior, security).')),
  thinkingLevel: thinkingLevelField,
  googleSearch: withFieldMetadata(
    z.boolean().optional(),
    'Enable Google Search for best practices or migration context.',
  ),
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during comparison.',
  ),
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
    ...createOptionalCacheReferenceFields(
      'Cache resource name to provide project context for diagram generation.',
    ),
    validateSyntax: withFieldMetadata(
      z.boolean().optional(),
      'Validate generated diagram syntax in execution sandbox.',
    ),
  })
  .superRefine(validateExclusiveSourceFileFields);
