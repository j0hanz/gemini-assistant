import { z } from 'zod/v4';

export const ExecuteCodeOutputSchema = z.object({
  code: z.string().describe('Generated code'),
  output: z.string().describe('Execution output'),
  explanation: z.string().describe('Explanatory text from the model'),
});

export const SearchOutputSchema = z.object({
  answer: z.string().describe('Grounded answer text'),
  sources: z.array(z.string()).describe('Source URLs from Google Search'),
});
