import { z } from 'zod/v4';

export const UsageMetadataSchema = z.object({
  promptTokenCount: z.number().optional().describe('Tokens in the prompt'),
  candidatesTokenCount: z.number().optional().describe('Tokens in the response'),
  thoughtsTokenCount: z.number().optional().describe('Tokens used for thinking'),
  totalTokenCount: z.number().optional().describe('Total tokens for the request'),
});

export const AskOutputSchema = z.object({
  answer: z.string().describe('Generated response'),
  usage: UsageMetadataSchema.optional().describe('Token usage'),
});

export const ExecuteCodeOutputSchema = z.object({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Model explanation'),
  usage: UsageMetadataSchema.optional().describe('Token usage'),
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
  usage: UsageMetadataSchema.optional().describe('Token usage'),
});

export const AnalyzeUrlOutputSchema = z.object({
  answer: z.string().describe('URL content analysis'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('Retrieval status per URL'),
  usage: UsageMetadataSchema.optional().describe('Token usage'),
});

export const AnalyzeFileOutputSchema = z.object({
  analysis: z.string().describe('File analysis result'),
  usage: UsageMetadataSchema.optional().describe('Token usage'),
});
