import type { McpServer } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';

import { z } from 'zod/v4';

import {
  buildServerRootsFetcher,
  getAllowedRoots,
  type RootsFetcher,
} from './lib/path-validation.js';

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

function buildPathAcFetcher(rootsFetcher: RootsFetcher) {
  return async (value: string | undefined): Promise<string[]> => {
    try {
      const allowedRoots = await getAllowedRoots(rootsFetcher);
      const rawValue = value ?? '';

      if (!rawValue) {
        return allowedRoots;
      }

      const normalized = normalize(rawValue);
      let targetDir = normalized;
      let targetPrefix = '';

      try {
        const stats = await stat(normalized);
        if (stats.isDirectory()) {
          targetDir = normalized;
        } else {
          targetDir = dirname(normalized);
          targetPrefix = basename(normalized);
        }
      } catch {
        targetDir = dirname(normalized);
        targetPrefix = basename(normalized);
      }

      const isAllowed = allowedRoots.some(
        (r) =>
          targetDir.toLowerCase().startsWith(r.toLowerCase()) ||
          r.toLowerCase().startsWith(targetDir.toLowerCase()),
      );

      if (!isAllowed) {
        return allowedRoots.filter((r) => r.toLowerCase().startsWith(normalized.toLowerCase()));
      }

      try {
        const entries = await readdir(targetDir, { withFileTypes: true });
        return entries
          .filter(
            (e) => !targetPrefix || e.name.toLowerCase().startsWith(targetPrefix.toLowerCase()),
          )
          .map((e) => join(targetDir, e.name) + (e.isDirectory() ? '\\' : ''))
          .slice(0, 50);
      } catch {
        return allowedRoots.filter((r) => r.toLowerCase().startsWith(normalized.toLowerCase()));
      }
    } catch {
      return [];
    }
  };
}

const completeSummaryStyle = completeByPrefix(SUMMARY_STYLES);

export function registerPrompts(server: McpServer): void {
  const rootsFetcher = buildServerRootsFetcher(server);

  server.registerPrompt(
    'analyze-file',
    {
      title: 'Analyze File',
      description: 'Analyze a specific file with a custom question.',
      argsSchema: z.object({
        filePath: completable(
          promptText('Absolute path to the file to analyze from workspace roots'),
          buildPathAcFetcher(rootsFetcher),
        ),
        question: promptText('Your question or analysis request about the file'),
      }),
    },
    ({ filePath, question }) =>
      userPromptMessage(
        `Please analyze this file: ${filePath}\n\nQuestion: ${question}\n\nRead the file context and answer the question.`,
      ),
  );

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
        `Review this${language ? ` ${language}` : ''} code.\n\n${fencedCodeBlock(code, language)}\n\nStructure: 1) Bugs 2) Best practices 3) Improvements. Focus on actionable findings only.`,
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
        `Summarize this text${style ? ` (${style})` : ''}:\n\n${text}\n\nReturn only the summary.${summarizeConstraint(style)}`,
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
        `Explain this error${context ? ` (context: ${context})` : ''}:\n\n${error}\n\nStructure: 1) Root cause 2) Fix 3) Prevention.`,
      ),
  );
}
