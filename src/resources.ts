import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import { formatError } from './lib/errors.js';

import { completeCacheNames, getCacheSummary, listCacheSummaries } from './client.js';
import { completeSessionIds, getSessionEntry, listSessionEntries } from './sessions.js';

interface ResourceListEntry {
  uri: string;
  name: string;
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

const SESSION_LIST_RESOURCE: ResourceListEntry = {
  uri: 'sessions://list',
  name: 'List of active multi-turn chat session IDs',
};

const CACHE_LIST_RESOURCE: ResourceListEntry = {
  uri: 'caches://list',
  name: 'List of active Gemini context caches',
};

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
