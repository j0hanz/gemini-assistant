import { z } from 'zod/v4';

export const ExecuteCodeInputSchema = z.object({
  task: z.string().min(1).describe('Description of the code task to perform'),
  language: z.string().optional().describe('Preferred language hint (Python is sandbox default)'),
});

export const SearchInputSchema = z.object({
  query: z.string().min(1).describe('Question or topic to research'),
  systemInstruction: z.string().optional().describe('Custom instructions for result presentation'),
  urls: z
    .array(z.url())
    .max(20)
    .optional()
    .describe('URLs to deeply analyze alongside search results (max 20). Enables URL Context.'),
});

export const AnalyzeFileInputSchema = z.object({
  filePath: z.string().trim().min(1).describe('Absolute path to the file to analyze'),
  question: z.string().min(1).describe('What to analyze or ask about the file'),
});

export const AnalyzeUrlInputSchema = z.object({
  urls: z
    .array(z.url())
    .min(1)
    .max(20)
    .describe('URLs to analyze (max 20). Must be publicly accessible.'),
  question: z.string().min(1).describe('What to analyze or ask about the URL content'),
  systemInstruction: z.string().optional().describe('Custom system instruction for URL analysis'),
});

export const CreateCacheInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('Absolute paths to files to include in the cache'),
    systemInstruction: z
      .string()
      .optional()
      .describe('System instruction to cache alongside the files'),
    ttl: z
      .string()
      .optional()
      .describe('Time-to-live for the cache (e.g., "3600s"). Defaults to 1 hour.'),
  })
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- LHS is boolean; ?? would not fall through on `false`
  .refine((data) => (data.filePaths && data.filePaths.length > 0) || data.systemInstruction, {
    message: 'At least one of filePaths or systemInstruction must be provided.',
  })
  .describe(
    'Creates a cache on the Gemini API. IMPORTANT: The combined content (files + instructions) MUST exceed ~32,000 tokens. Do not use for small contexts.',
  );
