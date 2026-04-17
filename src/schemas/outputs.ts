import { z } from 'zod/v4';

import { cacheName, nonNegativeInt, PublicHttpUrlSchema, timestamp } from './shared.js';

export const UsageMetadataSchema = z.strictObject({
  promptTokenCount: nonNegativeInt('Tokens in the prompt').optional(),
  candidatesTokenCount: nonNegativeInt('Tokens in the response').optional(),
  thoughtsTokenCount: nonNegativeInt('Tokens used for thinking').optional(),
  totalTokenCount: nonNegativeInt('Total tokens for the request').optional(),
});

export type UsageMetadata = z.infer<typeof UsageMetadataSchema>;

export const PublicOutputStatusSchema = z.literal('completed');

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

const streamMetadataOutputFields = {
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

const publicBaseOutputFields = {
  status: PublicOutputStatusSchema.describe('Stable status for successful tool executions'),
  requestId: z.string().describe('Server-side request or task identifier').optional(),
  warnings: z.array(z.string()).describe('Non-fatal warnings for the result').optional(),
  ...streamMetadataOutputFields,
};

export const PublicBaseOutputSchema = z.strictObject(publicBaseOutputFields);

export const AskOutputSchema = z.strictObject({
  answer: z.string().describe('Generated response'),
  data: z.unknown().describe('Parsed structured response when JSON mode is used').optional(),
  schemaWarnings: z
    .array(z.string())
    .optional()
    .describe('Warnings from structured output validation (parse failures, schema mismatches)'),
  ...streamMetadataOutputFields,
});

const ContextSourceReportSchema = z.strictObject({
  kind: z
    .enum(['workspace-file', 'session-summary', 'cache', 'workspace-cache'])
    .describe('Context source type'),
  name: z.string().describe('Source identifier (filename, session ID, or cache name)'),
  tokens: nonNegativeInt('Estimated token cost for this source'),
});

export type ContextSourceReport = z.infer<typeof ContextSourceReportSchema>;

export const ContextUsedSchema = z
  .strictObject({
    sources: z.array(ContextSourceReportSchema).describe('Context sources included in the call'),
    totalTokens: nonNegativeInt('Total context tokens consumed'),
    workspaceCacheApplied: z.boolean().describe('Whether automatic workspace cache was applied'),
  })
  .describe('Context transparency metadata');

export type ContextUsed = z.infer<typeof ContextUsedSchema>;

export const ExecuteCodeOutputSchema = z.strictObject({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Model explanation'),
  runtime: z.literal('python').describe('Actual Gemini execution runtime'),
  requestedLanguage: z
    .string()
    .optional()
    .describe('Requested language hint when the caller supplied one'),
  ...streamMetadataOutputFields,
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
  ...streamMetadataOutputFields,
});

export const AnalyzeUrlOutputSchema = z.strictObject({
  answer: z.string().describe('URL content analysis'),
  urlMetadata: z.array(UrlMetadataEntrySchema).describe('Retrieval status per URL').optional(),
  ...streamMetadataOutputFields,
});

export const AnalyzeFileOutputSchema = z.strictObject({
  analysis: z.string().describe('File analysis result'),
  ...streamMetadataOutputFields,
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
  ...streamMetadataOutputFields,
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
  ...streamMetadataOutputFields,
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
  ...streamMetadataOutputFields,
});

export const CompareFilesOutputSchema = z.strictObject({
  comparison: z.string().describe('Structured comparison analysis'),
  ...streamMetadataOutputFields,
});

export const GenerateDiagramOutputSchema = z.strictObject({
  diagram: z.string().describe('Generated diagram markup (Mermaid or PlantUML)'),
  diagramType: z.enum(['mermaid', 'plantuml']).describe('Diagram format used'),
  explanation: z.string().describe('Brief explanation of the diagram structure').optional(),
  ...streamMetadataOutputFields,
});

const SessionResourceLinksSchema = z.strictObject({
  detail: z.string().describe('Session detail resource URI'),
  events: z.string().describe('Session events resource URI'),
  transcript: z.string().describe('Session transcript resource URI'),
});

export const ChatOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  answer: z.string().describe('Chat response text'),
  data: z.unknown().describe('Structured response payload when JSON mode is used').optional(),
  session: z
    .strictObject({
      id: z.string().describe('Server-managed in-memory session identifier'),
      resources: SessionResourceLinksSchema,
    })
    .optional()
    .describe('Session metadata for new or resumed chat sessions.'),
  contextUsed: ContextUsedSchema.optional(),
});

export const ResearchOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  mode: z.enum(['quick', 'deep']).describe('Research mode that handled the request'),
  summary: z.string().describe('Grounded research summary'),
  sources: z.array(PublicHttpUrlSchema).describe('Grounded source URLs'),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured source entries for client consumption'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  toolsUsed: z.array(z.string()).optional().describe('Tools invoked during deep research'),
  contextUsed: ContextUsedSchema.optional(),
});

