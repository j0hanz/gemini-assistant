import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import { formatError } from './lib/errors.js';

import { listDiscoveryEntries, listWorkflowEntries } from './catalog.js';
import { completeCacheNames, getCacheSummary, listCacheSummaries } from './client.js';
import {
  completeSessionIds,
  getSessionEntry,
  listSessionEntries,
  listSessionTranscriptEntries,
} from './sessions.js';

export const PUBLIC_RESOURCE_URIS = [
  'sessions://list',
  'sessions://{sessionId}',
  'sessions://{sessionId}/transcript',
  'caches://list',
  'caches://{cacheName}',
  'tools://list',
  'workflows://list',
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

const SESSION_LIST_RESOURCE: ResourceListEntry = {
  uri: 'sessions://list',
  name: 'List of active multi-turn chat session IDs',
};

const CACHE_LIST_RESOURCE: ResourceListEntry = {
  uri: 'caches://list',
  name: 'List of active Gemini context caches',
};

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

function toResourceUri(uri: URL | string): string {
  return typeof uri === 'string' ? uri : uri.href;
}

function sessionDetailResources(): ResourceListEntry[] {
  return listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}`,
    name: `Session ${session.id}`,
  }));
}

function sessionTranscriptResources(): ResourceListEntry[] {
  return listSessionEntries().map((session) => ({
    uri: `sessions://${session.id}/transcript`,
    name: `Transcript ${session.id}`,
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
  sessionId: string | undefined,
): SessionTranscriptResourceData {
  if (!sessionId) {
    return { error: 'Session not found' } as const;
  }

  const transcript = listSessionTranscriptEntries(sessionId);
  return transcript ?? ({ error: 'Session not found' } as const);
}

export function readSessionTranscriptResource(
  uri: URL | string,
  sessionId: string | string[] | undefined,
): ReadResourceResult {
  return jsonResource(
    toResourceUri(uri),
    getSessionTranscriptResourceData(normalizeTemplateParam(sessionId)),
  );
}

function registerSessionResources(server: McpServer): void {
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
    'session-transcript',
    new ResourceTemplate('sessions://{sessionId}/transcript', {
      list: () => ({ resources: sessionTranscriptResources() }),
      complete: {
        sessionId: completeSessionIds,
      },
    }),
    {
      title: 'Chat Session Transcript',
      description: 'Transcript entries for a single active chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult => readSessionTranscriptResource(uri, sessionId),
  );
}

function registerCacheResources(server: McpServer): void {
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

function registerDiscoveryResources(server: McpServer): void {
  server.registerResource(
    'tools-list',
    new ResourceTemplate('tools://list', singleResource(TOOLS_LIST_RESOURCE)),
    {
      title: 'Discovery Catalog',
      description: 'Machine-readable catalog of public tools, prompts, and resources.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => readToolsListResource(uri),
  );

  server.registerResource(
    'workflows-list',
    new ResourceTemplate('workflows://list', singleResource(WORKFLOWS_LIST_RESOURCE)),
    {
      title: 'Workflow Catalog',
      description: 'Machine-readable catalog of guided workflows for gemini-assistant.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => readWorkflowsListResource(uri),
  );
}

export function registerResources(server: McpServer): void {
  registerSessionResources(server);
  registerCacheResources(server);
  registerDiscoveryResources(server);
}
