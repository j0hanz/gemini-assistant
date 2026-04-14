import { z } from 'zod/v4';

import { THINKING_LEVELS } from '../lib/config-utils.js';

export const ExecuteCodeInputSchema = z.object({
  task: z.string().min(1).describe('Code task to perform'),
  language: z.string().optional().describe('Preferred language (Python is sandbox default)'),
  thinkingLevel: z.enum(THINKING_LEVELS).optional().describe('Thinking depth for reasoning.'),
});
export type ExecuteCodeInput = z.infer<typeof ExecuteCodeInputSchema>;

export const SearchInputSchema = z.object({
  query: z.string().min(1).describe('Question or topic to research'),
  systemInstruction: z.string().optional().describe('Custom instructions for result format'),
  urls: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('URLs to deeply analyze alongside search results (max 20). Enables URL Context.'),
  thinkingLevel: z.enum(THINKING_LEVELS).optional().describe('Thinking depth for reasoning.'),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const AgenticSearchInputSchema = z.object({
  topic: z.string().min(1).describe('Topic or question for deep multi-step research'),
  searchDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('Depth of search (1-5, default 3)'),
  thinkingLevel: z.enum(THINKING_LEVELS).optional().describe('Thinking depth for reasoning.'),
});
export type AgenticSearchInput = z.infer<typeof AgenticSearchInputSchema>;

export const AnalyzeFileInputSchema = z.object({
  filePath: z.string().trim().min(1).describe('Absolute path to the file'),
  question: z.string().min(1).describe('What to analyze or ask about the file'),
  thinkingLevel: z
    .enum(THINKING_LEVELS)
    .optional()
    .describe("Thinking depth for analysis. Use 'LOW' for fast, 'HIGH' for deep reasoning."),
});
export type AnalyzeFileInput = z.infer<typeof AnalyzeFileInputSchema>;

export const AnalyzeUrlInputSchema = z.object({
  urls: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe('URLs to analyze (max 20). Must be publicly accessible.'),
  question: z.string().min(1).describe('What to analyze or ask about the URL content'),
  systemInstruction: z.string().optional().describe('Custom system instruction for analysis'),
  thinkingLevel: z.enum(THINKING_LEVELS).optional().describe('Thinking depth for analysis.'),
});
export type AnalyzeUrlInput = z.infer<typeof AnalyzeUrlInputSchema>;

export const CreateCacheInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('Absolute paths to files to cache'),
    systemInstruction: z.string().optional().describe('System instruction to cache with the files'),
    ttl: z
      .string()
      .optional()
      .describe('Time-to-live for the cache (e.g., "3600s"). Defaults to 1 hour.'),
    displayName: z
      .string()
      .optional()
      .describe('Human-readable label. Existing cache with same displayName is auto-replaced.'),
  })
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- LHS is boolean; ?? would not fall through on `false`
  .refine((data) => (data.filePaths && data.filePaths.length > 0) || data.systemInstruction, {
    message: 'At least one of filePaths or systemInstruction must be provided.',
  })
  .describe(
    'Creates a Gemini API cache. Combined content (files + instructions) MUST exceed ~32,000 tokens.',
  );
export type CreateCacheInput = z.infer<typeof CreateCacheInputSchema>;
