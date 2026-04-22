import { z } from 'zod/v4';

import {
  DIAGRAM_TYPES,
  enumField,
  nonNegativeInt,
  publicHttpUrlArray,
  RESEARCH_MODE_OPTIONS,
  REVIEW_SUBJECT_OPTIONS,
} from './fields.js';
import {
  UsageMetadataSchema as BaseUsageMetadataSchema,
  diffStatsFields,
  GroundingCitationSchema,
  publicBaseOutputFields,
  SearchEntryPointSchema,
  SourceDetailSchema,
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
export type GroundingCitation = z.infer<typeof GroundingCitationSchema>;
export type SearchEntryPoint = z.infer<typeof SearchEntryPointSchema>;

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
  syntaxErrors: z.array(z.string()).optional().describe('Diagram syntax validation errors'),
  syntaxValid: z.boolean().optional().describe('Whether diagram syntax validated successfully'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  analyzedPaths: z.array(z.string()).optional().describe('Local files included in the analysis'),
  contextUsed: ContextUsedSchema.optional(),
});

const SessionResourceLinksSchema = z.strictObject({
  detail: z.string().describe('Session detail resource URI'),
  events: z.string().describe('Session events resource URI'),
  transcript: z.string().describe('Session transcript resource URI'),
  turnParts: z
    .string()
    .optional()
    .describe('Templated replay-safe raw Gemini Part[] resource URI for a persisted model turn'),
});

export const ChatOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  answer: z.string().describe('Chat response text'),
  data: z.unknown().describe('Structured response payload when JSON mode is used').optional(),
  session: z
    .strictObject({
      id: z.string().describe('Server-managed in-memory session identifier'),
      rebuiltAt: z.number().int().nonnegative().optional().describe('Session rebuild timestamp'),
      resources: SessionResourceLinksSchema,
    })
    .optional()
    .describe(
      'Session metadata for new or resumed chat sessions. Resumed sessions without persisted Part[] (e.g. pre-upgrade transcripts) cannot be resumed and must be started fresh.',
    ),
  contextUsed: ContextUsedSchema.optional(),
  workspaceCacheApplied: z
    .boolean()
    .default(false)
    .describe('Whether automatic workspace cache was applied for this chat turn'),
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
  urlContextSources: publicHttpUrlArray({
    description: 'URL Context source URLs',
    itemDescription: 'URL Context source URL',
    optional: true,
  }),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  toolsUsed: z.array(z.string()).optional().describe('Tools invoked during deep research'),
  grounded: z.boolean().optional().describe('Whether grounded sources were surfaced'),
  urlContextUsed: z.boolean().optional().describe('Whether URL Context retrieval succeeded'),
  citations: z
    .array(GroundingCitationSchema)
    .optional()
    .describe('Claim-level citations derived from Gemini grounding supports'),
  searchEntryPoint: SearchEntryPointSchema.optional().describe(
    'Google Search entry point content for display compliance',
  ),
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
