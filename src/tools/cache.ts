import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import { z } from 'zod/v4';

import { reportCompletion, sendProgress } from '../lib/context.js';
import { cleanupErrorLogger, handleToolError, logAndReturnError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file-upload.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/path-validation.js';
import { withRetry } from '../lib/retry.js';
import {
  createToolTaskHandlers,
  MUTABLE_ANNOTATIONS,
  READONLY_ANNOTATIONS,
  TASK_EXECUTION,
} from '../lib/task-utils.js';
import { CreateCacheInputSchema } from '../schemas/inputs.js';

import { ai, type CacheSummary, completeCacheNames, listCacheSummaries, MODEL } from '../client.js';

type CachePart = ReturnType<typeof createPartFromUri>;

interface CreateCacheArgs {
  filePaths?: string[] | undefined;
  systemInstruction?: string | undefined;
  ttl?: string | undefined;
  displayName?: string | undefined;
}

const CACHE_UPLOAD_CHUNK_SIZE = 3;

let changeCallback: ((taskId?: string) => void) | undefined;

export function onCacheChange(cb: (taskId?: string) => void): void {
  changeCallback = cb;
}

function notifyCacheChange(taskId?: string): void {
  changeCallback?.(taskId);
}

function formatCacheListMarkdown(caches: CacheSummary[]): string {
  if (caches.length === 0) return 'No active caches found.';
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown): string => (typeof v === 'number' ? String(v) : 'N/A');
  return (
    `**Active Caches (${String(caches.length)})**\n\n` +
    caches
      .map(
        (c, i) =>
          `${String(i + 1)}. **${str(c.displayName, 'Untitled')}**\n` +
          `   - Name: \`${str(c.name, 'N/A')}\`\n` +
          `   - Model: ${str(c.model, 'N/A')}\n` +
          `   - Tokens: ${num(c.totalTokenCount)}\n` +
          `   - Expires: ${str(c.expireTime, 'N/A')}`,
      )
      .join('\n')
  );
}

function truncateName(name: string, maxLen = 10): string {
  return name.length > maxLen ? `${name.slice(0, maxLen)}…` : name;
}

function normalizeCreateCacheError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('too few tokens') || message.includes('minimum')) {
    return new Error(`content is below the ~32,000 token minimum. ${message}`);
  }
  return err;
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

async function uploadCacheParts(
  filePaths: readonly string[],
  ctx: ServerContext,
  toolLabel: string,
  totalSteps: number,
  uploadedFileNames: string[],
  rootsFetcher?: RootsFetcher,
): Promise<CachePart[]> {
  await ctx.mcpReq.log('info', `Caching ${filePaths.length}`);
  await sendProgress(ctx, 0, totalSteps, `${toolLabel}: Preparing ${filePaths.length}`);

  const parts: CachePart[] = [];
  let filesUploaded = 0;

  for (let i = 0; i < filePaths.length; i += CACHE_UPLOAD_CHUNK_SIZE) {
    if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const chunk = filePaths.slice(i, i + CACHE_UPLOAD_CHUNK_SIZE);
    const chunkParts = await Promise.all(
      chunk.map(async (filePath) => {
        const uploadedFile = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
        uploadedFileNames.push(uploadedFile.name);
        filesUploaded += 1;
        await sendProgress(
          ctx,
          filesUploaded,
          totalSteps,
          `${toolLabel}: Uploaded ${fileNameFromPath(filePath)} (${filesUploaded}/${filePaths.length})`,
        );
        return createPartFromUri(uploadedFile.uri, uploadedFile.mimeType);
      }),
    );

    parts.push(...chunkParts);
  }

  return parts;
}

async function cleanupOldCaches(
  displayName: string,
  keepName: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const existing = await listCacheSummaries(signal);
    const stale = existing.filter(
      (c): c is CacheSummary & { name: string } =>
        typeof c.name === 'string' && c.displayName === displayName && c.name !== keepName,
    );
    await Promise.allSettled(stale.map((c) => ai.caches.delete({ name: c.name })));
  } catch {
    // Best-effort cleanup — failures are non-fatal
  }
}

async function confirmCacheDeletion(ctx: ServerContext, cacheName: string): Promise<boolean> {
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

    return confirmation.action === 'accept' && confirmation.content?.confirm === true;
  } catch {
    // Client does not support elicitation — proceed without confirmation
    return true;
  }
}

