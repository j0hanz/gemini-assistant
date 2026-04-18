import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import {
  ASK_NON_URL_TOOL_PROFILES,
  ASK_URL_TOOL_PROFILES,
  boundedFloat,
  boundedInt,
  completableCacheName,
  DIAGRAM_TYPES,
  enumField,
  goalText,
  mediaResolution,
  PublicJobNameSchema,
  requiredText,
  sessionId,
  textField,
  thinkingLevel,
  ttlSeconds,
  workspacePath,
  workspacePathArray,
} from './fields.js';
import {
  createFilePairFields,
  createOptionalCacheReferenceFields,
  createSessionContinuationFields,
  createUrlContextFields,
  MemoryRefSchema,
} from './fragments.js';
import { GeminiResponseSchema } from './json-schema.js';
import {
  validateExclusiveSourceFileFields,
  validateMeaningfulCacheCreateInput,
} from './validators.js';

type SessionIdCompleter = (prefix?: string) => string[];

const thinkingLevelField = thinkingLevel();

export function createChatInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z.strictObject({
    goal: goalText(),
    ...createSessionContinuationFields(completeSessionIds),
    memory: MemoryRefSchema,
    systemInstruction: textField(
      'System instructions for response style, constraints, or behavior.',
    ).optional(),
    thinkingLevel: thinkingLevel('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
    responseSchema: GeminiResponseSchema.optional().describe('JSON Schema for structured output.'),
    temperature: boundedFloat(
      'Sampling temperature (0.0 to 2.0). Lower is more deterministic.',
      0,
      2,
    )
      .optional()
      .describe('Sampling temperature (0.0 to 2.0). Lower is more deterministic.'),
    seed: z.int().optional().describe('Fixed random seed for reproducible outputs.'),
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

const QuickResearchInputSchema = z.strictObject({
  mode: z.literal('quick').describe('Research mode selector (`quick`).'),
  goal: goalText('Question or research goal to answer quickly'),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze alongside search results',
    description: 'Public URLs to inspect alongside web search results.',
    max: 20,
    optional: true,
  }),
  systemInstruction: textField(
    'Instructions for output presentation (format, audience, tone).',
  ).optional(),
  thinkingLevel: thinkingLevelField,
});

const DeepResearchInputSchema = z.strictObject({
  mode: z.literal('deep').describe('Research mode selector (`deep`).'),
  goal: goalText('Topic or research goal for a deeper multi-step investigation'),
  deliverable: textField('Requested output form (brief, report, checklist, etc.).').optional(),
  searchDepth: boundedInt(
    'How many search-and-synthesis passes to perform. Use higher values for broader or more thorough deep research.',
    1,
    5,
  )
    .optional()
    .default(3)
    .describe(
      'How many search-and-synthesis passes to perform. Use higher values for broader or more thorough deep research.',
    ),
  thinkingLevel: thinkingLevelField,
});

export const ResearchInputSchema = z.discriminatedUnion('mode', [
  QuickResearchInputSchema,
  DeepResearchInputSchema,
]);
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

const AnalyzeFileTargetsSchema = z.strictObject({
  kind: z.literal('file').describe('Target type (`file`).'),
  filePath: workspacePath('Workspace-relative or absolute path to the file'),
});

const AnalyzeUrlTargetsSchema = z.strictObject({
  kind: z.literal('url').describe('Target type (`url`).'),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze',
    description: 'One or more public URLs to analyze.',
    min: 1,
    max: 20,
  }),
});

const AnalyzeMultiTargetsSchema = z.strictObject({
  kind: z.literal('multi').describe('Target type (`multi`).'),
  filePaths: workspacePathArray({
    description: 'List of local files to analyze.',
    itemDescription: 'Workspace-relative or absolute path to a local file',
    min: 2,
    max: 5,
  }),
});

const AnalyzeTargetsSchema = z
  .discriminatedUnion('kind', [
    AnalyzeFileTargetsSchema,
    AnalyzeUrlTargetsSchema,
    AnalyzeMultiTargetsSchema,
  ])
  .describe('Target selection for analysis.');

const AnalyzeSummaryOutputSchema = z.strictObject({
  kind: z.literal('summary').describe('Analyze output selector (`summary`).'),
});

const AnalyzeDiagramOutputSchema = z.strictObject({
  kind: z.literal('diagram').describe('Analyze output selector (`diagram`).'),
  diagramType: enumField(DIAGRAM_TYPES, 'Diagram syntax to generate.'),
  validateSyntax: z
    .boolean()
    .optional()
    .describe('Validate generated diagram syntax in an execution sandbox.'),
});

const AnalyzeOutputSchema = z.discriminatedUnion('kind', [
  AnalyzeSummaryOutputSchema,
  AnalyzeDiagramOutputSchema,
]);

export const AnalyzeInputSchema = z.strictObject({
  goal: goalText('Question or analysis goal for the selected targets'),
  targets: AnalyzeTargetsSchema,
  output: AnalyzeOutputSchema.describe('Requested analysis output form.'),
  thinkingLevel: thinkingLevelField,
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
});
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;

