import type { McpServer } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'code-review',
    {
      title: 'Code Review',
      description: 'Review code for bugs, best practices, and potential improvements.',
      argsSchema: z.object({
        code: z.string().describe('The code to review'),
        language: z.string().optional().describe('Programming language of the code'),
      }),
    },
    ({ code, language }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review the following${language ? ` ${language}` : ''} code for bugs, best practices, and improvements:\n\n\`\`\`${language ?? ''}\n${code}\n\`\`\``,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'summarize',
    {
      title: 'Summarize Text',
      description: 'Condense text into a concise summary.',
      argsSchema: z.object({
        text: z.string().describe('The text to summarize'),
        style: z.enum(['brief', 'detailed', 'bullet-points']).optional().describe('Summary style'),
      }),
    },
    ({ text, style }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Summarize the following text${style ? ` in ${style} style` : ''}:\n\n${text}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'explain-error',
    {
      title: 'Explain Error',
      description: 'Explain an error message and suggest fixes.',
      argsSchema: z.object({
        error: z.string().describe('The error message or stack trace'),
        context: z.string().optional().describe('Additional context about what was being done'),
      }),
    },
    ({ error, context }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Explain the following error and suggest how to fix it${context ? `. Context: ${context}` : ''}:\n\n${error}`,
          },
        },
      ],
    }),
  );
}
