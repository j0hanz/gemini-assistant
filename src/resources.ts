import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import { formatError } from './lib/errors.js';
import { buildServerRootsFetcher, getAllowedRoots } from './lib/validation.js';
import { assembleWorkspaceContext, workspaceCacheManager } from './lib/workspace-context.js';

import { listDiscoveryEntries, listWorkflowEntries } from './catalog.js';
import { completeCacheNames, getCacheSummary, listCacheSummaries } from './client.js';
import { createSessionStore, type SessionStore } from './sessions.js';

export const PUBLIC_RESOURCE_URIS = [
  'sessions://list',
  'sessions://{sessionId}',
  'sessions://{sessionId}/transcript',
  'sessions://{sessionId}/events',
  'caches://list',
  'caches://{cacheName}',
  'tools://list',
  'workflows://list',
  'workspace://context',
  'workspace://cache',
] as const;

interface ResourceListEntry {
  uri: string;
  name: string;
}

type SessionTranscriptResourceData =
  | {
      role: 'user' | 'assistant';
      text: string;
      timestamp: number;
      taskId?: string;
    }[]
  | { error: 'Session not found' };

type SessionEventsResourceData =
  | ReturnType<SessionStore['listSessionEventEntries']>
  | { error: 'Session not found' };

const TOOLS_LIST_RESOURCE: ResourceListEntry = {
  uri: 'tools://list',
  name: 'Discovery catalog for tools, prompts, and resources',
};

const WORKFLOWS_LIST_RESOURCE: ResourceListEntry = {
  uri: 'workflows://list',
  name: 'Guided workflows for common gemini-assistant jobs',
};

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

function textResource(uri: string, text: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        text,
      },
    ],
  };
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

function toResourceUri(uri: URL | string): string {
  return typeof uri === 'string' ? uri : uri.href;
}

interface WorkspaceContextResourceData {
  content: string;
  estimatedTokens: number;
  sources: string[];
}

export function renderWorkspaceContextMarkdown({
  content,
  estimatedTokens,
  sources,
}: WorkspaceContextResourceData): string {
  const sections = [
    '# Workspace Context',
    '',
    `Estimated tokens: ${estimatedTokens}`,
    '',
    '## Sources',
    ...(sources.length > 0 ? sources.map((source) => `- ${source}`) : ['- None']),
    '',
    '## Content',
    '',
    content || '_No workspace context assembled._',
  ];

  return sections.join('\n');
}

export function readWorkspaceContextResource(
  uri: URL | string,
  data: WorkspaceContextResourceData,
): ReadResourceResult {
  return textResource(toResourceUri(uri), renderWorkspaceContextMarkdown(data));
}

function sessionDetailResources(sessionStore: SessionStore): ResourceListEntry[] {
  return sessionStore.listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}`,
    name: `Session ${session.id}`,
  }));
}

function sessionTranscriptResources(sessionStore: SessionStore): ResourceListEntry[] {
  return sessionStore.listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}/transcript`,
    name: `Transcript ${session.id}`,
  }));
}

