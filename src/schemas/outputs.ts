import { z } from 'zod/v4';

import type {
  GroundingCitationSchema,
  GroundingSignalsSchema,
  UrlMetadataEntrySchema,
  UsageMetadataSchema,
} from './fields.js';
import {
  BaseOutputSchema,
  completedStatusField,
  DIAGRAM_TYPES,
  diffStatsFields,
  enumField,
  FindingSchema,
  groundingStatusField,
  JsonValueSchema,
  SourceDetailSchema,
} from './fields.js';

export type UsageMetadata = z.infer<typeof UsageMetadataSchema>;

export interface ContextSourceReport {
  kind: 'workspace-file' | 'session-summary' | 'cache' | 'workspace-cache';
  name: string;
  tokens: number;
}

export interface ContextUsed {
  sources: ContextSourceReport[];
  totalTokens: number;
  workspaceCacheApplied: boolean;
}

export type UrlMetadataEntry = z.infer<typeof UrlMetadataEntrySchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type GroundingCitation = z.infer<typeof GroundingCitationSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type GroundingSignals = z.infer<typeof GroundingSignalsSchema>;

const AnalyzeSummaryOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
  outputKind: z.literal('summary'),
  status: z
    .enum(['grounded', 'partially_grounded', 'ungrounded', 'completed'])
    .describe('Grounding or completion status'),
  summary: z.string().describe('Analysis summary text'),
});

const AnalyzeDiagramOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
  outputKind: z.literal('diagram'),
  status: completedStatusField,
  diagramType: enumField(DIAGRAM_TYPES, 'Diagram syntax used (diagram mode)'),
  diagram: z.string().describe('Generated diagram source'),
  explanation: z.string().optional().describe('Short explanation or caveats for the diagram'),
  syntaxErrors: z.array(z.string()).optional().describe('Diagram syntax validation errors'),
  syntaxValid: z.boolean().optional().describe('Whether diagram syntax validated successfully'),
});

export const AnalyzeOutputSchema = z.discriminatedUnion('outputKind', [
  AnalyzeSummaryOutputSchema,
  AnalyzeDiagramOutputSchema,
]);

export const ChatOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
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

export const ResearchOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
  status: groundingStatusField,
  summary: z.string().describe('Grounded research summary'),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured source entries for client consumption'),
  findings: z
    .array(FindingSchema)
    .optional()
    .describe('Claim-level findings attributed to retrieved sources; not independent proof'),
});

export const DocumentationDriftSchema = z.strictObject({
  file: z.string().describe('The path of the documentation file.'),
  driftDescription: z.string().describe('Why the diff makes the current docs outdated/misleading.'),
  suggestedUpdate: z.string().describe('Brief suggestion of what needs to be changed in the doc.'),
});

export const ReviewOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
  status: completedStatusField,
  summary: z.string().describe('Review result summary'),
  stats: z
    .strictObject(diffStatsFields)
    .optional()
    .describe('Diff statistics when subjectKind=diff'),
  documentationDrift: z
    .array(DocumentationDriftSchema)
    .optional()
    .describe('Factual documentation drifts caused by the diff. Omitted if no drift is detected.'),
});
