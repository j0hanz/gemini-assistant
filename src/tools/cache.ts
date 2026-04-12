import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import { z } from 'zod/v4';

import { extractToolContext } from '../lib/context.js';
import { geminiErrorResult } from '../lib/errors.js';
import { uploadFile } from '../lib/file-upload.js';
import { withRetry } from '../lib/retry.js';
import { CreateCacheInputSchema } from '../schemas/inputs.js';

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
    async ({ filePaths, systemInstruction, ttl }, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      const uploadedFileNames: string[] = [];
      try {
        const parts: ReturnType<typeof createPartFromUri>[] = [];
        const totalSteps = (filePaths?.length ?? 0) + 1;

        if (filePaths) {
          await tc.log('info', `Caching ${filePaths.length} file(s)`);

          // Process files in chunks to manage memory and provide progress updates
          const CHUNK_SIZE = 3;
          for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
            if (tc.signal.aborted) throw new DOMException('Aborted', 'AbortError');

            const chunk = filePaths.slice(i, i + CHUNK_SIZE);
            await tc.reportProgress(
              i,
              totalSteps,
              `Uploading files ${i + 1}-${Math.min(i + chunk.length, filePaths.length)}/${filePaths.length}`,
            );

            const chunkPromises = chunk.map(async (fp: string) => {
              const uploaded = await uploadFile(fp, tc.signal);
              uploadedFileNames.push(uploaded.name);
              return createPartFromUri(uploaded.uri, uploaded.mimeType);
            });

            const results = await Promise.all(chunkPromises);
            for (const result of results) {
              parts.push(result);
            }
          }
        }

        await tc.reportProgress(totalSteps - 1, totalSteps, 'Creating cache');
        const cache = await withRetry(
          () =>
            ai.caches.create({
              model: MODEL,
              config: {
                ...(parts.length > 0 ? { contents: [{ role: 'user' as const, parts }] } : {}),
                ...(systemInstruction ? { systemInstruction } : {}),
                ttl: ttl ?? '3600s',
                abortSignal: tc.signal,
              },
            }),
          { signal: tc.signal },
        );

        await tc.reportProgress(totalSteps, totalSteps, 'Complete');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                name: cache.name,
                displayName: cache.displayName,
                model: cache.model,
                expireTime: cache.expireTime,
              }),
            },
            {
              type: 'resource_link' as const,
              uri: 'cache://list',
              name: 'Active Caches',
              mimeType: 'application/json',
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await tc.log('error', `create_cache failed: ${message}`);
        if (message.includes('too few tokens') || message.includes('minimum')) {
          return geminiErrorResult(
            'create_cache',
            new Error(`content is below the ~32,000 token minimum. ${message}`),
          );
        }
        return geminiErrorResult('create_cache', err);
      } finally {
        // Clean up uploaded files — cache references them by URI, not by file ID
        const cleanups = await Promise.allSettled(
          uploadedFileNames.map((name) => ai.files.delete({ name })),
        );
        for (const c of cleanups) {
          if (c.status === 'rejected') {
            await tc.log(
              'warning',
              `create_cache: file cleanup failed: ${c.reason instanceof Error ? c.reason.message : String(c.reason)}`,
            );
          }
        }
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
    async (_args, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      try {
        const caches: Record<string, unknown>[] = [];
        const pager = await ai.caches.list();
        for await (const cached of pager) {
          if (tc.signal.aborted) break;
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
        await tc.log(
          'error',
          `list_caches failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return geminiErrorResult('list_caches', err);
      }
    },
  );

  server.registerTool(
    'delete_cache',
    {
      title: 'Delete Cache',
      description: 'Deletes a Gemini context cache by its resource name.',
      inputSchema: z.object({
        name: completable(
          z
            .string()
            .min(1)
            .describe('The cache resource name to delete (e.g., "cachedContents/...")'),
          async (value) => {
            const names: string[] = [];
            try {
              const pager = await ai.caches.list();
              for await (const cached of pager) {
                if (cached.name?.startsWith(value)) names.push(cached.name);
              }
            } catch {
              // Cache listing may fail — return empty completions
            }
            return names;
          },
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name }, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      try {
        // Attempt user confirmation via elicitation (graceful fallback if unsupported)
        try {
          const confirmation = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Confirm deletion of cache '${name}'?`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: { type: 'boolean', title: 'Confirm deletion' },
              },
              required: ['confirm'],
            },
          });
          if (confirmation.action !== 'accept' || !confirmation.content?.confirm) {
            return {
              content: [{ type: 'text', text: 'Cache deletion cancelled.' }],
            };
          }
        } catch {
          // Client does not support elicitation — proceed without confirmation
        }

        await ai.caches.delete({ name });
        await tc.log('info', `Deleted cache: ${name}`);
        return {
          content: [{ type: 'text', text: `Cache '${name}' deleted.` }],
        };
      } catch (err) {
        await tc.log(
          'error',
          `delete_cache failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return geminiErrorResult('delete_cache', err);
      }
    },
  );
}
