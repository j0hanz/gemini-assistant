import { z } from 'zod/v4';

export const UsageMetadataSchema = z.object({
  promptTokenCount: z.number().optional().describe('Tokens in the prompt'),
  candidatesTokenCount: z.number().optional().describe('Tokens in the response'),
  thoughtsTokenCount: z.number().optional().describe('Tokens used for thinking'),
  totalTokenCount: z.number().optional().describe('Total tokens for the request'),
});

const baseOutputFields = {
  thoughts: z.string().optional().describe('Internal model reasoning/thinking process'),
  usage: UsageMetadataSchema.optional().describe('Token usage'),
};

export const AskOutputSchema = z.object({
  answer: z.string().describe('Generated response'),
  data: z.unknown().optional().describe('Parsed structured response when JSON mode is used'),
  ...baseOutputFields,
});

export const ExecuteCodeOutputSchema = z.object({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Model explanation'),
  ...baseOutputFields,
});

const UrlMetadataEntrySchema = z.object({
  url: z.string().describe('Retrieved URL'),
  status: z.string().describe('Retrieval status (e.g. URL_RETRIEVAL_STATUS_SUCCESS)'),
});

export type UrlMetadataEntry = z.infer<typeof UrlMetadataEntrySchema>;

export const SearchOutputSchema = z.object({
  answer: z.string().describe('Grounded answer'),
  sources: z.array(z.string()).describe('Source URLs from search'),
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
  sources: z.array(z.string()).describe('Aggregated source URLs'),
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
      files: z.number().describe('Files changed'),
      additions: z.number().describe('Lines added'),
      deletions: z.number().describe('Lines deleted'),
    })
    .describe('Diff statistics'),
  mode: z.string().describe('Diff mode used'),
  ...baseOutputFields,
});

const CacheSummarySchema = z.object({
  name: z.string().optional().describe('Cache resource name'),
  displayName: z.string().optional().describe('Human-readable label'),
  model: z.string().optional().describe('Model used'),
  expireTime: z.string().optional().describe('Expiration timestamp'),
  createTime: z.string().optional().describe('Creation timestamp'),
  updateTime: z.string().optional().describe('Last update timestamp'),
  totalTokenCount: z.number().optional().describe('Total cached tokens'),
});

export const CreateCacheOutputSchema = z.object({
  name: z.string().describe('Cache resource name'),
  displayName: z.string().optional().describe('Human-readable label'),
  model: z.string().optional().describe('Model used'),
  expireTime: z.string().optional().describe('Expiration timestamp'),
});

export const ListCachesOutputSchema = z.object({
  caches: z.array(CacheSummarySchema).describe('Active caches'),
  count: z.number().describe('Number of active caches'),
});

export const DeleteCacheOutputSchema = z.object({
  cacheName: z.string().describe('Cache resource name'),
  deleted: z.boolean().describe('Whether deletion was performed'),
});

export const UpdateCacheOutputSchema = z.object({
  cacheName: z.string().describe('Cache resource name'),
  expireTime: z.string().optional().describe('New expiration timestamp'),
});
