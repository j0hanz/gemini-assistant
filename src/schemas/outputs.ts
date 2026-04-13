import { z } from 'zod/v4';

export const AskOutputSchema = z.object({
  answer: z.string().describe('The generated response text'),
});

export const ExecuteCodeOutputSchema = z.object({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Explanatory text from the model'),
});

const UrlMetadataEntrySchema = z.object({
  url: z.string().describe('Retrieved URL'),
  status: z.string().describe('Retrieval status (e.g. URL_RETRIEVAL_STATUS_SUCCESS)'),
});

export const SearchOutputSchema = z.object({
  answer: z.string().describe('Grounded answer text'),
  sources: z.array(z.string()).describe('Source URLs from Google Search'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('URL Context retrieval status'),
});

export const AnalyzeUrlOutputSchema = z.object({
  answer: z.string().describe('Analysis of the URL content'),
  urlMetadata: z.array(UrlMetadataEntrySchema).optional().describe('Retrieval status per URL'),
});
