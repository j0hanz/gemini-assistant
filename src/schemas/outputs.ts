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
  FindingSchema,
  GroundingCitationSchema,
  GroundingSignalsSchema,
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
export type Finding = z.infer<typeof FindingSchema>;
export type GroundingSignals = z.infer<typeof GroundingSignalsSchema>;
export type SearchEntryPoint = z.infer<typeof SearchEntryPointSchema>;

const GroundingStatusSchema = z
  .enum(['completed', 'grounded', 'partially_grounded', 'ungrounded'])
  .describe('Grounding status; `completed` is accepted for legacy successful outputs');

const ComputationSchema = z.strictObject({
  code: z.string().describe('Executable code emitted by Gemini Code Execution'),
  language: z.string().optional().describe('Code language when provided'),
  outcome: z.string().optional().describe('Code execution outcome when provided'),
  output: z.string().optional().describe('Code execution output when provided'),
  id: z.string().optional().describe('Code execution identifier when provided'),
});

const AnalyzeSummaryOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  status: GroundingStatusSchema,
  kind: z.literal('summary').describe('Analyze output selector (`summary`)'),
  targetKind: z.enum(['file', 'url', 'multi']).describe('Analyze target discriminator'),
  summary: z.string().describe('Grounded analysis summary'),
  groundingSignals: GroundingSignalsSchema.optional(),
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
  computations: z
    .array(ComputationSchema)
    .optional()
    .describe('Gemini Code Execution computations surfaced from tool events'),
  workspaceCacheApplied: z
    .boolean()
    .default(false)
    .describe('Whether automatic workspace cache was applied for this chat turn'),
});

export const ResearchOutputSchema = z.strictObject({
  ...publicBaseOutputFields,
  status: GroundingStatusSchema,
  mode: enumField(RESEARCH_MODE_OPTIONS, 'Research mode that handled the request'),
  summary: z.string().describe('Grounded research summary'),
  sources: publicHttpUrlArray({
    description: 'Grounded source URLs',
    itemDescription: 'Grounded source URL',
    optional: true,
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
  grounded: z
    .boolean()
    .optional()
    .describe('Deprecated: whether claim-level grounding citations were surfaced'),
  groundingSignals: GroundingSignalsSchema.optional(),
  findings: z.array(FindingSchema).optional().describe('Claim-level findings with attribution'),
  claimLinkedSources: publicHttpUrlArray({
    optional: true,
    description: 'Subset of sources cited by at least one finding',
    itemDescription: 'Claim-linked source URL',
  }),
  urlContextUsed: z.boolean().optional().describe('Whether URL Context retrieval succeeded'),
  citations: z
    .array(GroundingCitationSchema)
    .optional()
    .describe('Claim-level citations derived from Gemini grounding supports'),
  searchEntryPoint: SearchEntryPointSchema.optional().describe('Deprecated; render from content.'),
  computations: z
    .array(ComputationSchema)
    .optional()
    .describe('Gemini Code Execution computations surfaced from tool events'),
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
