import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { completeCacheNames } from '../client.js';
import {
  cacheName,
  goalText,
  mediaResolution,
  optionalText,
  PublicJobNameSchema,
  requiredText,
  sessionId,
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
    systemInstruction: optionalText('System prompt for single-turn calls or new sessions'),
    thinkingLevel: thinkingLevel('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
    responseSchema: GeminiResponseSchema.optional().describe(
      'JSON Schema object for structured output. Intended for single-turn calls and brand-new sessions.',
    ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Controls randomness (0.0=deterministic, 2.0=most creative).'),
    seed: z.int().optional().describe('Fixed seed for reproducible outputs.'),
  });
}

export const ChatInputSchema = createChatInputSchema();
export type ChatInput = z.infer<typeof ChatInputSchema>;

const QuickResearchInputSchema = z.strictObject({
  mode: z.literal('quick'),
  goal: goalText('Question or research goal to answer quickly'),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze alongside search results',
    description: 'Optional public URLs to inspect alongside web search.',
    max: 20,
    optional: true,
  }),
  systemInstruction: optionalText('Optional formatting or response constraints'),
  thinkingLevel: thinkingLevelField,
});

const DeepResearchInputSchema = z.strictObject({
  mode: z.literal('deep'),
  goal: goalText('Topic or research goal for a deeper multi-step investigation'),
  deliverable: optionalText('Optional requested deliverable format or emphasis'),
  searchDepth: z
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('Research depth (1-5, default 3).'),
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
  kind: z.literal('file'),
  filePath: workspacePath('Workspace-relative or absolute path to the file'),
});

const AnalyzeUrlTargetsSchema = z.strictObject({
  kind: z.literal('url'),
  ...createUrlContextFields({
    itemDescription: 'Public URL to analyze',
    description: 'One or more public URLs to analyze.',
    min: 1,
    max: 20,
  }),
});

const AnalyzeMultiTargetsSchema = z.strictObject({
  kind: z.literal('multi'),
  filePaths: z
    .array(workspacePath('Workspace-relative or absolute path to a local file'))
    .min(2)
    .max(5)
    .describe('Small set of local files to analyze together.'),
});

const AnalyzeTargetsSchema = z.discriminatedUnion('kind', [
  AnalyzeFileTargetsSchema,
  AnalyzeUrlTargetsSchema,
  AnalyzeMultiTargetsSchema,
]);

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
  kind: z.literal('diff'),
  dryRun: z.boolean().optional().describe('Return the generated diff without model review.'),
  language: optionalText('Primary language hint for the local diff review'),
});

const ReviewComparisonSubjectSchema = z.strictObject({
  kind: z.literal('comparison'),
  ...createFilePairFields(
    'Workspace-relative or absolute path to the first file',
    'Workspace-relative or absolute path to the second file',
  ),
  question: optionalText('Specific comparison focus'),
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search for migration or best-practice context.'),
});

const ReviewFailureSubjectSchema = z.strictObject({
  kind: z.literal('failure'),
  error: requiredText('Error message, stack trace, or log output to diagnose'),
  codeContext: optionalText('Relevant source code surrounding the error'),
  language: optionalText('Programming language'),
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search for docs/issues and targeted verification.'),
  ...createUrlContextFields({
    itemDescription: 'Public URL for additional context',
    description: 'Optional public URLs for additional failure context.',
    max: 20,
    optional: true,
  }),
});

const ReviewSubjectSchema = z.discriminatedUnion('kind', [
  ReviewDiffSubjectSchema,
  ReviewComparisonSubjectSchema,
  ReviewFailureSubjectSchema,
]);

