import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import { z } from 'zod/v4';

import { reportCompletion, sendProgress } from '../lib/context.js';
import { handleToolError, logAndReturnError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file-upload.js';
import { withRetry } from '../lib/retry.js';
import {
  createToolTaskHandlers,
  MUTABLE_ANNOTATIONS,
  READONLY_ANNOTATIONS,
  TASK_EXECUTION,
} from '../lib/task-utils.js';
import { CreateCacheInputSchema } from '../schemas/inputs.js';

import { ai, type CacheSummary, completeCacheNames, listCacheSummaries, MODEL } from '../client.js';

function formatCacheListMarkdown(caches: CacheSummary[]): string {
  if (caches.length === 0) return 'No active caches found.';
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  return (
    `**Active Caches (${String(caches.length)})**\n\n` +
    caches
      .map(
        (c, i) =>
          `${String(i + 1)}. **${str(c.displayName, 'Untitled')}**\n` +
          `   - Name: \`${str(c.name, 'N/A')}\`\n` +
          `   - Model: ${str(c.model, 'N/A')}\n` +
          `   - Expires: ${str(c.expireTime, 'N/A')}`,
      )
      .join('\n')
  );
}

function truncateName(name: string, maxLen = 10): string {
  return name.length > maxLen ? `${name.slice(0, maxLen)}…` : name;
}

function toCreateCacheError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('too few tokens') || message.includes('minimum')) {
    return new Error(`content is below the ~32,000 token minimum. ${message}`);
  }
  return err;
}

async function createCacheWork(
  {
    filePaths,
    systemInstruction,
    ttl,
  }: {
    filePaths?: string[] | undefined;
    systemInstruction?: string | undefined;
    ttl?: string | undefined;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Create Cache';
  const uploadedFileNames: string[] = [];
  try {
    const parts: ReturnType<typeof createPartFromUri>[] = [];
    const totalSteps = (filePaths?.length ?? 0) + 1;

    if (filePaths) {
      await ctx.mcpReq.log('info', `Caching ${filePaths.length}`);

      // Process files in chunks to manage memory and provide progress updates
      const CHUNK_SIZE = 3;
      for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
        if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const chunk = filePaths.slice(i, i + CHUNK_SIZE);
        await sendProgress(
          ctx,
          i,
          totalSteps,
          `${TOOL_LABEL}: Uploading files ${i + 1}-${Math.min(i + chunk.length, filePaths.length)}/${filePaths.length}`,
        );

        const chunkPromises = chunk.map(async (fp: string) => {
          const uploaded = await uploadFile(fp, ctx.mcpReq.signal);
          uploadedFileNames.push(uploaded.name);
          return createPartFromUri(uploaded.uri, uploaded.mimeType);
        });

        const results = await Promise.all(chunkPromises);
        parts.push(...results);
      }
    }

    await sendProgress(ctx, totalSteps - 1, totalSteps, `${TOOL_LABEL}: Creating cache`);
    const cache = await withRetry(
      () =>
        ai.caches.create({
          model: MODEL,
          config: {
            ...(parts.length > 0 ? { contents: [{ role: 'user' as const, parts }] } : {}),
            ...(systemInstruction ? { systemInstruction } : {}),
            ttl: ttl ?? '3600s',
            abortSignal: ctx.mcpReq.signal,
          },
        }),
      { signal: ctx.mcpReq.signal },
    );

    const cacheName = cache.name ?? 'N/A';
    const shortName = truncateName(cacheName);
    await reportCompletion(ctx, TOOL_LABEL, `cached ${shortName}`);

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `**Cache Created**\n\n` +
            `- **Name:** ${shortName} (\`${cacheName}\`)\n` +
            `- **Display Name:** ${cache.displayName ?? 'N/A'}\n` +
            `- **Model:** ${cache.model ?? 'N/A'}\n` +
            `- **Expires:** ${cache.expireTime ?? 'N/A'}`,
        },
        {
          type: 'resource_link' as const,
          uri: 'caches://list',
          name: 'Active Caches',
          mimeType: 'application/json',
        },
      ],
    };
  } catch (err) {
    const normalizedError = toCreateCacheError(err);
    return await handleToolError(ctx, 'create_cache', TOOL_LABEL, normalizedError);
  } finally {
    await deleteUploadedFiles(uploadedFileNames);
  }
}

export function registerCacheTools(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'create_cache',
    {
      title: 'Create Cache',
      description:
        'Creates a Gemini context cache from files and/or a system instruction. ' +
        'The combined content MUST exceed ~32,000 tokens. Do not use for small contexts.',
      inputSchema: CreateCacheInputSchema,
      annotations: MUTABLE_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(createCacheWork),
  );

  server.registerTool(
    'list_caches',
    {
      title: 'List Caches',
      description: 'Lists all active Gemini context caches.',
      inputSchema: z.object({}),
      annotations: READONLY_ANNOTATIONS,
    },
    async (_args, ctx: ServerContext) => {
      try {
        const caches = await listCacheSummaries(ctx.mcpReq.signal);
        return {
          content: [{ type: 'text', text: formatCacheListMarkdown(caches) }],
        };
      } catch (err) {
        return await logAndReturnError(ctx, 'list_caches', err);
      }
    },
  );

  server.registerTool(
    'delete_cache',
    {
      title: 'Delete Cache',
      description: 'Deletes a Gemini context cache by its resource name.',
      inputSchema: z.object({
        cacheName: completable(
          z
            .string()
            .min(1)
            .describe('The cache resource name to delete (e.g., "cachedContents/...")'),
          completeCacheNames,
        ),
      }),
      annotations: {
        ...MUTABLE_ANNOTATIONS,
        destructiveHint: true,
      },
    },
    async ({ cacheName }, ctx: ServerContext) => {
      try {
        // Attempt user confirmation via elicitation (graceful fallback if unsupported)
        try {
          const confirmation = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Confirm deletion of cache '${cacheName}'?`,
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

        await ai.caches.delete({ name: cacheName });
        await ctx.mcpReq.log('info', `Deleted cache: ${cacheName}`);
        return {
          content: [{ type: 'text', text: `Cache '${cacheName}' deleted.` }],
        };
      } catch (err) {
        return await logAndReturnError(ctx, 'delete_cache', err);
      }
    },
  );
}
