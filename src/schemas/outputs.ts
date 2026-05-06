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

// ===== Resource metadata schemas =====

const _ResourceLinkSchema = z.strictObject({
  uri: z.url().describe('Absolute resource URI (e.g., gemini://sessions)'),
  name: z.string().optional().describe('Human-readable name'),
  description: z.string().optional().describe('Brief description of the resource'),
  mimeType: z.string().optional().describe('MIME type of the resource content'),
});

export type ResourceLink = z.infer<typeof _ResourceLinkSchema>;

const _ResourceMetadataSchema = z.strictObject({
  generatedAt: z.string().describe('ISO 8601 timestamp of generation'),
  source: z.enum(['gemini-assistant']).describe('Source system'),
  cached: z.boolean().describe('Whether response came from cache'),
  ttlMs: z.number().int().nonnegative().optional().describe('Time-to-live in milliseconds'),
  size: z.number().int().nonnegative().optional().describe('Content size in bytes'),
  links: z
    .strictObject({
      self: _ResourceLinkSchema.optional().describe('Link to this resource'),
    })
    .optional()
    .describe('Resource links block'),
});

export type ResourceMetadata = z.infer<typeof _ResourceMetadataSchema>;

// ===== Grounding rollup schemas =====

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
