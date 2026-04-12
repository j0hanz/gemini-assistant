import { z } from 'zod/v4';

export const AskInputSchema = z.object({
  message: z.string().describe('User message or prompt'),
  sessionId: z
    .string()
    .optional()
    .describe('Session ID for multi-turn chat. Omit for single-turn.'),
  systemInstruction: z
    .string()
    .optional()
    .describe('System prompt (used on session creation or single-turn)'),
});

export const ExecuteCodeInputSchema = z.object({
  task: z.string().describe('Description of the code task to perform'),
  language: z.string().optional().describe('Preferred language hint (Python is sandbox default)'),
});

export const SearchInputSchema = z.object({
  query: z.string().describe('Question or topic to research'),
  systemInstruction: z.string().optional().describe('Custom instructions for result presentation'),
});

export const AnalyzeFileInputSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to analyze'),
  question: z.string().describe('What to analyze or ask about the file'),
});
