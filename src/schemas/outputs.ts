import { z } from 'zod/v4';

import type { SearchEntryPointSchema } from './fields.js';
import {
  UsageMetadataSchema as BaseUsageMetadataSchema,
  completedStatusField,
  DIAGRAM_TYPES,
  diffStatsFields,
  enumField,
  FindingSchema,
  GroundingCitationSchema,
  GroundingSignalsSchema,
  groundingStatusField,
  JsonValueSchema,
  nonNegativeInt,
  publicCoreOutputFields,
  publicHttpUrlArray,
  REVIEW_SUBJECT_OPTIONS,
  SourceDetailSchema,
  UrlMetadataEntrySchema,
} from './fields.js';

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

const ComputationSchema = z.strictObject({
  code: z.string().describe('Executable code emitted by Gemini Code Execution'),
  language: z.string().optional().describe('Code language when provided'),
  outcome: z.string().optional().describe('Code execution outcome when provided'),
  output: z.string().optional().describe('Code execution output when provided'),
  id: z.string().optional().describe('Code execution identifier when provided'),
});

const AnalyzeSummaryOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: groundingStatusField,
  kind: z.literal('summary').describe('Analyze output selector (`summary`)'),
  targetKind: z.enum(['file', 'url', 'multi']).describe('Analyze target discriminator'),
  summary: z.string().describe('Grounded analysis summary'),
  groundingSignals: GroundingSignalsSchema.optional(),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL retrieval status'),
  analyzedPaths: z.array(z.string()).optional().describe('Local files included in the analysis'),
  contextUsed: ContextUsedSchema.optional(),
});

const AnalyzeDiagramOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: completedStatusField,
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

export const ChatOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: completedStatusField,
  answer: z.string().describe('Chat response text'),
  data: JsonValueSchema.describe('Structured response payload when JSON mode is used').optional(),
  session: z
    .strictObject({
      id: z.string().describe('Server-managed session identifier'),
    })
    .optional()
    .describe('Session metadata. Provide id to continue this session in a future call.'),
});

const ResearchSharedFields = {
  ...publicCoreOutputFields,
  status: groundingStatusField,
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
  groundingSignals: GroundingSignalsSchema.optional(),
  contextUsed: ContextUsedSchema.optional(),
};

const ResearchQuickOutputSchema = z.strictObject({
  ...ResearchSharedFields,
  mode: z.literal('quick').describe('Quick research mode'),
});

const ResearchDeepOutputSchema = z.strictObject({
  ...ResearchSharedFields,
  mode: z.literal('deep').describe('Deep research mode'),
  toolsUsed: z.array(z.string()).optional().describe('Tools invoked during deep research'),
  findings: z
    .array(FindingSchema)
    .optional()
    .describe('Claim-level findings attributed to retrieved sources; not independent proof'),
  citations: z
    .array(GroundingCitationSchema)
    .optional()
    .describe('Claim-level source attributions derived from Gemini grounding supports'),
  computations: z
    .array(ComputationSchema)
    .optional()
    .describe('Gemini Code Execution computations surfaced from tool events'),
});

export const ResearchOutputSchema = z.discriminatedUnion('mode', [
  ResearchQuickOutputSchema,
  ResearchDeepOutputSchema,
]);

export const AnalyzeOutputSchema = z.discriminatedUnion('kind', [
  AnalyzeSummaryOutputSchema,
  AnalyzeDiagramOutputSchema,
]);

export const DocumentationDriftSchema = z.strictObject({
  file: z.string().describe('The path of the documentation file.'),
  driftDescription: z.string().describe('Why the diff makes the current docs outdated/misleading.'),
  suggestedUpdate: z.string().describe('Brief suggestion of what needs to be changed in the doc.'),
});

export const ReviewOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: completedStatusField,
  subjectKind: enumField(REVIEW_SUBJECT_OPTIONS, 'Review subject discriminator'),
  summary: z.string().describe('Review result summary'),
  schemaWarnings: z.array(z.string()).optional().describe('Schema-level review warnings.'),
  stats: z
    .strictObject(diffStatsFields)
    .optional()
    .describe('Diff statistics when subjectKind=diff'),
  reviewedPaths: z.array(z.string()).optional().describe('Paths included in a local diff review'),
  includedUntracked: z.array(z.string()).optional().describe('Included untracked text files'),
  skippedBinaryPaths: z.array(z.string()).optional().describe('Skipped untracked binary files'),
  skippedLargePaths: z.array(z.string()).optional().describe('Skipped large untracked files'),
  skippedSensitivePaths: z
    .array(z.string())
    .optional()
    .describe('Skipped untracked files that matched sensitive credential path rules'),
  omittedPaths: z.array(z.string()).optional().describe('Local diff paths omitted due to budget'),
  empty: z.boolean().optional().describe('Whether the local diff is empty (no changes)'),
  truncated: z.boolean().optional().describe('Whether the diff review was truncated'),
  documentationDrift: z
    .array(DocumentationDriftSchema)
    .optional()
    .describe('Factual documentation drifts caused by the diff. Omitted if no drift is detected.'),
  contextUsed: ContextUsedSchema.optional(),
});
