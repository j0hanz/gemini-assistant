import { z } from 'zod/v4';

import { cacheName, nonNegativeInt, PublicHttpUrlSchema, timestamp } from './shared.js';

export const UsageMetadataSchema = z.object({
  promptTokenCount: nonNegativeInt('Tokens in the prompt').optional(),
  candidatesTokenCount: nonNegativeInt('Tokens in the response').optional(),
  thoughtsTokenCount: nonNegativeInt('Tokens used for thinking').optional(),
  totalTokenCount: nonNegativeInt('Total tokens for the request').optional(),
});

const FunctionCallEntrySchema = z.object({
  name: z.string().describe('Function/tool name'),
  args: z.record(z.string(), z.unknown()).optional().describe('Function call arguments'),
  id: z.string().optional().describe('Function call identifier when present'),
});

const ToolEventKindSchema = z.enum([
  'part',
  'tool_call',
  'tool_response',
  'function_call',
  'function_response',
  'executable_code',
  'code_execution_result',
]);

const ToolEventSchema = z.object({
  kind: ToolEventKindSchema.describe('Normalized Gemini tool/function event type'),
  name: z.string().optional().describe('Function name when available'),
  toolType: z.string().optional().describe('Built-in tool type when available'),
  id: z.string().optional().describe('Stable Gemini call identifier when available'),
  thoughtSignature: z
    .string()
    .optional()
    .describe('Thought signature returned by Gemini for the part'),
  args: z.record(z.string(), z.unknown()).optional().describe('Tool or function arguments'),
  response: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Tool or function response payload'),
  code: z.string().optional().describe('Executable code payload'),
  output: z.string().optional().describe('Code execution output'),
  outcome: z.string().optional().describe('Code execution outcome'),
  text: z
    .string()
    .optional()
    .describe('Part text when a signature-bearing part has no tool payload'),
});

const baseOutputFields = {
  thoughts: z.string().optional().describe('Internal model reasoning/thinking process'),
  usage: UsageMetadataSchema.optional().describe('Token usage'),
  functionCalls: z
    .array(FunctionCallEntrySchema)
    .optional()
    .describe('Server-side function calls made during generation'),
  toolEvents: z
    .array(ToolEventSchema)
    .optional()
    .describe('Normalized Gemini tool/function event stream captured during generation'),
};

export const AskOutputSchema = z.object({
  answer: z.string().describe('Generated response'),
  data: z.unknown().optional().describe('Parsed structured response when JSON mode is used'),
  schemaWarnings: z
    .array(z.string())
    .optional()
    .describe('Warnings from structured output validation (parse failures, schema mismatches)'),
  ...baseOutputFields,
});

export const ExecuteCodeOutputSchema = z.object({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Model explanation'),
  ...baseOutputFields,
});

const UrlMetadataEntrySchema = z.object({
  url: PublicHttpUrlSchema.describe('Retrieved URL'),
  status: z.string().describe('Retrieval status (e.g. URL_RETRIEVAL_STATUS_SUCCESS)'),
});

export type UrlMetadataEntry = z.infer<typeof UrlMetadataEntrySchema>;

const SourceDetailSchema = z.object({
  title: z.string().optional().describe('Source title when Gemini provides one'),
  url: PublicHttpUrlSchema.describe('Source URL'),
});

export type SourceDetail = z.infer<typeof SourceDetailSchema>;

export const SearchOutputSchema = z.object({
  answer: z.string().describe('Grounded answer'),
  sources: z.array(PublicHttpUrlSchema).describe('Source URLs from search'),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured grounded source entries for client consumption'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  ...baseOutputFields,
});

export const AnalyzeUrlOutputSchema = z.object({
  answer: z.string().describe('URL content analysis'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('Retrieval status per URL'),
  ...baseOutputFields,
});

export const AnalyzeFileOutputSchema = z.object({
  analysis: z.string().describe('File analysis result'),
  ...baseOutputFields,
});

export const AgenticSearchOutputSchema = z.object({
  report: z.string().describe('Compiled markdown research report'),
  sources: z.array(PublicHttpUrlSchema).describe('Aggregated source URLs'),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured grounded source entries for client consumption'),
  toolsUsed: z
    .array(z.string())
    .optional()
    .describe('Tools invoked during research (e.g. googleSearch, codeExecution)'),
  ...baseOutputFields,
});

export const AnalyzePrOutputSchema = z.object({
  analysis: z.string().describe('Comprehensive PR review'),
  stats: z
    .object({
      files: nonNegativeInt('Files changed'),
      additions: nonNegativeInt('Lines added'),
      deletions: nonNegativeInt('Lines deleted'),
    })
    .describe('Diff statistics'),
  reviewedPaths: z.array(z.string()).describe('Relative file paths included in the review'),
  includedUntracked: z
    .array(z.string())
    .describe('Relative untracked text files synthesized into the generated diff'),
  skippedBinaryPaths: z
    .array(z.string())
    .describe('Relative untracked binary files skipped from the generated diff'),
  skippedLargePaths: z
    .array(z.string())
    .describe(
      'Relative untracked files skipped because they exceeded the synthesized diff size limit',
    ),
  omittedPaths: z
    .array(z.string())
    .optional()
    .describe('Relative diff paths omitted from Gemini review because of the review budget'),
  empty: z.boolean().describe('Whether there were any local changes to review'),
  truncated: z.boolean().optional().describe('Whether the diff was truncated due to size'),
  ...baseOutputFields,
});

const CacheSummarySchema = z.object({
  name: cacheName('Cache resource name').optional(),
  displayName: z.string().optional().describe('Human-readable label'),
  model: z.string().optional().describe('Model used'),
  expireTime: timestamp('Expiration timestamp').optional(),
  createTime: timestamp('Creation timestamp').optional(),
  updateTime: timestamp('Last update timestamp').optional(),
  totalTokenCount: nonNegativeInt('Total cached tokens').optional(),
});

export const CreateCacheOutputSchema = z.object({
  name: cacheName('Cache resource name'),
  displayName: z.string().optional().describe('Human-readable label'),
  model: z.string().optional().describe('Model used'),
  expireTime: timestamp('Expiration timestamp').optional(),
});

export const ListCachesOutputSchema = z.object({
  caches: z.array(CacheSummarySchema).describe('Active caches'),
  count: nonNegativeInt('Number of active caches'),
});

export const DeleteCacheOutputSchema = z.object({
  cacheName: cacheName('Cache resource name'),
  deleted: z.boolean().describe('Whether deletion was performed'),
});

export const UpdateCacheOutputSchema = z.object({
  cacheName: cacheName('Cache resource name'),
  expireTime: timestamp('New expiration timestamp').optional(),
});

export const ExplainErrorOutputSchema = z.object({
  explanation: z
    .string()
    .describe('Structured error diagnosis with root cause, explanation, and suggested fix'),
  ...baseOutputFields,
});

export const CompareFilesOutputSchema = z.object({
  comparison: z.string().describe('Structured comparison analysis'),
  ...baseOutputFields,
});

export const GenerateDiagramOutputSchema = z.object({
  diagram: z.string().describe('Generated diagram markup (Mermaid or PlantUML)'),
  diagramType: z.enum(['mermaid', 'plantuml']).describe('Diagram format used'),
  explanation: z.string().optional().describe('Brief explanation of the diagram structure'),
  ...baseOutputFields,
});
