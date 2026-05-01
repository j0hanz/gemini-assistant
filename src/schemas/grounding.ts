import { z } from 'zod/v4';

// Schemas for grounding metadata accumulation.
// These are used by TASK-201 (streaming grounding accumulation) and TASK-202 (SessionStore turn accessors).

const WebCitationSchema = z.strictObject({
  uri: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  score: z.number().optional(),
});

const UrlContextEntrySchema = z.strictObject({
  url: z.string(),
  title: z.string().optional(),
  retrievedAt: z.string(),
  snippet: z.string().optional(),
  status: z.string(),
});

const FileSearchHitSchema = z.strictObject({
  fileUri: z.string(),
  title: z.string().optional(),
  chunk: z.string(),
  score: z.number(),
});

const CodeExecutionEntrySchema = z.strictObject({
  language: z.string(),
  code: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().optional(),
});

const _GroundingRollupSchema = z.strictObject({
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

export type GroundingRollup = z.infer<typeof _GroundingRollupSchema>;
