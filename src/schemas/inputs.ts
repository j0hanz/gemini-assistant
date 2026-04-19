import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';
import type { ParsePayload } from 'zod/v4/core';

import {
  ASK_NON_URL_TOOL_PROFILES,
  ASK_URL_TOOL_PROFILES,
  boundedFloat,
  completableCacheName,
  DIAGRAM_TYPES,
  enumField,
  goalText,
  mediaResolution,
  optionalField,
  PublicJobNameSchema,
  requiredText,
  REVIEW_SUBJECT_OPTIONS,
  sessionId,
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
  validateExclusiveSourceFileFields,
  validateFlatAnalyzeInput,
  validateFlatMemoryInput,
  validateFlatResearchInput,
  validateFlatReviewInput,
  validateMeaningfulCacheCreateInput,
} from './validators.js';

type SessionIdCompleter = (prefix?: string) => string[];

const thinkingLevelField = thinkingLevel();

function validateResponseSchemaJson(payload: ParsePayload<string>): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload.value) as unknown;
  } catch {
    payload.issues.push({
      code: 'custom',
      input: payload.value,
      message: 'responseSchemaJson must be valid JSON.',
    });
    return;
  }

  const result = GeminiResponseSchema.safeParse(parsed);
  if (result.success) {
    return;
  }

  payload.issues.push({
    code: 'custom',
    input: payload.value,
    message: `responseSchemaJson must match the supported schema.\n${z.prettifyError(result.error)}`,
  });
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
    temperature: optionalField(
      boundedFloat('Sampling temperature (0.0 to 2.0). Lower is more deterministic.', 0, 2),
    ),
    seed: withFieldMetadata(z.int().optional(), 'Fixed random seed for reproducible outputs.'),
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

export const ResearchInputSchema = z
  .strictObject({
    mode: enumField(['quick', 'deep'], 'Research mode selector (`quick` or `deep`).'),
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
    deliverable: optionalField(
      textField('Requested output form (brief, report, checklist, etc.).'),
    ),
    searchDepth: withFieldMetadata(
      z.int().min(1).max(5).optional(),
      'How many search-and-synthesis passes to perform. Use higher values for broader or more thorough deep research.',
    ),
    thinkingLevel: thinkingLevelField,
  })
  .superRefine(validateFlatResearchInput)
  .transform((value) =>
    value.mode === 'deep' && value.searchDepth === undefined ? { ...value, searchDepth: 3 } : value,
  );
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

export const AnalyzeInputSchema = z
  .strictObject({
    goal: goalText('Question or analysis goal for the selected targets'),
    targetKind: enumField(
      ['file', 'url', 'multi'],
      'What to analyze: one file, one or more public URLs, or a small local file set.',
    ),
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
    outputKind: enumField(
      ['summary', 'diagram'],
      'Requested output format: summary text or a generated diagram.',
    ),
    diagramType: optionalField(
      enumField(DIAGRAM_TYPES, 'Diagram syntax to generate when outputKind=diagram.'),
    ),
    validateSyntax: z
      .boolean()
      .optional()
      .describe('Validate generated diagram syntax when outputKind=diagram.'),
    thinkingLevel: thinkingLevelField,
    mediaResolution: mediaResolution(
      'Resolution for image/video processing. Higher = more detail, more tokens.',
    ),
  })
  .superRefine(validateFlatAnalyzeInput);
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
export const ReviewInputSchema = z
  .strictObject({
    subjectKind: enumField(
      REVIEW_SUBJECT_OPTIONS,
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
    googleSearch: withFieldMetadata(
      z.boolean().optional(),
      'Enable Google Search when subjectKind=comparison or subjectKind=failure.',
    ),
    error: optionalField(textField('Error message or stack trace when subjectKind=failure.')),
    codeContext: optionalField(textField('Relevant source code context when subjectKind=failure.')),
    ...createUrlContextFields({
      itemDescription: 'Public URL for additional context',
      description: 'Public URLs for additional context when subjectKind=failure.',
      max: 20,
      optional: true,
    }),
    focus: optionalField(textField('Review priorities (e.g. regressions, security, performance).')),
    thinkingLevel: thinkingLevelField,
    cacheName: completableCacheName(
      'Cache resource name to provide project context during review.',
      true,
    ),
  })
  .superRefine(validateFlatReviewInput);
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export function createMemoryInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z
    .strictObject({
      action: enumField(
        [
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
        ],
        'Memory action selector.',
      ),
      sessionId: completable(
        optionalField(sessionId('Session identifier to inspect')),
        completeSessionIds,
      ),
      cacheName: completableCacheName('Cache resource name to inspect', true),
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
      confirm: withFieldMetadata(
        z.boolean().optional(),
        'Confirmation override for non-interactive clients.',
      ),
    })
    .superRefine(validateFlatMemoryInput);
}

export const MemoryInputSchema = createMemoryInputSchema();
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

export const DiscoverInputSchema = z.strictObject({
  job: withFieldMetadata(
    optionalField(PublicJobNameSchema),
    'Public job to focus discovery guidance on.',
  ),
  goal: optionalField(textField('User outcome to optimize for.')),
});
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;

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
    temperature: optionalField(
      boundedFloat('Sampling temperature (0.0 to 2.0). Lower is more deterministic.', 0, 2),
    ),
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
export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

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
export type ExplainErrorInput = z.infer<typeof ExplainErrorInputSchema>;

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
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInputSchema>;
