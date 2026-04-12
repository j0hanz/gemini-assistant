import type { McpServer } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';

import { createPartFromUri } from '@google/genai';
import { z } from 'zod/v4';

import { geminiErrorResult } from '../lib/errors.js';
import { getMimeType, MAX_FILE_SIZE } from '../lib/file-utils.js';
import { resolveAndValidatePath } from '../lib/path-validation.js';
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
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ filePaths, systemInstruction, ttl }) => {
      const uploadedFileNames: string[] = [];
      try {
        const parts: ReturnType<typeof createPartFromUri>[] = [];

        if (filePaths) {
          // Validate all paths first
          const validPaths = await Promise.all(filePaths.map(resolveAndValidatePath));

          // Upload files in parallel
          const uploadResults = await Promise.all(
            validPaths.map(async (validPath) => {
              const fileStat = await stat(validPath);
              if (fileStat.size > MAX_FILE_SIZE) {
                throw new Error(
                  `File exceeds 20MB limit: ${validPath} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`,
                );
              }

              const mimeType = getMimeType(validPath);
              const uploaded = await ai.files.upload({
                file: validPath,
                config: { mimeType },
              });

              if (uploaded.name) {
                uploadedFileNames.push(uploaded.name);
              }

              if (!uploaded.uri || !uploaded.mimeType) {
                throw new Error(`File upload succeeded but returned no URI: ${validPath}`);
              }

              return createPartFromUri(uploaded.uri, uploaded.mimeType);
            }),
          );

          parts.push(...uploadResults);
        }

        const cache = await ai.caches.create({
          model: MODEL,
          config: {
            ...(parts.length > 0 ? { contents: [{ role: 'user' as const, parts }] } : {}),
            ...(systemInstruction ? { systemInstruction } : {}),
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
          return geminiErrorResult(
            'create_cache',
            new Error(`content is below the ~32,000 token minimum. ${message}`),
          );
        }
        return geminiErrorResult('create_cache', err);
      } finally {
        // Clean up uploaded files — cache references them by URI, not by file ID
        await Promise.allSettled(uploadedFileNames.map((name) => ai.files.delete({ name })));
      }
    },
  );

  server.registerTool(
    'list_caches',
    {
      title: 'List Caches',
      description: 'Lists all active Gemini context caches.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        return geminiErrorResult('list_caches', err);
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
        idempotentHint: true,
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
        return geminiErrorResult('delete_cache', err);
      }
    },
  );
}