const ReviewDiffSubjectSchema = z.strictObject({
  kind: z.literal('diff').describe('Subject type (`diff`).'),
  dryRun: z.boolean().optional().describe('Skip model review, return diff snapshot only.'),
  language: textField('Primary language hint.').optional(),
});

const ReviewComparisonSubjectSchema = z.strictObject({
  kind: z.literal('comparison').describe('Subject type (`comparison`).'),
  ...createFilePairFields(
    'Workspace-relative or absolute path to the first file',
    'Workspace-relative or absolute path to the second file',
  ),
  question: textField('Comparison focus (behavior, APIs, security, etc.).').optional(),
  googleSearch: z.boolean().optional().describe('Enable Google Search.'),
});

const ReviewFailureSubjectSchema = z.strictObject({
  kind: z.literal('failure').describe('Subject type (`failure`).'),
  error: requiredText('Error message or stack trace.'),
  codeContext: textField('Relevant source code context.').optional(),
  language: textField('Programming language hint.').optional(),
  googleSearch: z.boolean().optional().describe('Enable Google Search.'),
  ...createUrlContextFields({
    itemDescription: 'Public URL for additional context',
    description: 'Public URLs for additional failure context.',
    max: 20,
    optional: true,
  }),
});

const ReviewSubjectSchema = z
  .discriminatedUnion('kind', [
    ReviewDiffSubjectSchema,
    ReviewComparisonSubjectSchema,
    ReviewFailureSubjectSchema,
  ])
  .describe('Review subject details.');

export const ReviewInputSchema = z.strictObject({
  subject: ReviewSubjectSchema,
  focus: textField('Review priorities (e.g. regressions, security, performance).').optional(),
  thinkingLevel: thinkingLevelField,
  cacheName: completableCacheName(
    'Cache resource name to provide project context during review.',
    true,
  ),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const MemorySessionsListSchema = z.strictObject({
  action: z.literal('sessions.list').describe('Memory action (`sessions.list`).'),
});

export function createMemoryInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  const memorySessionIdField = completable(
    sessionId('Session identifier to inspect'),
    completeSessionIds,
  );

  const memorySessionsGetSchema = z.strictObject({
    action: z.literal('sessions.get').describe('Memory action (`sessions.get`).'),
    sessionId: memorySessionIdField,
  });

  const memorySessionsTranscriptSchema = z.strictObject({
    action: z.literal('sessions.transcript').describe('Memory action (`sessions.transcript`).'),
    sessionId: memorySessionIdField,
  });

  const memorySessionsEventsSchema = z.strictObject({
    action: z.literal('sessions.events').describe('Memory action (`sessions.events`).'),
    sessionId: memorySessionIdField,
  });

  const memoryCachesListSchema = z.strictObject({
    action: z.literal('caches.list').describe('Memory action (`caches.list`).'),
  });

  const memoryCachesGetSchema = z.strictObject({
    action: z.literal('caches.get').describe('Memory action (`caches.get`).'),
    cacheName: completableCacheName('Cache resource name to inspect'),
  });

  const memoryCachesCreateSchema = z
    .strictObject({
      action: z.literal('caches.create').describe('Memory action (`caches.create`).'),
      filePaths: z
        .array(workspacePath('Workspace-relative or absolute path to a file to cache'))
        .max(50)
        .optional()
        .describe('Files to include in the cache.'),
      systemInstruction: requiredText(
        'System instruction to store alongside the cached files.',
      ).optional(),
      ttl: ttlSeconds('Time-to-live for the cache (e.g. "3600s").').optional(),
      displayName: textField('Human-readable label for the cache.').optional(),
    })
    .superRefine(validateMeaningfulCacheCreateInput)
    .describe('Create a Gemini cache from files and/or a system instruction.');

  const memoryCachesUpdateSchema = z.strictObject({
    action: z.literal('caches.update').describe('Memory action (`caches.update`).'),
    cacheName: completableCacheName('Cache resource name to update'),
    ttl: ttlSeconds('New TTL from now (e.g. "7200s" for 2 hours)'),
  });

  const memoryCachesDeleteSchema = z.strictObject({
    action: z.literal('caches.delete').describe('Memory action (`caches.delete`).'),
    cacheName: completableCacheName('Cache resource name to delete'),
    confirm: z.boolean().optional().describe('Confirmation override for non-interactive clients.'),
  });

  const memoryWorkspaceContextSchema = z.strictObject({
    action: z.literal('workspace.context').describe('Memory action (`workspace.context`).'),
  });

  const memoryWorkspaceCacheSchema = z.strictObject({
    action: z
      .literal('workspace.cache')
      .describe(
        'Memory action to perform. Use `workspace.cache` to inspect workspace cache state and metadata.',
      ),
  });

  return z.discriminatedUnion('action', [
    MemorySessionsListSchema,
    memorySessionsGetSchema,
    memorySessionsTranscriptSchema,
    memorySessionsEventsSchema,
    memoryCachesListSchema,
    memoryCachesGetSchema,
    memoryCachesCreateSchema,
    memoryCachesUpdateSchema,
    memoryCachesDeleteSchema,
    memoryWorkspaceContextSchema,
    memoryWorkspaceCacheSchema,
  ]);
}

export const MemoryInputSchema = createMemoryInputSchema();
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

export const DiscoverInputSchema = z.strictObject({
  job: PublicJobNameSchema.optional().describe('Public job to focus discovery guidance on.'),
  goal: textField('User outcome to optimize for.').optional(),
});
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;

function createAskInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  const askCommonShape = {
    message: requiredText('User message or prompt', 100_000),
    sessionId: completable(
      sessionId('Session ID for multi-turn chat. Omit for single-turn.').optional(),
      completeSessionIds,
    ),
    systemInstruction: textField(
      'System instructions for response style, constraints, or behavior.',
    ).optional(),
    thinkingLevel: thinkingLevel('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
    cacheName: completableCacheName(
      'Cache name from memory action=caches.create. Cannot be applied to an existing chat session.',
      true,
    ),
    responseSchema: GeminiResponseSchema.optional().describe('JSON Schema for structured output.'),
    temperature: boundedFloat(
      'Sampling temperature (0.0 to 2.0). Lower is more deterministic.',
      0,
      2,
    )
      .optional()
      .describe('Sampling temperature (0.0 to 2.0). Lower is more deterministic.'),
    seed: z.int().optional().describe('Fixed random seed for reproducible outputs.'),
    googleSearch: z
      .boolean()
      .optional()
      .describe('Legacy shortcut to enable Google Search (prefer toolProfile="search").'),
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
  language: textField(
    'Preferred language for the generated solution. Use to steer the model toward a target language even though Gemini executes code in Python.',
  ).optional(),
  thinkingLevel: thinkingLevelField,
});
export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

export const SearchInputSchema = z.strictObject({
  query: requiredText('Question or topic to research'),
  systemInstruction: textField(
    'Instructions for how search results should be synthesized. Use for output format, audience, tone, or filtering constraints.',
  ).optional(),
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
  searchDepth: boundedInt(
    'How many search iterations to perform during deep research. Use higher values for more exhaustive investigation.',
    1,
    5,
  )
    .optional()
    .default(3)
    .describe(
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
  systemInstruction: textField(
    'Instructions for output presentation (format, rubric, audience).',
  ).optional(),
  thinkingLevel: thinkingLevelField,
});
export type AnalyzeUrlInput = z.infer<typeof AnalyzeUrlInputSchema>;

export const AnalyzePrInputSchema = z.strictObject({
  dryRun: z.boolean().describe('Skip model review, return diff snapshot only.').optional(),
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during review.',
  ),
  thinkingLevel: thinkingLevelField,
  language: textField('Primary language hint.').optional(),
});
export type AnalyzePrInput = z.infer<typeof AnalyzePrInputSchema>;

const createCacheSystemInstructionSchema = requiredText(
  'System instruction to store in the cache.',
);
const createCacheSharedShape = {
  ttl: ttlSeconds('Time-to-live for the cache (e.g., "3600s").').optional(),
  displayName: textField('Human-readable label for the cache.').optional(),
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
  confirm: z.boolean().optional().describe('Confirmation override for non-interactive clients.'),
});
export type DeleteCacheInput = z.infer<typeof DeleteCacheInputSchema>;