function buildCreateCacheWork(rootsFetcher: RootsFetcher) {
  return async function createCacheWork(
    { filePaths, systemInstruction, ttl, displayName }: CreateCacheArgs,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const TOOL_LABEL = 'Create Cache';
    const uploadedFileNames: string[] = [];
    try {
      const totalSteps = (filePaths?.length ?? 0) + 1;
      const parts = filePaths
        ? await uploadCacheParts(
            filePaths,
            ctx,
            TOOL_LABEL,
            totalSteps,
            uploadedFileNames,
            rootsFetcher,
          )
        : [];

      await sendProgress(ctx, totalSteps - 1, totalSteps, `${TOOL_LABEL}: Creating cache`);
      const cache = await withRetry(
        () =>
          ai.caches.create({
            model: MODEL,
            config: {
              ...(parts.length > 0 ? { contents: [{ role: 'user' as const, parts }] } : {}),
              ...(systemInstruction ? { systemInstruction } : {}),
              ...(displayName ? { displayName } : {}),
              ttl: ttl ?? '3600s',
              abortSignal: ctx.mcpReq.signal,
            },
          }),
        { signal: ctx.mcpReq.signal },
      );

      // Replace older caches with the same displayName (create-then-cleanup)
      if (displayName && cache.name) {
        await cleanupOldCaches(displayName, cache.name, ctx.mcpReq.signal);
      }

      notifyCacheChange(ctx.task?.id);

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
      const normalizedError = normalizeCreateCacheError(err);
      return await handleToolError(ctx, 'create_cache', TOOL_LABEL, normalizedError);
    } finally {
      await deleteUploadedFiles(uploadedFileNames, cleanupErrorLogger(ctx));
    }
  };
}

export function registerCacheTools(server: McpServer): void {
  const rootsFetcher = buildServerRootsFetcher(server);

  server.experimental.tasks.registerToolTask(
    'create_cache',
    {
      title: 'Create Cache',
      description:
        'Create a Gemini context cache from files and/or a system instruction. ' +
        'Combined content MUST exceed ~32,000 tokens.',
      inputSchema: CreateCacheInputSchema,
      annotations: MUTABLE_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(buildCreateCacheWork(rootsFetcher)),
  );

  server.registerTool(
    'list_caches',
    {
      title: 'List Caches',
      description: 'List all active Gemini context caches.',
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
      description: 'Delete a Gemini context cache by resource name.',
      inputSchema: z.object({
        cacheName: completable(
          z.string().min(1).describe('Cache resource name to delete (e.g., "cachedContents/...")'),
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
        if (!(await confirmCacheDeletion(ctx, cacheName))) {
          return {
            content: [{ type: 'text', text: 'Cache deletion cancelled.' }],
          };
        }

        await ai.caches.delete({ name: cacheName });
        notifyCacheChange(ctx.task?.id);
        await ctx.mcpReq.log('info', `Deleted cache: ${cacheName}`);
        return {
          content: [{ type: 'text', text: `Cache '${cacheName}' deleted.` }],
        };
      } catch (err) {
        return await logAndReturnError(ctx, 'delete_cache', err);
      }
    },
  );

  server.registerTool(
    'update_cache',
    {
      title: 'Update Cache',
      description: 'Update the TTL of an existing Gemini context cache.',
      inputSchema: z.object({
        cacheName: completable(
          z.string().min(1).describe('Cache resource name to update (e.g., "cachedContents/...")'),
          completeCacheNames,
        ),
        ttl: z.string().min(1).describe('New TTL from now (e.g., "7200s" for 2 hours)'),
      }),
      annotations: MUTABLE_ANNOTATIONS,
    },
    async ({ cacheName, ttl }, ctx: ServerContext) => {
      try {
        const updated = await ai.caches.update({ name: cacheName, config: { ttl } });
        notifyCacheChange(ctx.task?.id);
        await ctx.mcpReq.log('info', `Updated cache TTL: ${cacheName}`);
        return {
          content: [
            {
              type: 'text',
              text:
                `**Cache Updated**\n\n` +
                `- **Name:** ${updated.name ?? cacheName}\n` +
                `- **Expires:** ${updated.expireTime ?? 'N/A'}`,
            },
          ],
        };
      } catch (err) {
        return await logAndReturnError(ctx, 'update_cache', err);
      }
    },
  );
}
