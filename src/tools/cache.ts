import type { McpServer } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';

import { createPartFromUri } from '@google/genai';

import { errorResult } from '../lib/errors.js';
import { getMimeType, MAX_FILE_SIZE } from '../lib/file-utils.js';
import { CreateCacheInputSchema, DeleteCacheInputSchema } from '../schemas/inputs.js';

import { ai, MODEL } from '../client.js';

export function registerCacheTools(server: McpServer): void {
  server.registerTool(
    'create_cache',
    {
      title: 'Create Cache',
      description:
        'Creates a Gemini context cache from files and/or a system instruction. ' +
        'The combined content MUST exceed ~32,000 tokens. Do not use for small contexts.',
      inputSchema: CreateCacheInputSchema,
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ filePaths, systemInstruction, ttl }) => {
      try {
        const parts: ReturnType<typeof createPartFromUri>[] = [];

        if (filePaths) {
          for (const filePath of filePaths) {
            const fileStat = await stat(filePath);
            if (fileStat.size > MAX_FILE_SIZE) {
              return errorResult(
                `File exceeds 20MB limit: ${filePath} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`,
              );
            }

            const mimeType = getMimeType(filePath);
            const uploaded = await ai.files.upload({
              file: filePath,
              config: { mimeType },
            });

            if (!uploaded.uri || !uploaded.mimeType) {
              return errorResult(`File upload succeeded but returned no URI: ${filePath}`);
            }

            parts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
          }
        }

        const cache = await ai.caches.create({
          model: MODEL,
          config: {
            contents: parts.length > 0 ? [{ role: 'user', parts }] : undefined,
            systemInstruction,
            ttl: ttl ?? '3600s',
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                name: cache.name,
                displayName: cache.displayName,
                model: cache.model,
                expireTime: cache.expireTime,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('too few tokens') || message.includes('minimum')) {
          return errorResult(
            `create_cache failed: content is below the ~32,000 token minimum. ${message}`,
          );
        }
        return errorResult(`create_cache failed: ${message}`);
      }
    },
  );

  server.registerTool(
    'list_caches',
    {
      title: 'List Caches',
      description: 'Lists all active Gemini context caches.',
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
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
          content: [{ type: 'text', text: JSON.stringify(caches, null, 2) }],
        };
      } catch (err) {
        return errorResult(
          `list_caches failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.registerTool(
    'delete_cache',
    {
      title: 'Delete Cache',
      description: 'Deletes a Gemini context cache by its resource name.',
      inputSchema: DeleteCacheInputSchema,
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ name }) => {
      try {
        await ai.caches.delete({ name });
        return {
          content: [{ type: 'text', text: `Cache '${name}' deleted.` }],
        };
      } catch (err) {
        return errorResult(
          `delete_cache failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