function sessionEventResources(sessionStore: SessionStore): ResourceListEntry[] {
  return sessionStore.listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}/events`,
    name: `Events ${session.id}`,
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

export function readToolsListResource(
  uri: URL | string = TOOLS_LIST_RESOURCE.uri,
): ReadResourceResult {
  return jsonResource(toResourceUri(uri), listDiscoveryEntries());
}

export function readWorkflowsListResource(
  uri: URL | string = WORKFLOWS_LIST_RESOURCE.uri,
): ReadResourceResult {
  return jsonResource(toResourceUri(uri), listWorkflowEntries());
}

export function getSessionTranscriptResourceData(
  sessionStore: SessionStore,
  sessionId: string | undefined,
): SessionTranscriptResourceData {
  if (!sessionId) {
    return { error: 'Session not found' } as const;
  }

  const transcript = sessionStore.listSessionTranscriptEntries(sessionId);
  return transcript ?? ({ error: 'Session not found' } as const);
}

export function getSessionEventsResourceData(
  sessionStore: SessionStore,
  sessionId: string | undefined,
): SessionEventsResourceData {
  if (!sessionId) {
    return { error: 'Session not found' } as const;
  }

  const events = sessionStore.listSessionEventEntries(sessionId);
  return events ?? ({ error: 'Session not found' } as const);
}

export function readSessionTranscriptResource(
  sessionStore: SessionStore,
  uri: URL | string,
  sessionId: string | string[] | undefined,
): ReadResourceResult {
  return jsonResource(
    toResourceUri(uri),
    getSessionTranscriptResourceData(sessionStore, normalizeTemplateParam(sessionId)),
  );
}

export function readSessionEventsResource(
  sessionStore: SessionStore,
  uri: URL | string,
  sessionId: string | string[] | undefined,
): ReadResourceResult {
  return jsonResource(
    toResourceUri(uri),
    getSessionEventsResourceData(sessionStore, normalizeTemplateParam(sessionId)),
  );
}

function registerSessionResources(server: McpServer, sessionStore: SessionStore): void {
  server.registerResource(
    'sessions',
    'sessions://list',
    {
      title: 'Active Chat Sessions',
      description: 'List of active multi-turn chat session IDs and their last access time.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => jsonResource(uri.href, sessionStore.listSessionEntries()),
  );

  server.registerResource(
    'session-detail',
    new ResourceTemplate('sessions://{sessionId}', {
      list: () => ({ resources: sessionDetailResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Detail',
      description: 'Metadata for a single chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult => {
      const id = normalizeTemplateParam(sessionId);
      const entry = id ? sessionStore.getSessionEntry(id) : undefined;
      return jsonResource(uri.href, entry ?? { error: 'Session not found' });
    },
  );

  server.registerResource(
    'session-transcript',
    new ResourceTemplate('sessions://{sessionId}/transcript', {
      list: () => ({ resources: sessionTranscriptResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Transcript',
      description: 'Transcript entries for a single active chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult =>
      readSessionTranscriptResource(sessionStore, uri, sessionId),
  );

  server.registerResource(
    'session-events',
    new ResourceTemplate('sessions://{sessionId}/events', {
      list: () => ({ resources: sessionEventResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Events',
      description:
        'Structured Gemini tool and function inspection summary for a single active chat session. ' +
        'This is a normalized view, not a raw replay-ready Gemini history. Large payloads may be truncated.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult =>
      readSessionEventsResource(sessionStore, uri, sessionId),
  );
}

function registerCacheResources(server: McpServer): void {
  server.registerResource(
    'caches',
    'caches://list',
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

function registerDiscoveryResources(server: McpServer): void {
  server.registerResource(
    'tools-list',
    'tools://list',
    {
      title: 'Discovery Catalog',
      description: 'Machine-readable catalog of public tools, prompts, and resources.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => readToolsListResource(uri),
  );

  server.registerResource(
    'workflows-list',
    'workflows://list',
    {
      title: 'Workflow Catalog',
      description: 'Machine-readable catalog of guided workflows for gemini-assistant.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => readWorkflowsListResource(uri),
  );
}

function registerWorkspaceResources(server: McpServer): void {
  server.registerResource(
    'workspace-context',
    'workspace://context',
    {
      title: 'Workspace Context',
      description: 'Assembled project context from workspace files for Gemini.',
      mimeType: 'text/markdown',
      annotations: {
        audience: ['assistant'],
        priority: 1.0,
      },
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        const roots = await getAllowedRoots(buildServerRootsFetcher(server));
        const ctx = await assembleWorkspaceContext(roots);
        return readWorkspaceContextResource(uri, {
          content: ctx.content,
          sources: ctx.sources,
          estimatedTokens: ctx.estimatedTokens,
        });
      } catch (err) {
        return textResource(uri.href, `# Workspace Context Error\n\n${formatError(err)}`);
      }
    },
  );

  server.registerResource(
    'workspace-cache',
    'workspace://cache',
    {
      title: 'Workspace Cache Status',
      description: 'Current status of the Gemini workspace context cache.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.5,
      },
    },
    (uri): ReadResourceResult => jsonResource(uri.href, workspaceCacheManager.getCacheStatus()),
  );
}

export function registerResources(
  server: McpServer,
  sessionStore: SessionStore = createSessionStore(),
): void {
  registerSessionResources(server, sessionStore);
  registerCacheResources(server);
  registerDiscoveryResources(server);
  registerWorkspaceResources(server);
}
