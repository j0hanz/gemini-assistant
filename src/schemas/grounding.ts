import { z } from 'zod/v4';

// Schemas for grounding metadata accumulation.
// These are used by TASK-201 (streaming grounding accumulation) and TASK-202 (SessionStore turn accessors).
// Some individual schemas may not be directly used yet but are part of the complete rollup definition
// that will be needed for comprehensive grounding data persistence.

export const WebCitationSchema = z.strictObject({
  uri: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  score: z.number().optional(),
});
export type WebCitation = z.infer<typeof WebCitationSchema>;

export const UrlContextEntrySchema = z.strictObject({
  url: z.string(),
  title: z.string().optional(),
  retrievedAt: z.string(),
  snippet: z.string().optional(),
  status: z.string(),
});
export type UrlContextEntry = z.infer<typeof UrlContextEntrySchema>;

export const FileSearchHitSchema = z.strictObject({
  fileUri: z.string(),
  title: z.string().optional(),
  chunk: z.string(),
  score: z.number(),
});
export type FileSearchHit = z.infer<typeof FileSearchHitSchema>;

export const CodeExecutionEntrySchema = z.strictObject({
  language: z.string(),
  code: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().optional(),
});
export type CodeExecutionEntry = z.infer<typeof CodeExecutionEntrySchema>;

export const GroundingRollupSchema = z.strictObject({
  webSearch: z
    .strictObject({
      queries: z.array(z.string()),
      citations: z.array(WebCitationSchema),
    })
    .optional(),
  urlContext: z.array(UrlContextEntrySchema).optional(),
  fileSearch: z
    .strictObject({
      corpus: z.string(),
      hits: z.array(FileSearchHitSchema),
    })
    .optional(),
  codeExecution: z.array(CodeExecutionEntrySchema).optional(),
  raw: z.unknown().optional(),
});
export type GroundingRollup = z.infer<typeof GroundingRollupSchema>;