export const ReviewInputSchema = z.strictObject({
  subject: ReviewSubjectSchema,
  focus: optionalText('Optional review focus such as regressions, tests, or security'),
  thinkingLevel: thinkingLevelField,
  cacheName: completable(
    cacheName('Cache resource name to provide project context during review.').optional(),
    completeCacheNames,
  ),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const MemorySessionsListSchema = z.strictObject({
  action: z.literal('sessions.list'),
});

export function createMemoryInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  const memorySessionIdField = completable(
    sessionId('Session identifier to inspect'),
    completeSessionIds,
  );

  const memorySessionsGetSchema = z.strictObject({
    action: z.literal('sessions.get'),
    sessionId: memorySessionIdField,
  });

  const memorySessionsTranscriptSchema = z.strictObject({
    action: z.literal('sessions.transcript'),
    sessionId: memorySessionIdField,
  });

  const memorySessionsEventsSchema = z.strictObject({
    action: z.literal('sessions.events'),
    sessionId: memorySessionIdField,
  });

  const memoryCachesListSchema = z.strictObject({
    action: z.literal('caches.list'),
  });

  const memoryCachesGetSchema = z.strictObject({
    action: z.literal('caches.get'),
    cacheName: completable(cacheName('Cache resource name to inspect'), completeCacheNames),
  });

  const memoryCachesCreateSchema = z
    .strictObject({
      action: z.literal('caches.create'),
      filePaths: z
        .array(workspacePath('Workspace-relative or absolute path to a file to cache'))
        .max(50)
        .optional(),
      systemInstruction: requiredText('System instruction to cache with the files').optional(),
      ttl: ttlSeconds('Time-to-live for the cache (e.g. "3600s"). Defaults to 1 hour.').optional(),
      displayName: optionalText(
        'Human-readable label. Existing cache with the same displayName is auto-replaced.',
      ),
    })
    .superRefine(validateMeaningfulCacheCreateInput)
    .describe('Create a Gemini cache from files and/or a system instruction.');

  const memoryCachesUpdateSchema = z.strictObject({
    action: z.literal('caches.update'),
    cacheName: completable(cacheName('Cache resource name to update'), completeCacheNames),
    ttl: ttlSeconds('New TTL from now (e.g. "7200s" for 2 hours)'),
  });

  const memoryCachesDeleteSchema = z.strictObject({
    action: z.literal('caches.delete'),
    cacheName: completable(cacheName('Cache resource name to delete'), completeCacheNames),
    confirm: z
      .boolean()
      .optional()
      .describe('Required when the client cannot confirm deletion interactively.'),
  });

  const memoryWorkspaceContextSchema = z.strictObject({
    action: z.literal('workspace.context'),
  });

  const memoryWorkspaceCacheSchema = z.strictObject({
    action: z.literal('workspace.cache'),
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
  job: PublicJobNameSchema.optional().describe('Optional job to narrow discovery guidance.'),
  goal: optionalText('Optional user goal that should shape the recommendation'),
});
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;

function createAskInputSchema(completeSessionIds: SessionIdCompleter = () => []) {
  const askCommonShape = {
    message: requiredText('User message or prompt', 100_000),
    sessionId: completable(
      sessionId('Session ID for multi-turn chat. Omit for single-turn.').optional(),
      completeSessionIds,
    ),
    systemInstruction: optionalText('System prompt (used on session creation or single-turn)'),
    thinkingLevel: thinkingLevel('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
    cacheName: completable(
      cacheName(
        'Cache name from create_cache. Cannot be applied to an existing chat session.',
      ).optional(),
      completeCacheNames,
    ),
    responseSchema: GeminiResponseSchema.optional().describe(
      'JSON Schema object (draft-compatible) for structured output. Gemini returns conforming JSON. Used for single-turn calls and brand-new sessions. Gemini 2.0 models may require a propertyOrdering array.',
    ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        'Controls randomness (0.0=deterministic, 2.0=most creative). Model default if omitted.',
      ),
    seed: z
      .int()
      .optional()
      .describe('Fixed seed for reproducible outputs. Model default if omitted.'),
    googleSearch: z
      .boolean()
      .optional()
      .describe('Backward-compatible alias for toolProfile=search.'),
  };

  return z.union([
    z.strictObject({
      ...askCommonShape,
      toolProfile: z
        .enum(URL_TOOL_PROFILES)
        .describe(
          'Optional advanced built-in tool preset: none, search, url, search_url, code, or search_code.',
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
          'Optional advanced built-in tool preset: none, search, url, search_url, code, or search_code.',
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
  language: optionalText(
    'Preferred language hint for prompt steering only. Gemini code execution still runs in Python.',
  ),
  thinkingLevel: thinkingLevelField,
});
export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

export const SearchInputSchema = z.strictObject({
  query: requiredText('Question or topic to research'),
  systemInstruction: optionalText('Custom instructions for result format'),
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
    .describe('Depth of search (1-5, default 3)'),
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
  systemInstruction: optionalText('Custom system instruction for analysis'),
  thinkingLevel: thinkingLevelField,
});
export interface AnalyzeUrlInput {
  urls: string[];
  question: string;
  systemInstruction?: string | undefined;
  thinkingLevel?: ThinkingLevelInput;
}

export const AnalyzePrInputSchema = z.strictObject({
  dryRun: z.boolean().describe('Return diff content and stats without Gemini analysis.').optional(),
  ...createOptionalCacheReferenceFields(
    'Cache resource name to provide project context during review.',
  ),
  thinkingLevel: thinkingLevelField,
  language: optionalText('Primary language for review context'),
});
export type AnalyzePrInput = z.infer<typeof AnalyzePrInputSchema>;

const createCacheFilePathsSchema = z
  .array(workspacePath('Workspace-relative or absolute path to a file to cache'))
  .max(50)
  .describe('Workspace-relative or absolute paths to files to cache');
const createCacheSystemInstructionSchema = requiredText(
  'System instruction to cache with the files',
);
const createCacheSharedShape = {
  ttl: ttlSeconds('Time-to-live for the cache (e.g., "3600s"). Defaults to 1 hour.').optional(),
  displayName: optionalText(
    'Human-readable label. Existing cache with same displayName is auto-replaced.',
  ),
};

export const CreateCacheInputSchema = z
  .strictObject({
    filePaths: createCacheFilePathsSchema.optional(),
    systemInstruction: createCacheSystemInstructionSchema.optional(),
    ...createCacheSharedShape,
  })
  .superRefine(validateMeaningfulCacheCreateInput)
  .describe(
    'Creates a Gemini API cache. Combined content (files + instructions) MUST exceed ~32,000 tokens.',
  );
export type CreateCacheInput = z.infer<typeof CreateCacheInputSchema>;

function createCacheNameSchema(action: 'delete' | 'update') {
  return completable(
    cacheName(`Cache resource name to ${action} (e.g., "cachedContents/...")`),
    completeCacheNames,
  );
}

export const DeleteCacheInputSchema = z.strictObject({
  cacheName: createCacheNameSchema('delete'),
  confirm: z
    .boolean()
    .optional()
    .describe('Required when the client cannot confirm deletion interactively.'),
});
export type DeleteCacheInput = z.infer<typeof DeleteCacheInputSchema>;

export const UpdateCacheInputSchema = z.strictObject({
  cacheName: createCacheNameSchema('update'),
  ttl: ttlSeconds('New TTL from now (e.g., "7200s" for 2 hours)'),
});
export type UpdateCacheInput = z.infer<typeof UpdateCacheInputSchema>;

export const ExplainErrorInputSchema = z.strictObject({
  error: requiredText('Error message, stack trace, or log output to diagnose'),
  codeContext: optionalText('Relevant source code surrounding the error for deeper analysis'),
  language: optionalText('Programming language (e.g., "typescript", "python")'),
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
  question: optionalText('Specific comparison focus (e.g., "security differences", "API changes")'),
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
      .describe('Diagram syntax format (default: mermaid)'),
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
        'Workspace-relative or absolute paths to multiple source files for architecture diagrams (max 10).',
      ),
    thinkingLevel: thinkingLevelField,
    googleSearch: z
      .boolean()
      .optional()
      .describe('Enable Google Search for diagram patterns or syntax reference.'),
    ...createOptionalCacheReferenceFields(
      'Cache resource name to provide project context for diagram generation.',
    ),
    validateSyntax: z
      .boolean()
      .optional()
      .describe('Validate generated diagram syntax via code execution sandbox.'),
  })
  .superRefine(validateExclusiveSourceFileFields);
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInputSchema>;
