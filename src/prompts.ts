import type { McpServer } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

const MAX_PROMPT_TEXT_LENGTH = 100_000;
const MAX_CONTEXT_TEXT_LENGTH = 10_000;

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

type SummaryStyle = (typeof SUMMARY_STYLES)[number];

function promptText(description: string) {
  return z.string().max(MAX_PROMPT_TEXT_LENGTH).describe(description);
}

function optionalPromptText(description: string) {
  return promptText(description).optional();
}

function contextText(description: string) {
  return z.string().max(MAX_CONTEXT_TEXT_LENGTH).optional().describe(description);
}

function completeByPrefix<T extends string>(
  values: readonly T[],
  transform: (value: string | undefined) => string = (value) => value ?? '',
): (value: string | undefined) => T[] {
  return (value) => {
    const prefix = transform(value);
    return values.filter((item) => item.startsWith(prefix));
  };
}

function userPromptMessage(text: string) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text,
        },
      },
    ],
  };
}

function fencedCodeBlock(code: string, language?: string): string {
  return `\`\`\`${language ?? ''}\n${code}\n\`\`\``;
}

function summarizeConstraint(style: SummaryStyle | undefined): string {
  switch (style) {
    case 'brief':
      return ' Maximum 3 sentences.';
    case 'bullet-points':
      return ' Use dash-prefixed bullets, one per key point.';
    default:
      return '';
  }
}

const completeLanguage = completeByPrefix(COMMON_LANGUAGES, (value) => value?.toLowerCase() ?? '');
const completeSummaryStyle = completeByPrefix(SUMMARY_STYLES);

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'code-review',
    {
      title: 'Code Review',
      description: 'Review code for bugs, best practices, and potential improvements.',
      argsSchema: z.object({
        code: promptText('The code to review'),
        language: completable(
          optionalPromptText('Programming language of the code'),
          completeLanguage,
        ),
      }),
    },
    ({ code, language }) =>
      userPromptMessage(
        `Review the following${language ? ` ${language}` : ''} code for bugs, best practices, and improvements:\n\n${fencedCodeBlock(code, language)}\n\nStructure findings as: 1) Bugs, 2) Best practices, 3) Improvements.\nDo not explain obvious syntax. Do not suggest complete rewrites unless critical.`,
      ),
  );

  server.registerPrompt(
    'summarize',
    {
      title: 'Summarize Text',
      description: 'Condense text into a concise summary.',
      argsSchema: z.object({
        text: promptText('The text to summarize'),
        style: completable(
          z.enum(SUMMARY_STYLES).optional().describe('Summary style'),
          completeSummaryStyle,
        ),
      }),
    },
    ({ text, style }) =>
      userPromptMessage(
        `Summarize the following text${style ? ` in ${style} style` : ''}:\n\n${text}\n\nProvide only the summary, no meta-commentary.${summarizeConstraint(style)}`,
      ),
  );

  server.registerPrompt(
    'explain-error',
    {
      title: 'Explain Error',
      description: 'Explain an error message and suggest fixes.',
      argsSchema: z.object({
        error: promptText('The error message or stack trace'),
        context: contextText('Additional context about what was being done'),
      }),
    },
    ({ error, context }) =>
      userPromptMessage(
        `Explain the following error and suggest how to fix it${context ? `. Context: ${context}` : ''}:\n\n${error}\n\nStructure response as: 1) Root cause, 2) Fix, 3) Prevention. Be concise.`,
      ),
  );
}
