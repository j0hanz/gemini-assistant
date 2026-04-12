import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';

import { ai } from './client.js';
import { listSessionEntries } from './sessions.js';

export function registerResources(server: McpServer): void {
  server.registerResource(
    'sessions',
    'sessions://list',
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
    'caches',
    'cache://list',
    {
      title: 'Gemini Context Caches',
      description: 'List of active Gemini context caches with name, model, and expiry.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
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
    },
  );
}
