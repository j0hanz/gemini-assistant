import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { completeCacheNames, THINKING_LEVELS } from '../client.js';
import { completeSessionIds } from '../sessions.js';
import { absolutePath, requiredText, ttlSeconds } from './shared.js';

const thinkingLevelField = z
  .enum(THINKING_LEVELS)
  .optional()
  .describe('Thinking depth for reasoning.');

export const AskInputSchema = z.object({
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
    z
      .string()
      .optional()
      .describe('Cache name from create_cache. Cannot be applied to an existing chat session.'),
    completeCacheNames,
  ),
  responseSchema: z
    .record(z.string(), z.unknown())
    .refine(
      (s) =>
        'type' in s ||
        'properties' in s ||
        'anyOf' in s ||
        'oneOf' in s ||
        'allOf' in s ||
        '$ref' in s ||
        'enum' in s ||
        'items' in s,
      {
        message:
          'responseSchema must contain at least one JSON Schema keyword (type, properties, anyOf, oneOf, allOf, $ref, enum, or items)',
      },
    )
    .optional()
    .describe(
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
    .number()
    .int()
    .optional()
    .describe('Fixed seed for reproducible outputs. Model default if omitted.'),
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search grounding. Model can use web results for up-to-date answers.'),
});
export type AskInput = z.infer<typeof AskInputSchema>;

export const ExecuteCodeInputSchema = z.object({
  task: requiredText('Code task to perform'),
  language: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Preferred language (Python is sandbox default)'),
  thinkingLevel: thinkingLevelField,
});
export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

export const SearchInputSchema = z.object({
  query: requiredText('Question or topic to research'),
  systemInstruction: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Custom instructions for result format'),
  urls: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .describe('URLs to deeply analyze alongside search results (max 20). Enables URL Context.'),
  thinkingLevel: thinkingLevelField,
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const AgenticSearchInputSchema = z.object({
  topic: requiredText('Topic or question for deep multi-step research'),
  searchDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('Depth of search (1-5, default 3)'),
  thinkingLevel: thinkingLevelField,
});
export type AgenticSearchInput = z.infer<typeof AgenticSearchInputSchema>;

export const AnalyzeFileInputSchema = z.object({
  filePath: absolutePath('Absolute path to the file'),
  question: requiredText('What to analyze or ask about the file'),
  thinkingLevel: thinkingLevelField,
  mediaResolution: z
    .enum(['MEDIA_RESOLUTION_LOW', 'MEDIA_RESOLUTION_MEDIUM', 'MEDIA_RESOLUTION_HIGH'])
    .optional()
    .describe('Resolution for image/video processing. Higher = more detail, more tokens.'),
});
export type AnalyzeFileInput = z.infer<typeof AnalyzeFileInputSchema>;

export const AnalyzeUrlInputSchema = z.object({
  urls: z
    .array(z.string().trim().min(1))
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

export const AnalyzePrInputSchema = z
  .object({
    dryRun: z
      .boolean()
      .optional()
      .describe('Return diff content and stats without Gemini analysis.'),
    cacheName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Cache resource name to provide project context during review.'),
    thinkingLevel: thinkingLevelField,
    language: z.string().trim().min(1).optional().describe('Primary language for review context'),
  })
  .strict();
export type AnalyzePrInput = z.infer<typeof AnalyzePrInputSchema>;

export const CreateCacheInputSchema = z
  .object({
    filePaths: z
      .array(absolutePath('Absolute path to a file to cache'))
      .max(50)
      .optional()
      .describe('Absolute paths to files to cache'),
    systemInstruction: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('System instruction to cache with the files'),
    ttl: ttlSeconds('Time-to-live for the cache (e.g., "3600s"). Defaults to 1 hour.').optional(),
    displayName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Human-readable label. Existing cache with same displayName is auto-replaced.'),
  })
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- LHS is boolean; ?? would not fall through on `false`
  .refine((data) => (data.filePaths && data.filePaths.length > 0) || data.systemInstruction, {
    message: 'At least one of filePaths or systemInstruction must be provided.',
  })
  .describe(
    'Creates a Gemini API cache. Combined content (files + instructions) MUST exceed ~32,000 tokens.',
  );
export type CreateCacheInput = z.infer<typeof CreateCacheInputSchema>;

function createCacheNameSchema(action: 'delete' | 'update') {
  return completable(
    z
      .string()
      .trim()
      .min(1)
      .describe(`Cache resource name to ${action} (e.g., "cachedContents/...")`),
    completeCacheNames,
  );
}

export const DeleteCacheInputSchema = z.object({
  cacheName: createCacheNameSchema('delete'),
  confirm: z
    .boolean()
    .optional()
    .describe('Required when the client cannot confirm deletion interactively.'),
});
export type DeleteCacheInput = z.infer<typeof DeleteCacheInputSchema>;

export const UpdateCacheInputSchema = z.object({
  cacheName: createCacheNameSchema('update'),
  ttl: ttlSeconds('New TTL from now (e.g., "7200s" for 2 hours)'),
});
export type UpdateCacheInput = z.infer<typeof UpdateCacheInputSchema>;

export const ExplainErrorInputSchema = z.object({
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
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .describe('URLs for additional context (docs, issues). Enables URL Context (max 20).'),
  cacheName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Cache resource name to provide project context during diagnosis.'),
});
export type ExplainErrorInput = z.infer<typeof ExplainErrorInputSchema>;

export const CompareFilesInputSchema = z.object({
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
  cacheName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Cache resource name to provide project context during comparison.'),
});
export type CompareFilesInput = z.infer<typeof CompareFilesInputSchema>;

export const GenerateDiagramInputSchema = z
  .object({
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
    cacheName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Cache resource name to provide project context for diagram generation.'),
    validateSyntax: z
      .boolean()
      .optional()
      .describe('Validate generated diagram syntax via code execution sandbox.'),
  })
  .refine((data) => !(data.sourceFilePath && data.sourceFilePaths), {
    message: 'Provide sourceFilePath or sourceFilePaths, not both.',
  });
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInputSchema>;
