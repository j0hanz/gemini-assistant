import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import {
  completableCacheName,
  goalText,
  mediaResolution,
  PublicJobNameSchema,
  requiredText,
  sessionId,
  textField,
  thinkingLevel,
  ttlSeconds,
  workspacePath,
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

const URL_TOOL_PROFILES = ['url', 'search_url'] as const;
const NON_URL_TOOL_PROFILES = ['none', 'search', 'code', 'search_code'] as const;
type SessionIdCompleter = (prefix?: string) => string[];
type ThinkingLevelInput = z.infer<ReturnType<typeof thinkingLevel>>;
type GeminiResponseInput = z.infer<typeof GeminiResponseSchema>;
type MediaResolutionInput = z.infer<ReturnType<typeof mediaResolution>>;

const thinkingLevelField = thinkingLevel();

export function createChatInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  return z.strictObject({
    goal: goalText(),
    ...createSessionContinuationFields(completeSessionIds),
    memory: MemoryRefSchema,
    systemInstruction: textField(
      'Instructions that shape response style, constraints, or behavior for this call or for a newly created session. Use when the user goal alone does not fully define how Gemini should respond.',
    ).optional(),
    thinkingLevel: thinkingLevel('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
    responseSchema: GeminiResponseSchema.optional().describe(
      'JSON Schema for structured output. Use when the response must follow a machine-readable shape; best suited for single-turn calls and newly created sessions.',
    ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        'Sampling temperature for generation. Use lower values for deterministic answers and higher values for more varied or creative output.',
      ),
    seed: z
      .int()
      .optional()
      .describe(
        'Fixed random seed for reproducible outputs. Use when repeated runs should stay stable.',
      ),
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

const QuickResearchInputSchema = z.strictObject({
  mode: z
    .literal('quick')
    .describe('Research mode selector. Use `quick` for a faster, lighter-weight answer.'),
  goal: goalText('Question or research goal to answer quickly'),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze alongside search results',
    description:
      'Public URLs to inspect alongside web search results. Use when specific pages should inform or ground the answer.',
    max: 20,
    optional: true,
  }),
  systemInstruction: textField(
    'Instructions for how to present the quick research result. Use for format, audience, tone, or scope constraints.',
  ).optional(),
  thinkingLevel: thinkingLevelField,
});

const DeepResearchInputSchema = z.strictObject({
  mode: z
    .literal('deep')
    .describe(
      'Research mode selector. Use `deep` for a multi-step investigation with broader coverage.',
    ),
  goal: goalText('Topic or research goal for a deeper multi-step investigation'),
  deliverable: textField(
    'Requested output form for the research result. Use to ask for a brief, report, checklist, recommendation, or another deliverable style.',
  ).optional(),
  searchDepth: z
    .int()
    .min(1)
    .max(5)
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
export type ResearchInput =
  | {
      mode: 'quick';
      goal: string;
      urls?: string[] | undefined;
      systemInstruction?: string | undefined;
      thinkingLevel?: ThinkingLevelInput;
    }
  | {
      mode: 'deep';
      goal: string;
      deliverable?: string | undefined;
      searchDepth: number;
      thinkingLevel?: ThinkingLevelInput;
    };

const AnalyzeFileTargetsSchema = z.strictObject({
  kind: z
    .literal('file')
    .describe('Analyze target type. Use `file` when the request is about one local file.'),
  filePath: workspacePath('Workspace-relative or absolute path to the file'),
});

const AnalyzeUrlTargetsSchema = z.strictObject({
  kind: z
    .literal('url')
    .describe(
      'Analyze target type. Use `url` when the request is about one or more public web pages.',
    ),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze',
    description: 'One or more public URLs to analyze.',
    min: 1,
    max: 20,
  }),
});

const AnalyzeMultiTargetsSchema = z.strictObject({
  kind: z
    .literal('multi')
    .describe(
      'Analyze target type. Use `multi` when the answer depends on several local files together.',
    ),
  filePaths: z
    .array(workspacePath('Workspace-relative or absolute path to a local file'))
    .min(2)
    .max(5)
    .describe(
      'Small set of local files to analyze together. Use when the answer depends on comparing or combining context across multiple files.',
    ),
});

const AnalyzeTargetsSchema = z
  .discriminatedUnion('kind', [
    AnalyzeFileTargetsSchema,
    AnalyzeUrlTargetsSchema,
    AnalyzeMultiTargetsSchema,
  ])
  .describe(
    'Target selection for analysis. Choose the variant that matches the source material to inspect.',
  );

export const AnalyzeInputSchema = z.strictObject({
  goal: goalText('Question or analysis goal for the selected targets'),
  targets: AnalyzeTargetsSchema,
  thinkingLevel: thinkingLevelField,
  mediaResolution: mediaResolution(
    'Resolution for image/video processing. Higher = more detail, more tokens.',
  ),
});
export interface AnalyzeInput {
  goal: string;
  targets:
    | {
        kind: 'file';
        filePath: string;
      }
    | {
        kind: 'url';
        urls: string[];
      }
    | {
        kind: 'multi';
        filePaths: string[];
      };
  thinkingLevel?: ThinkingLevelInput;
  mediaResolution?: MediaResolutionInput;
}

const ReviewDiffSubjectSchema = z.strictObject({
  kind: z
    .literal('diff')
    .describe('Review subject type. Use `diff` to review current local changes as a patch.'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Skip model review and return only the generated local diff snapshot. Use for inspection or debugging.',
    ),
  language: textField(
    'Primary language in the local diff. Use when the changes are mostly in one language and review comments should follow its conventions.',
  ).optional(),
});

const ReviewComparisonSubjectSchema = z.strictObject({
  kind: z
    .literal('comparison')
    .describe('Review subject type. Use `comparison` to compare two local files directly.'),
  ...createFilePairFields(
    'Workspace-relative or absolute path to the first file',
    'Workspace-relative or absolute path to the second file',
  ),
  question: textField(
    'Specific angle for comparing the two files. Use to focus the comparison on behavior, APIs, security, performance, or another concern.',
  ).optional(),
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search for migration or best-practice context.'),
});

const ReviewFailureSubjectSchema = z.strictObject({
  kind: z
    .literal('failure')
    .describe(
      'Review subject type. Use `failure` to diagnose an error, stack trace, or broken behavior.',
    ),
  error: requiredText('Error message, stack trace, or log output to diagnose'),
  codeContext: textField(
    'Relevant source code around the failure. Use when the error output alone is not enough to explain the bug or identify the fix.',
  ).optional(),
  language: textField(
    'Programming language of the failing code. Use when it helps interpret syntax, stack traces, or framework-specific behavior.',
  ).optional(),
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search for docs/issues and targeted verification.'),
  ...createUrlContextFields({
    itemDescription: 'Public URL for additional context',
    description:
      'Public URLs with supporting failure context, such as documentation, issue threads, or logs shared on the web.',
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
  .describe(
    'Review subject details. Choose the variant that matches the artifact or problem being reviewed.',
  );

export const ReviewInputSchema = z.strictObject({
  subject: ReviewSubjectSchema,
  focus: textField(
    'Review priorities for this request. Use to emphasize regressions, tests, security, performance, maintainability, or another review lens.',
  ).optional(),
  thinkingLevel: thinkingLevelField,
  cacheName: completableCacheName(
    'Cache resource name to provide project context during review.',
    true,
  ),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const MemorySessionsListSchema = z.strictObject({
  action: z
    .literal('sessions.list')
    .describe(
      'Memory action to perform. Use `sessions.list` to see available in-memory chat sessions.',
    ),
});

export function createMemoryInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  const memorySessionIdField = completable(
    sessionId('Session identifier to inspect'),
    completeSessionIds,
  );

  const memorySessionsGetSchema = z.strictObject({
    action: z
      .literal('sessions.get')
      .describe(
        'Memory action to perform. Use `sessions.get` to inspect metadata for one session.',
      ),
    sessionId: memorySessionIdField,
  });

  const memorySessionsTranscriptSchema = z.strictObject({
    action: z
      .literal('sessions.transcript')
      .describe(
        'Memory action to perform. Use `sessions.transcript` to read the saved conversation transcript for one session.',
      ),
    sessionId: memorySessionIdField,
  });

  const memorySessionsEventsSchema = z.strictObject({
    action: z
      .literal('sessions.events')
      .describe(
        'Memory action to perform. Use `sessions.events` to inspect stored structured request and response events for one session.',
      ),
    sessionId: memorySessionIdField,
  });

  const memoryCachesListSchema = z.strictObject({
    action: z
      .literal('caches.list')
      .describe('Memory action to perform. Use `caches.list` to see active Gemini caches.'),
  });

  const memoryCachesGetSchema = z.strictObject({
    action: z
      .literal('caches.get')
      .describe('Memory action to perform. Use `caches.get` to inspect one existing Gemini cache.'),
    cacheName: completableCacheName('Cache resource name to inspect'),
  });

  const memoryCachesCreateSchema = z
    .strictObject({
      action: z
        .literal('caches.create')
        .describe(
          'Memory action to perform. Use `caches.create` to build reusable cached context from files and/or instructions.',
        ),
      filePaths: z
        .array(workspacePath('Workspace-relative or absolute path to a file to cache'))
        .max(50)
        .optional()
        .describe(
          'Files to include in the cache. Use when reusable context should be built from local source files or documents.',
        ),
      systemInstruction: requiredText(
        'System instruction to store alongside the cached files. Use when the cache should preserve stable guidance in addition to file content.',
      ).optional(),
      ttl: ttlSeconds(
        'Time-to-live for the cache, such as "3600s". Use to control how long the cached context remains available.',
      ).optional(),
      displayName: textField(
        'Human-readable label for the cache. Use to make caches easier to identify; reusing the same display name replaces the existing cache.',
      ).optional(),
    })
    .superRefine(validateMeaningfulCacheCreateInput)
    .describe(
      'Create a Gemini cache from files and/or a system instruction. Use it to reuse large context across later requests.',
    );

  const memoryCachesUpdateSchema = z.strictObject({
    action: z
      .literal('caches.update')
      .describe('Memory action to perform. Use `caches.update` to extend or shorten a cache TTL.'),
    cacheName: completableCacheName('Cache resource name to update'),
    ttl: ttlSeconds('New TTL from now (e.g. "7200s" for 2 hours)'),
  });

  const memoryCachesDeleteSchema = z.strictObject({
    action: z
      .literal('caches.delete')
      .describe('Memory action to perform. Use `caches.delete` to remove a Gemini cache.'),
    cacheName: completableCacheName('Cache resource name to delete'),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Confirmation override for non-interactive clients. Use `true` when the caller cannot complete an interactive delete confirmation step.',
      ),
  });

  const memoryWorkspaceContextSchema = z.strictObject({
    action: z
      .literal('workspace.context')
      .describe(
        'Memory action to perform. Use `workspace.context` to inspect the assembled workspace context summary.',
      ),
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
  job: PublicJobNameSchema.optional().describe(
    'Public job to focus the discovery response on. Use when you already know the rough category and want more targeted guidance.',
  ),
  goal: textField(
    'User outcome to optimize for when recommending a job. Use when you want discovery guidance tailored to a concrete task.',
  ).optional(),
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
      'Instructions that define response style, format, or behavior. Use for single-turn calls or when starting a new session with persistent guidance.',
    ).optional(),
    thinkingLevel: thinkingLevel('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
    cacheName: completableCacheName(
      'Cache name from memory action=caches.create. Cannot be applied to an existing chat session.',
      true,
    ),
    responseSchema: GeminiResponseSchema.optional().describe(
      'JSON Schema for structured output. Use when Gemini should return conforming JSON for a single-turn request or a newly created session; some Gemini 2.0 models may also need propertyOrdering.',
    ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        'Sampling temperature for generation. Use lower values for more deterministic replies and higher values for more varied output; omit it to use the model default.',
      ),
    seed: z
      .int()
      .optional()
      .describe(
        'Fixed random seed for reproducible outputs. Use when repeated calls should stay stable; omit it to use the model default.',
      ),
    googleSearch: z
      .boolean()
      .optional()
      .describe(
        'Backward-compatible shortcut for enabling search behavior. Use when older clients still send `googleSearch` instead of `toolProfile=search`.',
      ),
  };

  return z.union([
    z.strictObject({
      ...askCommonShape,
      toolProfile: z
        .enum(URL_TOOL_PROFILES)
        .describe(
          'Built-in tool preset to enable for this request. Use `url` or `search_url` when URL Context should be active; use other presets when you want specific built-in tool behavior.',
        ),
      ...createUrlContextFields({
        itemDescription: 'Public URL to analyze with URL Context',
        description: 'URLs for URL Context when using toolProfile=url or search_url (max 20).',
        min: 1,
        max: 20,
      }),
    }),
    z.strictObject({
      ...askCommonShape,
      toolProfile: z
        .enum(NON_URL_TOOL_PROFILES)
        .optional()
        .describe(
          'Built-in tool preset to enable for this request. Use it when you want Gemini to rely on a specific tool mode such as search, code, or search_code.',
        ),
      ...createUrlContextFields({
        itemDescription: 'Public URL to analyze with URL Context',
        description: 'URLs for URL Context when using toolProfile=url or search_url (max 20).',
        max: 20,
        optional: true,
      }),
    }),
  ]);
}

export const AskInputSchema = createAskInputSchema();
interface AskCommonInput {
  message: string;
  sessionId?: string | undefined;
  systemInstruction?: string | undefined;
  thinkingLevel?: ThinkingLevelInput;
  cacheName?: string | undefined;
  responseSchema?: GeminiResponseInput | undefined;
  temperature?: number | undefined;
  seed?: number | undefined;
  googleSearch?: boolean | undefined;
}

export type AskInput =
  | (AskCommonInput & {
      toolProfile: (typeof URL_TOOL_PROFILES)[number];
      urls: string[];
    })
  | (AskCommonInput & {
      toolProfile?: (typeof NON_URL_TOOL_PROFILES)[number] | undefined;
      urls?: string[] | undefined;
    });

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
export interface SearchInput {
  query: string;
  systemInstruction?: string | undefined;
  urls?: string[] | undefined;
  thinkingLevel?: ThinkingLevelInput;
}

export const AgenticSearchInputSchema = z.strictObject({
  topic: requiredText('Topic or question for deep multi-step research'),
  searchDepth: z
    .int()
    .min(1)
    .max(5)
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
    'Instructions that shape how the URL analysis should be performed or presented. Use for output format, rubric, or audience constraints.',
  ).optional(),
  thinkingLevel: thinkingLevelField,
});
export interface AnalyzeUrlInput {
  urls: string[];
  question: string;
  systemInstruction?: string | undefined;
  thinkingLevel?: ThinkingLevelInput;
}

export const AnalyzePrInputSchema = z.strictObject({
  dryRun: z
    .boolean()
    .describe(
      'Skip Gemini review and return only diff content plus summary stats. Use when you need the snapshot itself without model analysis.',
    )
    .optional(),
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during review.',
  ),
  thinkingLevel: thinkingLevelField,
  language: textField(
    'Primary language for the pull request review. Use when the diff is mostly in one language and you want language-aware review feedback.',
  ).optional(),
});
export type AnalyzePrInput = z.infer<typeof AnalyzePrInputSchema>;

const createCacheFilePathsSchema = z
  .array(workspacePath('Workspace-relative or absolute path to a file to cache'))
  .max(50)
  .describe(
    'Workspace-relative or absolute paths to files to cache. Use when reusable context should be built from local files.',
  );
const createCacheSystemInstructionSchema = requiredText(
  'System instruction to store in the cache. Use when reusable guidance should accompany the cached files.',
);
const createCacheSharedShape = {
  ttl: ttlSeconds(
    'Time-to-live for the cache, such as "3600s". Use to control how long the cached context remains available.',
  ).optional(),
  displayName: textField(
    'Human-readable label for the cache. Use to make caches easier to identify; reusing the same display name replaces the existing cache.',
  ).optional(),
};

export const CreateCacheInputSchema = z
  .strictObject({
    filePaths: createCacheFilePathsSchema.optional(),
    systemInstruction: createCacheSystemInstructionSchema.optional(),
    ...createCacheSharedShape,
  })
  .superRefine(validateMeaningfulCacheCreateInput)
  .describe(
    'Create a Gemini API cache for reusable large context. Combined content from files and instructions must exceed roughly 32,000 tokens.',
  );
export type CreateCacheInput = z.infer<typeof CreateCacheInputSchema>;

function createCacheNameSchema(action: 'delete' | 'update') {
  return completableCacheName(`Cache resource name to ${action} (e.g., "cachedContents/...")`);
}

export const DeleteCacheInputSchema = z.strictObject({
  cacheName: createCacheNameSchema('delete'),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'Confirmation override for non-interactive clients. Use `true` when the caller cannot complete an interactive delete confirmation step.',
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
  codeContext: textField(
    'Relevant source code around the failure. Use when the error text alone is not enough to explain the root cause.',
  ).optional(),
  language: textField(
    'Programming language of the failing code, such as "typescript" or "python". Use when it helps interpret syntax, tooling, or runtime behavior.',
  ).optional(),
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
  question: textField(
    'Specific angle for comparing the files. Use to focus on API changes, behavior differences, security implications, performance, or another concern.',
  ).optional(),
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
    diagramType: z
      .enum(['mermaid', 'plantuml'])
      .optional()
      .default('mermaid')
      .describe(
        'Diagram syntax to generate. Use `mermaid` for common Markdown workflows or `plantuml` when that ecosystem is required.',
      ),
    sourceFilePath: workspacePath(
      'Workspace-relative or absolute path to a single source file to derive the diagram from',
    ).optional(),
    sourceFilePaths: z
      .array(
        workspacePath(
          'Workspace-relative or absolute path to a source file for diagram generation',
        ),
      )
      .min(1)
      .max(10)
      .optional()
      .describe(
        'Multiple source files to derive the diagram from. Use when architecture or flow understanding depends on more than one file.',
      ),
    thinkingLevel: thinkingLevelField,
    googleSearch: z
      .boolean()
      .optional()
      .describe(
        'Enable Google Search for diagram syntax help or pattern reference. Use when the request depends on external conventions or examples.',
      ),
    ...createOptionalCacheReferenceFields(
      'Cache resource name to provide project context for diagram generation.',
    ),
    validateSyntax: z
      .boolean()
      .optional()
      .describe(
        'Validate the generated diagram syntax in the code execution sandbox. Use when you want an extra syntax check before returning the diagram.',
      ),
  })
  .superRefine(validateExclusiveSourceFileFields);
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInputSchema>;
