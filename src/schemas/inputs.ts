import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { completeCacheNames, THINKING_LEVELS } from '../client.js';
import { completeSessionIds } from '../sessions.js';
import { GeminiResponseSchema } from './json-schema.js';
import { absolutePath, cacheName, publicHttpUrl, requiredText, ttlSeconds } from './shared.js';

const URL_TOOL_PROFILES = ['url', 'search_url'] as const;
const NON_URL_TOOL_PROFILES = ['none', 'search', 'code', 'search_code'] as const;

const thinkingLevelField = z
  .enum(THINKING_LEVELS)
  .optional()
  .describe('Thinking depth for reasoning.');

const askCommonShape = {
  message: requiredText('User message or prompt', 100_000),
  sessionId: completable(
    z
      .string()
      .max(256)
      .optional()
      .describe('Session ID for multi-turn chat. Omit for single-turn.'),
    completeSessionIds,
  ),
  systemInstruction: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('System prompt (used on session creation or single-turn)'),
  thinkingLevel: z
    .enum(THINKING_LEVELS)
    .optional()
    .describe('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
  cacheName: completable(
    cacheName(
      'Cache name from create_cache. Cannot be applied to an existing chat session.',
    ).optional(),
    completeCacheNames,
  ),
  responseSchema: GeminiResponseSchema.optional().describe(
    'JSON Schema object (draft-compatible) for structured output. Gemini returns conforming JSON. Disables thinking. Gemini 2.0 models may require a propertyOrdering array.',
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

export const AskInputSchema = z.union([
  z.strictObject({
    ...askCommonShape,
    toolProfile: z
      .enum(URL_TOOL_PROFILES)
      .describe(
        'Optional advanced built-in tool preset: none, search, url, search_url, code, or search_code.',
      ),
    urls: z
      .array(publicHttpUrl('Public URL to analyze with URL Context'))
      .min(1)
      .max(20)
      .describe('URLs for URL Context when using toolProfile=url or search_url (max 20).'),
  }),
  z.strictObject({
    ...askCommonShape,
    toolProfile: z
      .enum(NON_URL_TOOL_PROFILES)
      .optional()
      .describe(
        'Optional advanced built-in tool preset: none, search, url, search_url, code, or search_code.',
      ),
    urls: z
      .array(publicHttpUrl('Public URL to analyze with URL Context'))
      .max(20)
      .optional()
      .describe('URLs for URL Context when using toolProfile=url or search_url (max 20).'),
  }),
]);
export type AskInput = z.infer<typeof AskInputSchema>;

export const ExecuteCodeInputSchema = z.strictObject({
  task: requiredText('Code task to perform'),
  language: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Preferred language hint for prompt steering only. Gemini code execution still runs in Python.',
    ),
  thinkingLevel: thinkingLevelField,
});
export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

export const SearchInputSchema = z.strictObject({
  query: requiredText('Question or topic to research'),
  systemInstruction: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Custom instructions for result format'),
  urls: z
    .array(publicHttpUrl('Public URL to analyze alongside search results'))
    .max(20)
    .optional()
    .describe('URLs to deeply analyze alongside search results (max 20). Enables URL Context.'),
  thinkingLevel: thinkingLevelField,
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

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
  filePath: absolutePath('Absolute path to the file'),
  question: requiredText('What to analyze or ask about the file'),
  thinkingLevel: thinkingLevelField,
  mediaResolution: z
    .enum(['MEDIA_RESOLUTION_LOW', 'MEDIA_RESOLUTION_MEDIUM', 'MEDIA_RESOLUTION_HIGH'])
    .optional()
    .describe('Resolution for image/video processing. Higher = more detail, more tokens.'),
});
export type AnalyzeFileInput = z.infer<typeof AnalyzeFileInputSchema>;

export const AnalyzeUrlInputSchema = z.strictObject({
  urls: z
    .array(publicHttpUrl('Public URL to analyze'))
    .min(1)
    .max(20)
    .describe('URLs to analyze (max 20). Must be publicly accessible.'),
  question: requiredText('What to analyze or ask about the URL content'),
  systemInstruction: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Custom system instruction for analysis'),
  thinkingLevel: thinkingLevelField,
});
export type AnalyzeUrlInput = z.infer<typeof AnalyzeUrlInputSchema>;

export const AnalyzePrInputSchema = z.object({
  dryRun: z.boolean().describe('Return diff content and stats without Gemini analysis.').optional(),
  cacheName: cacheName('Cache resource name to provide project context during review.').optional(),
  thinkingLevel: thinkingLevelField,
  language: z.string().trim().min(1).describe('Primary language for review context').optional(),
});
export type AnalyzePrInput = z.infer<typeof AnalyzePrInputSchema>;

const createCacheFilePathsSchema = z
  .array(absolutePath('Absolute path to a file to cache'))
  .max(50)
  .describe('Absolute paths to files to cache');
const createCacheSystemInstructionSchema = z
  .string()
  .trim()
  .min(1)
  .describe('System instruction to cache with the files');
const createCacheSharedShape = {
  ttl: ttlSeconds('Time-to-live for the cache (e.g., "3600s"). Defaults to 1 hour.').optional(),
  displayName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Human-readable label. Existing cache with same displayName is auto-replaced.'),
};

export const CreateCacheInputSchema = z
  .union([
    z.strictObject({
      filePaths: createCacheFilePathsSchema.min(1),
      systemInstruction: createCacheSystemInstructionSchema.optional(),
      ...createCacheSharedShape,
    }),
    z.strictObject({
      filePaths: createCacheFilePathsSchema.optional(),
      systemInstruction: createCacheSystemInstructionSchema,
      ...createCacheSharedShape,
    }),
  ])
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
  codeContext: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Relevant source code surrounding the error for deeper analysis'),
  language: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Programming language (e.g., "typescript", "python")'),
  thinkingLevel: thinkingLevelField,
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search to look up error messages in docs, issues, and forums.'),
  urls: z
    .array(publicHttpUrl('Public URL for additional context'))
    .max(20)
    .optional()
    .describe('URLs for additional context (docs, issues). Enables URL Context (max 20).'),
  cacheName: cacheName(
    'Cache resource name to provide project context during diagnosis.',
  ).optional(),
});
export type ExplainErrorInput = z.infer<typeof ExplainErrorInputSchema>;

