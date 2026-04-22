import { z } from 'zod/v4';

import {
  cacheName,
  DIAGRAM_TYPES,
  enumField,
  MEMORY_ACTION_OPTIONS,
  nonNegativeInt,
  publicHttpUrlArray,
  RESEARCH_MODE_OPTIONS,
  REVIEW_SUBJECT_OPTIONS,
  timestamp,
} from './fields.js';
import {
  UsageMetadataSchema as BaseUsageMetadataSchema,
  cacheSummaryFields,
  CacheSummarySchema,
  diffStatsFields,
  FunctionCallEntrySchema,
  publicBaseOutputFields,
  SessionSummarySchema,
  SourceDetailSchema,
  ToolEventSchema,
  UrlMetadataEntrySchema,
} from './fragments.js';

export const UsageMetadataSchema = BaseUsageMetadataSchema;

export type UsageMetadata = z.infer<typeof UsageMetadataSchema>;

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

export type UrlMetadataEntry = z.infer<typeof UrlMetadataEntrySchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;

const AnalyzeSummaryOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  kind: z.literal('summary').describe('Analyze output selector (`summary`)'),
  targetKind: z.enum(['file', 'url', 'multi']).describe('Analyze target discriminator'),
  summary: z.string().describe('Grounded analysis summary'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  analyzedPaths: z.array(z.string()).optional().describe('Local files included in the analysis'),
  contextUsed: ContextUsedSchema.optional(),
});

const AnalyzeDiagramOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  kind: z.literal('diagram').describe('Analyze output selector (`diagram`)'),
  targetKind: z.enum(['file', 'url', 'multi']).describe('Analyze target discriminator'),
  diagramType: enumField(DIAGRAM_TYPES, 'Diagram syntax used for the output'),
  diagram: z.string().describe('Generated diagram source'),
  explanation: z.string().optional().describe('Short explanation or caveats for the diagram'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  analyzedPaths: z.array(z.string()).optional().describe('Local files included in the analysis'),
  contextUsed: ContextUsedSchema.optional(),
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

export const DeleteCachePublicOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  summary: z.string().describe('High-level result summary'),
  cacheName: cacheName('Cache resource name'),
  deleted: z.boolean().optional().describe('Whether deletion was performed'),
  confirmationRequired: z
    .boolean()
    .optional()
    .describe('Whether client must rerun with confirm=true.'),
  resourceUris: z.array(z.string()).optional(),
});

export const UpdateCacheOutputSchema = z.strictObject({
  cacheName: cacheName('Cache resource name'),
  expireTime: timestamp('New expiration timestamp').optional(),
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
  mode: enumField(RESEARCH_MODE_OPTIONS, 'Research mode that handled the request'),
  summary: z.string().describe('Grounded research summary'),
  sources: publicHttpUrlArray({
    description: 'Grounded source URLs',
    itemDescription: 'Grounded source URL',
  }),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured source entries for client consumption'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  toolsUsed: z.array(z.string()).optional().describe('Tools invoked during deep research'),
  contextUsed: ContextUsedSchema.optional(),
});

export const AnalyzeOutputSchema = z.discriminatedUnion('kind', [
  AnalyzeSummaryOutputSchema,
  AnalyzeDiagramOutputSchema,
]);

export const ReviewOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  subjectKind: enumField(REVIEW_SUBJECT_OPTIONS, 'Review subject discriminator'),
  summary: z.string().describe('Review result summary'),
  stats: z
    .strictObject(diffStatsFields)
    .optional()
    .describe('Diff statistics when subjectKind=diff'),
  reviewedPaths: z.array(z.string()).optional().describe('Paths included in a local diff review'),
  includedUntracked: z.array(z.string()).optional().describe('Included untracked text files'),
  skippedBinaryPaths: z.array(z.string()).optional().describe('Skipped untracked binary files'),
  skippedLargePaths: z.array(z.string()).optional().describe('Skipped large untracked files'),
  omittedPaths: z.array(z.string()).optional().describe('Local diff paths omitted due to budget'),
  empty: z.boolean().optional().describe('Whether the local diff is empty (no changes)'),
  truncated: z.boolean().optional().describe('Whether the diff review was truncated'),
  contextUsed: ContextUsedSchema.optional(),
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

const CacheListEntrySchema = z.strictObject(cacheSummaryFields);

export const MemoryOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  action: enumField(MEMORY_ACTION_OPTIONS, 'Memory action that handled the request'),
  summary: z.string().describe('High-level result summary'),
  sessions: z.array(SessionSummarySchema).optional(),
  session: SessionSummarySchema.optional(),
  transcript: z.array(SessionTranscriptEntrySchema).optional(),
  events: z.array(SessionEventSummarySchema).optional(),
  caches: z.array(CacheListEntrySchema).optional(),
  cache: CacheListEntrySchema.optional(),
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
