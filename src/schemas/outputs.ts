import { z } from 'zod/v4';

import { cacheName, nonNegativeInt, PublicHttpUrlSchema, timestamp } from './shared.js';

export const UsageMetadataSchema = z.strictObject({
  promptTokenCount: nonNegativeInt('Tokens in the prompt').optional(),
  candidatesTokenCount: nonNegativeInt('Tokens in the response').optional(),
  thoughtsTokenCount: nonNegativeInt('Tokens used for thinking').optional(),
  totalTokenCount: nonNegativeInt('Total tokens for the request').optional(),
});

export type UsageMetadata = z.infer<typeof UsageMetadataSchema>;

const FunctionCallEntrySchema = z.strictObject({
  name: z.string().describe('Function/tool name'),
  args: z.record(z.string(), z.unknown()).describe('Function call arguments').optional(),
  id: z.string().describe('Function call identifier when present').optional(),
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

const ToolEventSchema = z.strictObject({
  kind: ToolEventKindSchema.describe('Normalized Gemini tool/function event type'),
  name: z.string().describe('Function name when available').optional(),
  toolType: z.string().describe('Built-in tool type when available').optional(),
  id: z.string().describe('Stable Gemini call identifier when available').optional(),
  thoughtSignature: z
    .string()
    .optional()
    .describe('Thought signature returned by Gemini for the part'),
  args: z.record(z.string(), z.unknown()).describe('Tool or function arguments').optional(),
  response: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Tool or function response payload'),
  code: z.string().describe('Executable code payload').optional(),
  output: z.string().describe('Code execution output').optional(),
  outcome: z.string().describe('Code execution outcome').optional(),
  text: z
    .string()
    .optional()
    .describe('Part text when a signature-bearing part has no tool payload'),
});

const baseOutputFields = {
  thoughts: z.string().describe('Internal model reasoning/thinking process').optional(),
  usage: UsageMetadataSchema.describe('Token usage').optional(),
  functionCalls: z
    .array(FunctionCallEntrySchema)
    .optional()
    .describe('Server-side function calls made during generation'),
  toolEvents: z
    .array(ToolEventSchema)
    .optional()
    .describe('Normalized Gemini tool/function event stream captured during generation'),
};

const WorkspaceCacheSchema = z.strictObject({
  applied: z.literal(true).describe('Whether the automatic workspace cache was applied'),
  cacheName: cacheName('Automatically applied workspace cache resource name'),
});

export const AskOutputSchema = z.strictObject({
  answer: z.string().describe('Generated response'),
  data: z.unknown().describe('Parsed structured response when JSON mode is used').optional(),
  schemaWarnings: z
    .array(z.string())
    .optional()
    .describe('Warnings from structured output validation (parse failures, schema mismatches)'),
  workspaceCache: WorkspaceCacheSchema.optional().describe(
    'Metadata about an automatically applied workspace cache',
  ),
  ...baseOutputFields,
});

export const ExecuteCodeOutputSchema = z.strictObject({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Model explanation'),
  runtime: z.literal('python').describe('Actual Gemini execution runtime'),
  requestedLanguage: z
    .string()
    .optional()
    .describe('Requested language hint when the caller supplied one'),
  ...baseOutputFields,
});

const UrlMetadataEntrySchema = z.strictObject({
  url: PublicHttpUrlSchema.describe('Retrieved URL'),
  status: z.string().describe('Retrieval status (e.g. URL_RETRIEVAL_STATUS_SUCCESS)'),
});

export type UrlMetadataEntry = z.infer<typeof UrlMetadataEntrySchema>;

const SourceDetailSchema = z.strictObject({
  title: z.string().describe('Source title when Gemini provides one').optional(),
  url: PublicHttpUrlSchema.describe('Source URL'),
});

export type SourceDetail = z.infer<typeof SourceDetailSchema>;

export const SearchOutputSchema = z.strictObject({
  answer: z.string().describe('Grounded answer'),
  sources: z.array(PublicHttpUrlSchema).describe('Source URLs from search'),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured grounded source entries for client consumption'),
  urlMetadata: z.array(UrlMetadataEntrySchema).describe('URL retrieval status').optional(),
  ...baseOutputFields,
});

export const AnalyzeUrlOutputSchema = z.strictObject({
  answer: z.string().describe('URL content analysis'),
  urlMetadata: z.array(UrlMetadataEntrySchema).describe('Retrieval status per URL').optional(),
  ...baseOutputFields,
});

export const AnalyzeFileOutputSchema = z.strictObject({
  analysis: z.string().describe('File analysis result'),
  ...baseOutputFields,
});

export const AgenticSearchOutputSchema = z.strictObject({
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

export const AnalyzePrOutputSchema = z.strictObject({
  analysis: z.string().describe('Comprehensive PR review'),
  stats: z
    .strictObject({
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
  truncated: z.boolean().describe('Whether the diff was truncated due to size').optional(),
  ...baseOutputFields,
});

const CacheSummarySchema = z.strictObject({
  name: cacheName('Cache resource name').optional(),
  displayName: z.string().describe('Human-readable label').optional(),
  model: z.string().describe('Model used').optional(),
  expireTime: timestamp('Expiration timestamp').optional(),
  createTime: timestamp('Creation timestamp').optional(),
  updateTime: timestamp('Last update timestamp').optional(),
  totalTokenCount: nonNegativeInt('Total cached tokens').optional(),
});

export const CreateCacheOutputSchema = z.strictObject({
  name: cacheName('Cache resource name'),
  displayName: z.string().describe('Human-readable label').optional(),
  model: z.string().describe('Model used').optional(),
  expireTime: timestamp('Expiration timestamp').optional(),
});

export const ListCachesOutputSchema = z.strictObject({
  caches: z.array(CacheSummarySchema).describe('Active caches'),
  count: nonNegativeInt('Number of active caches'),
});

export const DeleteCacheOutputSchema = z.strictObject({
  cacheName: cacheName('Cache resource name'),
  deleted: z.boolean().describe('Whether deletion was performed'),
  confirmationRequired: z
    .boolean()
    .optional()
    .describe(
      'Whether the client must rerun with confirm=true because interactive confirmation was unavailable',
    ),
});

export const UpdateCacheOutputSchema = z.strictObject({
  cacheName: cacheName('Cache resource name'),
  expireTime: timestamp('New expiration timestamp').optional(),
});

export const ExplainErrorOutputSchema = z.strictObject({
  explanation: z
    .string()
    .describe('Structured error diagnosis with root cause, explanation, and suggested fix'),
  ...baseOutputFields,
});

export const CompareFilesOutputSchema = z.strictObject({
  comparison: z.string().describe('Structured comparison analysis'),
  ...baseOutputFields,
});

export const GenerateDiagramOutputSchema = z.strictObject({
  diagram: z.string().describe('Generated diagram markup (Mermaid or PlantUML)'),
  diagramType: z.enum(['mermaid', 'plantuml']).describe('Diagram format used'),
  explanation: z.string().describe('Brief explanation of the diagram structure').optional(),
  ...baseOutputFields,
});
