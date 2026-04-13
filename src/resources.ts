import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import { ai } from './client.js';
import { getSessionEntry, listSessionEntries } from './sessions.js';

export function registerResources(server: McpServer): void {
  server.registerResource(
    'sessions',
    new ResourceTemplate('sessions://list', {
      list: () => ({
        resources: [
          {
            uri: 'sessions://list',
            name: 'List of active multi-turn chat session IDs',
          },
        ],
      }),
    }),
    {
      title: 'Active Chat Sessions',
      description: 'List of active multi-turn chat session IDs and their last access time.',
      mimeType: 'application/json',
    },
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(listSessionEntries()),
        },
      ],
    }),
  );

  server.registerResource(
    'session-detail',
    new ResourceTemplate('sessions://{sessionId}', {
      list: () => ({
        resources: listSessionEntries().map((s) => ({
          uri: `sessions://${s.id}`,
          name: `Session ${s.id}`,
        })),
      }),
    }),
    {
      title: 'Chat Session Detail',
      description: 'Metadata for a single chat session by ID.',
      mimeType: 'application/json',
    },
    (uri, { sessionId }): ReadResourceResult => {
      const id = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const entry = id ? getSessionEntry(id) : undefined;
      const text = entry ? JSON.stringify(entry) : JSON.stringify({ error: 'Session not found' });
      return { contents: [{ uri: uri.href, text }] };
    },
  );

  server.registerResource(
    'caches',
    new ResourceTemplate('caches://list', {
      list: () => ({
        resources: [
          {
            uri: 'caches://list',
            name: 'List of active Gemini context caches',
          },
        ],
      }),
    }),
    {
      title: 'Gemini Context Caches',
      description: 'List of active Gemini context caches with name, model, and expiry.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        const caches: Record<string, unknown>[] = [];
        const pager = await ai.caches.list();
        for await (const cached of pager) {
          caches.push({
            name: cached.name,
            displayName: cached.displayName,
            model: cached.model,
            expireTime: cached.expireTime,
          });
        }
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(caches),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: `Failed to list caches: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
        };
      }
    },
  );
}