export const AnalyzeOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  targetKind: z.enum(['file', 'url', 'multi']).describe('Analyze target discriminator'),
  summary: z.string().describe('Grounded analysis summary'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  analyzedPaths: z.array(z.string()).optional().describe('Local files included in the analysis'),
  contextUsed: ContextUsedSchema.optional(),
});

export const ReviewOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  subjectKind: z.enum(['diff', 'comparison', 'failure']).describe('Review subject discriminator'),
  summary: z.string().describe('Review result summary'),
  stats: z
    .strictObject({
      files: nonNegativeInt('Files changed'),
      additions: nonNegativeInt('Lines added'),
      deletions: nonNegativeInt('Lines deleted'),
    })
    .optional()
    .describe('Diff statistics when review.subject.kind=diff'),
  reviewedPaths: z.array(z.string()).optional().describe('Paths included in a diff review'),
  includedUntracked: z.array(z.string()).optional().describe('Included untracked text files'),
  skippedBinaryPaths: z.array(z.string()).optional().describe('Skipped untracked binary files'),
  skippedLargePaths: z.array(z.string()).optional().describe('Skipped large untracked files'),
  omittedPaths: z.array(z.string()).optional().describe('Diff paths omitted due to budget'),
  empty: z.boolean().optional().describe('Whether there were any local changes to review'),
  truncated: z.boolean().optional().describe('Whether the diff review was truncated'),
  contextUsed: ContextUsedSchema.optional(),
});

const CacheListEntrySchema = z.strictObject({
  name: cacheName('Cache resource name').optional(),
  displayName: z.string().describe('Human-readable label').optional(),
  model: z.string().describe('Model used').optional(),
  expireTime: timestamp('Expiration timestamp').optional(),
  createTime: timestamp('Creation timestamp').optional(),
  updateTime: timestamp('Last update timestamp').optional(),
  totalTokenCount: nonNegativeInt('Total cached tokens').optional(),
});

const SessionSummarySchema = z.strictObject({
  id: z.string().describe('Server-managed session identifier'),
  lastAccess: z.number().describe('Last access timestamp in epoch milliseconds'),
});

const SessionTranscriptEntrySchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  timestamp: z.number(),
  taskId: z.string().optional(),
});

const SessionEventSummarySchema = z.strictObject({
  request: z.strictObject({
    message: z.string(),
    toolProfile: z.string().optional(),
    urls: z.array(z.string()).optional(),
  }),
  response: z.strictObject({
    data: z.unknown().optional(),
    functionCalls: z.array(FunctionCallEntrySchema).optional(),
    schemaWarnings: z.array(z.string()).optional(),
    thoughts: z.string().optional(),
    text: z.string(),
    toolEvents: z.array(ToolEventSchema).optional(),
    usage: UsageMetadataSchema.optional(),
  }),
  timestamp: z.number(),
  taskId: z.string().optional(),
});

export const MemoryOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  action: z
    .enum([
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
    ])
    .describe('Memory action that handled the request'),
  summary: z.string().describe('High-level result summary'),
  sessions: z.array(SessionSummarySchema).optional(),
  session: SessionSummarySchema.optional(),
  transcript: z.array(SessionTranscriptEntrySchema).optional(),
  events: z.array(SessionEventSummarySchema).optional(),
  caches: z.array(CacheListEntrySchema).optional(),
  cache: CacheListEntrySchema.optional(),
  deleted: z.boolean().optional(),
  confirmationRequired: z.boolean().optional(),
  workspaceContext: z
    .strictObject({
      content: z.string(),
      estimatedTokens: nonNegativeInt('Estimated token count'),
      sources: z.array(z.string()),
    })
    .optional(),
  workspaceCache: z.record(z.string(), z.unknown()).optional(),
  resourceUris: z.array(z.string()).optional(),
});

const DiscoverCatalogEntrySchema = z.strictObject({
  kind: z.enum(['tool', 'prompt', 'resource']),
  name: z.string(),
  title: z.string(),
});

const DiscoverWorkflowEntrySchema = z.strictObject({
  name: z.string(),
  goal: z.string(),
  whenToUse: z.string(),
});

export const DiscoverOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  summary: z.string().describe('Discovery guidance summary'),
  job: z
    .enum(['chat', 'research', 'analyze', 'review', 'memory', 'discover'])
    .optional()
    .describe('Requested job focus when supplied'),
  recommendedTools: z
    .array(z.enum(['chat', 'research', 'analyze', 'review', 'memory', 'discover']))
    .describe('Recommended public jobs to call next'),
  recommendedPrompts: z
    .array(z.enum(['discover', 'research', 'review', 'memory']))
    .describe('Related public prompts'),
  relatedResources: z.array(z.string()).describe('Related public resource URIs'),
  limitations: z.array(z.string()).optional().describe('Contract-aware limitation notes'),
  catalog: z.array(DiscoverCatalogEntrySchema).optional(),
  workflows: z.array(DiscoverWorkflowEntrySchema).optional(),
});