export const CompareFilesInputSchema = z.strictObject({
  filePathA: absolutePath('Absolute path to the first file'),
  filePathB: absolutePath('Absolute path to the second file'),
  question: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Specific comparison focus (e.g., "security differences", "API changes")'),
  thinkingLevel: thinkingLevelField,
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search for best practices or migration context.'),
  cacheName: cacheName(
    'Cache resource name to provide project context during comparison.',
  ).optional(),
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
    sourceFilePath: absolutePath(
      'Absolute path to a single source file to derive the diagram from',
    ).optional(),
    sourceFilePaths: z
      .array(absolutePath('Absolute path to a source file for diagram generation'))
      .min(1)
      .max(10)
      .optional()
      .describe('Absolute paths to multiple source files for architecture diagrams (max 10).'),
    thinkingLevel: thinkingLevelField,
    googleSearch: z
      .boolean()
      .optional()
      .describe('Enable Google Search for diagram patterns or syntax reference.'),
    cacheName: cacheName(
      'Cache resource name to provide project context for diagram generation.',
    ).optional(),
    validateSyntax: z
      .boolean()
      .optional()
      .describe('Validate generated diagram syntax via code execution sandbox.'),
  })
  .refine((data) => !(data.sourceFilePath && data.sourceFilePaths), {
    path: ['sourceFilePaths'],
    error: 'Provide sourceFilePath or sourceFilePaths, not both.',
  });
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInputSchema>;
