import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import { z } from 'zod/v4';

import {
  cleanupErrorLogger,
  reportCompletion,
  sendProgress,
  withErrorLogging,
  withRetry,
} from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { createResourceLink } from '../lib/response.js';
import { MUTABLE_ANNOTATIONS, READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import { type CreateCacheInput, CreateCacheInputSchema } from '../schemas/inputs.js';
import {
  CreateCacheOutputSchema,
  DeleteCacheOutputSchema,
  ListCachesOutputSchema,
  UpdateCacheOutputSchema,
} from '../schemas/outputs.js';

import {
  type CacheSummary,
  completeCacheNames,
  getAI,
  listCacheSummaries,
  MODEL,
} from '../client.js';

type CachePart = ReturnType<typeof createPartFromUri>;

const CACHE_UPLOAD_CHUNK_SIZE = 3;
const CACHE_NAME_DESCRIPTION = 'Cache resource name to %s (e.g., "cachedContents/...")';
const CREATE_CACHE_TOOL_LABEL = 'Create Cache';

export interface CacheChangeEvent {
  detailUris: string[];
}

let changeCallback: ((event: CacheChangeEvent) => void) | undefined;

export function onCacheChange(cb: (event: CacheChangeEvent) => void): void {
  changeCallback = cb;
}

function notifyCacheChange(cacheNames: string[] = []): void {
  changeCallback?.({
    detailUris: cacheNames.map((cacheName) => `caches://${encodeURIComponent(cacheName)}`),
  });
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

function createCacheNameSchema(action: 'delete' | 'update') {
  return completable(
    z.string().min(1).describe(CACHE_NAME_DESCRIPTION.replace('%s', action)),
    completeCacheNames,
  );
}

function cacheResourceLink(cacheName: string, displayName?: string) {
  return createResourceLink(
    `caches://${encodeURIComponent(cacheName)}`,
    displayName ?? `Cache ${truncateName(cacheName)}`,
  );
}

function cacheListResourceLink() {
  return createResourceLink('caches://list', 'Active Caches');
}

function cacheSummaryResourceLinks(caches: CacheSummary[]) {
  return caches
    .filter((cache): cache is CacheSummary & { name: string } => typeof cache.name === 'string')
    .map((cache) => cacheResourceLink(cache.name, cache.displayName ?? cache.name));
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
          `${toolLabel}: ${fileNameFromPath(filePath)} (${filesUploaded}/${filePaths.length})`,
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
    await Promise.allSettled(stale.map((c) => getAI().caches.delete({ name: c.name })));
  } catch {
    // Best-effort cleanup — failures are non-fatal
  }
}

type CacheDeletionConfirmation = 'confirmed' | 'declined' | 'unsupported';

async function confirmCacheDeletion(
  ctx: ServerContext,
  cacheName: string,
): Promise<CacheDeletionConfirmation> {
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

    return confirmation.action === 'accept' && confirmation.content?.confirm === true
      ? 'confirmed'
      : 'declined';
  } catch {
    void ctx.mcpReq.log('debug', `Elicitation not supported for cache deletion`);
    return 'unsupported';
  }
}

function buildCreateCacheConfig(
  parts: CachePart[],
  systemInstruction: string | undefined,
  displayName: string | undefined,
  ttl: string | undefined,
  signal: AbortSignal,
) {
  return {
    ...(parts.length > 0 ? { contents: [{ role: 'user' as const, parts }] } : {}),
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(displayName ? { displayName } : {}),
    ttl: ttl ?? '3600s',
    abortSignal: signal,
  };
}

async function createCacheWithRetry(
  parts: CachePart[],
  systemInstruction: string | undefined,
  ttl: string | undefined,
  displayName: string | undefined,
  ctx: ServerContext,
  totalSteps: number,
) {
  await sendProgress(ctx, totalSteps - 1, totalSteps, `${CREATE_CACHE_TOOL_LABEL}: Creating cache`);

  return await withRetry(
    () =>
      getAI().caches.create({
        model: MODEL,
        config: buildCreateCacheConfig(
          parts,
          systemInstruction,
          displayName,
          ttl,
          ctx.mcpReq.signal,
        ),
      }),
    {
      signal: ctx.mcpReq.signal,
      onRetry: (attempt, max, delayMs) => {
        void sendProgress(
          ctx,
          totalSteps - 1,
          totalSteps,
          `${CREATE_CACHE_TOOL_LABEL}: Retrying cache creation (${attempt}/${max}, ~${Math.round(delayMs / 1000)}s)`,
        );
      },
    },
  );
}

async function cleanupDuplicateCaches(
  displayName: string | undefined,
  cacheName: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (displayName && cacheName) {
    await cleanupOldCaches(displayName, cacheName, signal);
  }
}

function notifyCacheMutation(cacheName?: string): void {
  notifyCacheChange(cacheName ? [cacheName] : []);
}

function buildCreateCacheResult(cache: {
  name?: string;
  displayName?: string;
  model?: string;
  expireTime?: string;
}): CallToolResult {
  const cacheName = cache.name ?? 'N/A';
  const shortName = truncateName(cacheName);

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
      cacheResourceLink(cacheName, cache.displayName ?? cacheName),
      cacheListResourceLink(),
    ],
    structuredContent: {
      name: cacheName,
      ...(cache.displayName ? { displayName: cache.displayName } : {}),
      ...(cache.model ? { model: cache.model } : {}),
      ...(cache.expireTime ? { expireTime: cache.expireTime } : {}),
    },
  };
}

