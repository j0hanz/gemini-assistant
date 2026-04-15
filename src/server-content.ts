import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { completable, ResourceTemplate } from '@modelcontextprotocol/server';

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, sep } from 'node:path';

import { z } from 'zod/v4';

import { formatError } from './lib/errors.js';
import {
  buildServerRootsFetcher,
  getAllowedRoots,
  isPathWithinRoot,
  type RootsFetcher,
} from './lib/validation.js';

import { completeCacheNames, getCacheSummary, listCacheSummaries } from './client.js';
import { completeSessionIds, getSessionEntry, listSessionEntries } from './sessions.js';

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

interface ResourceListEntry {
  uri: string;
  name: string;
}

const SESSION_LIST_RESOURCE: ResourceListEntry = {
  uri: 'sessions://list',
  name: 'List of active multi-turn chat session IDs',
};

const CACHE_LIST_RESOURCE: ResourceListEntry = {
  uri: 'caches://list',
  name: 'List of active Gemini context caches',
};

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

function jsonResource(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        text: JSON.stringify(data),
      },
    ],
  };
}

function resourceList(resources: ResourceListEntry[]) {
  return {
    list: () => ({ resources }),
  };
}

function singleResource(resource: ResourceListEntry) {
  return resourceList([resource]);
}

function normalizeTemplateParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asyncJsonResource(
  load: () => Promise<unknown>,
  mapError: (err: unknown) => unknown,
): (uri: URL) => Promise<ReadResourceResult> {
  return async (uri) => {
    try {
      return jsonResource(uri.href, await load());
    } catch (err) {
      return jsonResource(uri.href, mapError(err));
    }
  };
}

const completeLanguage = completeByPrefix(COMMON_LANGUAGES, (value) => value?.toLowerCase() ?? '');
const completeSummaryStyle = completeByPrefix(SUMMARY_STYLES);

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

      const isAllowed = allowedRoots.some((root) => isPathWithinRoot(targetDir, root));

      if (!isAllowed) {
        return allowedRoots.filter((root) =>
          root.toLowerCase().startsWith(normalized.toLowerCase()),
        );
      }

      try {
        const entries = await readdir(targetDir, { withFileTypes: true });
        return entries
          .filter(
            (entry) =>
              !targetPrefix || entry.name.toLowerCase().startsWith(targetPrefix.toLowerCase()),
          )
          .map((entry) => join(targetDir, entry.name) + (entry.isDirectory() ? sep : ''))
          .slice(0, 50);
      } catch {
        return allowedRoots.filter((root) =>
          root.toLowerCase().startsWith(normalized.toLowerCase()),
        );
      }
    } catch {
      return [];
    }
  };
}

function sessionDetailResources(): ResourceListEntry[] {
  return listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}`,
    name: `Session ${session.id}`,
  }));
}

function cacheDetailResources(
  caches: Awaited<ReturnType<typeof listCacheSummaries>>,
): ResourceListEntry[] {
  return caches
    .filter((cache): cache is typeof cache & { name: string } => typeof cache.name === 'string')
    .map((cache) => ({
      uri: `caches://${encodeURIComponent(cache.name)}`,
      name: cache.displayName ?? cache.name,
    }));
}

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

export function registerResources(server: McpServer): void {
  server.registerResource(
    'sessions',
    new ResourceTemplate('sessions://list', singleResource(SESSION_LIST_RESOURCE)),
    {
      title: 'Active Chat Sessions',
      description: 'List of active multi-turn chat session IDs and their last access time.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => jsonResource(uri.href, listSessionEntries()),
  );

  server.registerResource(
    'session-detail',
    new ResourceTemplate('sessions://{sessionId}', {
      list: () => ({ resources: sessionDetailResources() }),
      complete: {
        sessionId: completeSessionIds,
      },
    }),
    {
      title: 'Chat Session Detail',
      description: 'Metadata for a single chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult => {
      const id = normalizeTemplateParam(sessionId);
      const entry = id ? getSessionEntry(id) : undefined;
      return jsonResource(uri.href, entry ?? { error: 'Session not found' });
    },
  );

  server.registerResource(
    'caches',
    new ResourceTemplate('caches://list', singleResource(CACHE_LIST_RESOURCE)),
    {
      title: 'Gemini Context Caches',
      description: 'List of active Gemini context caches with name, model, and expiry.',
      mimeType: 'application/json',
    },
    asyncJsonResource(
      () => listCacheSummaries(),
      (err) => ({
        error: `Failed to list caches: ${formatError(err)}`,
      }),
    ),
  );

  server.registerResource(
    'cache-detail',
    new ResourceTemplate('caches://{cacheName}', {
      list: async () => {
        try {
          return { resources: cacheDetailResources(await listCacheSummaries()) };
        } catch {
          return { resources: [] };
        }
      },
      complete: {
        cacheName: completeCacheNames,
      },
    }),
    {
      title: 'Cache Detail',
      description: 'Full detail for a single Gemini context cache including token count.',
      mimeType: 'application/json',
    },
    async (uri, { cacheName }) => {
      const name = normalizeTemplateParam(cacheName);
      if (!name) return jsonResource(uri.href, { error: 'Cache name required' });
      const decoded = decodeURIComponent(name);
      try {
        return jsonResource(uri.href, await getCacheSummary(decoded));
      } catch (err) {
        return jsonResource(uri.href, {
          error: `Failed to get cache: ${formatError(err)}`,
        });
      }
    },
  );
}