export const UpdateCacheInputSchema = z.strictObject({
  cacheName: createCacheNameSchema('update'),
  ttl: ttlSeconds('New TTL from now (e.g., "7200s" for 2 hours)'),
});
export type UpdateCacheInput = z.infer<typeof UpdateCacheInputSchema>;

export const ExplainErrorInputSchema = z.strictObject({
  error: requiredText('Error message, stack trace, or log output to diagnose'),
  codeContext: textField('Relevant source code context.').optional(),
  language: textField('Programming language hint.').optional(),
  thinkingLevel: thinkingLevelField,
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search to look up error messages in docs, issues, and forums.'),
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
  question: textField('Comparison focus (e.g., API changes, behavior, security).').optional(),
  thinkingLevel: thinkingLevelField,
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search for best practices or migration context.'),
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during comparison.',
  ),
});
export type CompareFilesInput = z.infer<typeof CompareFilesInputSchema>;

export const GenerateDiagramInputSchema = z
  .strictObject({
    description: requiredText('What to diagram: architecture, flow, sequence, etc.'),
    diagramType: enumField(DIAGRAM_TYPES, 'Diagram syntax to generate.')
      .optional()
      .default('mermaid')
      .describe(
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
    googleSearch: z
      .boolean()
      .optional()
      .describe('Enable Google Search for diagram syntax help or pattern reference.'),
    ...createOptionalCacheReferenceFields(
      'Cache resource name to provide project context for diagram generation.',
    ),
    validateSyntax: z
      .boolean()
      .optional()
      .describe('Validate generated diagram syntax in execution sandbox.'),
  })
  .superRefine(validateExclusiveSourceFileFields);
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInputSchema>;