function buildCreateCacheWork(rootsFetcher: RootsFetcher) {
  return async function createCacheWork(
    { filePaths, systemInstruction, ttl, displayName }: CreateCacheInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const uploadedFileNames: string[] = [];
    try {
      const totalSteps = (filePaths?.length ?? 0) + 1;
      const parts = filePaths
        ? await uploadCacheParts(
            filePaths,
            ctx,
            CREATE_CACHE_TOOL_LABEL,
            totalSteps,
            uploadedFileNames,
            rootsFetcher,
          )
        : [];

      const cache = await createCacheWithRetry(
        parts,
        systemInstruction,
        ttl,
        displayName,
        ctx,
        totalSteps,
      );
      await cleanupDuplicateCaches(displayName, cache.name, ctx.mcpReq.signal);
      notifyCacheMutation(cache.name);
      await reportCompletion(
        ctx,
        CREATE_CACHE_TOOL_LABEL,
        `cached ${truncateName(cache.name ?? 'N/A')}`,
      );

      return buildCreateCacheResult(cache);
    } catch (err) {
      throw normalizeCreateCacheError(err);
    } finally {
      await deleteUploadedFiles(uploadedFileNames, cleanupErrorLogger(ctx));
    }
  };
}

function registerCreateCacheTool(server: McpServer, rootsFetcher: RootsFetcher): void {
  registerTaskTool(
    server,
    'create_cache',
    {
      title: CREATE_CACHE_TOOL_LABEL,
      description:
        'Create a Gemini context cache from files and/or a system instruction. ' +
        'Combined content MUST exceed ~32,000 tokens.',
      inputSchema: CreateCacheInputSchema,
      outputSchema: CreateCacheOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    buildCreateCacheWork(rootsFetcher),
  );
}

function registerListCachesTool(server: McpServer): void {
  server.registerTool(
    'list_caches',
    {
      title: 'List Caches',
      description: 'List all active Gemini context caches.',
      inputSchema: z.object({}),
      outputSchema: ListCachesOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    withErrorLogging('list_caches', 'List Caches', async (_args, ctx: ServerContext) => {
      const caches = await listCacheSummaries(ctx.mcpReq.signal);
      const cacheLinks = cacheSummaryResourceLinks(caches);
      return {
        content: [{ type: 'text', text: formatCacheListMarkdown(caches) }, ...cacheLinks],
        structuredContent: { caches, count: caches.length },
      };
    }),
  );
}

async function deleteCacheWork(
  { cacheName, confirm }: { cacheName: string; confirm?: boolean | undefined },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const confirmation = await confirmCacheDeletion(ctx, cacheName);
  if (confirmation === 'declined') {
    return {
      content: [{ type: 'text', text: 'Cache deletion cancelled.' }],
      structuredContent: { cacheName, deleted: false },
    };
  }

  if (confirmation === 'unsupported' && confirm !== true) {
    return {
      content: [
        {
          type: 'text',
          text: 'Interactive confirmation is unavailable. Re-run delete_cache with confirm=true to delete the cache.',
        },
      ],
      isError: true,
    };
  }

  await getAI().caches.delete({
    name: cacheName,
    config: { abortSignal: ctx.mcpReq.signal },
  });
  notifyCacheMutation(cacheName);
  await ctx.mcpReq.log('info', `Deleted cache: ${cacheName}`);
  return {
    content: [{ type: 'text', text: `Cache '${cacheName}' deleted.` }, cacheListResourceLink()],
    structuredContent: { cacheName, deleted: true },
  };
}

function registerDeleteCacheTool(server: McpServer): void {
  registerTaskTool(
    server,
    'delete_cache',
    {
      title: 'Delete Cache',
      description: 'Delete a Gemini context cache by resource name.',
      inputSchema: z.object({
        cacheName: createCacheNameSchema('delete'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required when the client cannot confirm deletion interactively.'),
      }),
      outputSchema: DeleteCacheOutputSchema,
      annotations: {
        ...MUTABLE_ANNOTATIONS,
        destructiveHint: true,
      },
    },
    deleteCacheWork,
  );
}

async function updateCacheWork(
  { cacheName, ttl }: { cacheName: string; ttl: string },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const updated = await getAI().caches.update({
    name: cacheName,
    config: { ttl, abortSignal: ctx.mcpReq.signal },
  });
  notifyCacheMutation(cacheName);
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
      cacheResourceLink(cacheName),
    ],
    structuredContent: {
      cacheName,
      ...(updated.expireTime ? { expireTime: updated.expireTime } : {}),
    },
  };
}

function registerUpdateCacheTool(server: McpServer): void {
  registerTaskTool(
    server,
    'update_cache',
    {
      title: 'Update Cache',
      description: 'Update the TTL of an existing Gemini context cache.',
      inputSchema: z.object({
        cacheName: createCacheNameSchema('update'),
        ttl: z.string().min(1).describe('New TTL from now (e.g., "7200s" for 2 hours)'),
      }),
      outputSchema: UpdateCacheOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    updateCacheWork,
  );
}

export function registerCacheTools(server: McpServer): void {
  const rootsFetcher = buildServerRootsFetcher(server);
  registerCreateCacheTool(server, rootsFetcher);
  registerListCachesTool(server);
  registerDeleteCacheTool(server);
  registerUpdateCacheTool(server);
}
