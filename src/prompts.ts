import type { McpServer } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

const COMMON_LANGUAGES = [
  'python',
  'typescript',
  'javascript',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'swift',
  'kotlin',
  'php',
  'sql',
  'shell',
];

const SUMMARY_STYLES = ['brief', 'detailed', 'bullet-points'] as const;

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'code-review',
    {
      title: 'Code Review',
      description: 'Review code for bugs, best practices, and potential improvements.',
      argsSchema: z.object({
        code: z.string().max(100_000).describe('The code to review'),
        language: completable(
          z.string().optional().describe('Programming language of the code'),
          (value) => COMMON_LANGUAGES.filter((l) => l.startsWith(value?.toLowerCase() ?? '')),
        ),
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
        text: z.string().max(100_000).describe('The text to summarize'),
        style: completable(z.enum(SUMMARY_STYLES).optional().describe('Summary style'), (value) =>
          SUMMARY_STYLES.filter((s) => s.startsWith(value ?? '')),
        ),
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
        error: z.string().max(100_000).describe('The error message or stack trace'),
        context: z
          .string()
          .max(10_000)
          .optional()
          .describe('Additional context about what was being done'),
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
