import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { AppError, cleanupErrorLogger, sendProgress, withRetry } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { logger } from '../lib/logger.js';
import { buildBaseStructuredOutput, createResourceLink } from '../lib/response.js';
import { MUTABLE_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { buildServerRootsFetcher, getAllowedRoots, type RootsFetcher } from '../lib/validation.js';
import { assembleWorkspaceContext, workspaceCacheManager } from '../lib/workspace-context.js';
import {
  type CreateCacheInput,
  createMemoryInputSchema,
  type DeleteCacheInput,
  type MemoryInput,
  type UpdateCacheInput,
} from '../schemas/inputs.js';
import { MemoryOutputSchema } from '../schemas/outputs.js';

import { type CacheSummary, getAI, getCacheSummary, listCacheSummaries, MODEL } from '../client.js';
import type { SessionStore } from '../sessions.js';

type CachePart = ReturnType<typeof createPartFromUri>;

const CACHE_UPLOAD_CHUNK_SIZE = 3;
const CREATE_CACHE_TOOL_LABEL = 'Create Cache';
const log = logger.child('memory');

export interface CacheChangeEvent {
  detailUris: string[];
}

type CacheChangeSubscriber = (event: CacheChangeEvent) => void;

const cacheChangeSubscribers = new Set<CacheChangeSubscriber>();

export function subscribeCacheChange(cb: CacheChangeSubscriber): () => void {
  cacheChangeSubscribers.add(cb);
  return () => {
    cacheChangeSubscribers.delete(cb);
  };
}

function notifyCacheChange(cacheNames: string[] = []): void {
  if (cacheChangeSubscribers.size === 0) return;
  const event: CacheChangeEvent = {
    detailUris: cacheNames.map((cacheName) => `memory://caches/${encodeURIComponent(cacheName)}`),
  };
  for (const subscriber of cacheChangeSubscribers) {
    try {
      subscriber(event);
    } catch (err) {
      log.warn(`Cache change subscriber threw: ${String(err)}`);
    }
  }
}

function truncateName(name: string, maxLen = 10): string {
  return name.length > maxLen ? `${name.slice(0, maxLen)}…` : name;
}

function cacheResourceLink(cacheName: string, displayName?: string) {
  return createResourceLink(
    `memory://caches/${encodeURIComponent(cacheName)}`,
    displayName ?? `Cache ${truncateName(cacheName)}`,
  );
}

function cacheListResourceLink() {
  return createResourceLink('memory://caches', 'Active Caches');
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

  for (let index = 0; index < filePaths.length; index += CACHE_UPLOAD_CHUNK_SIZE) {
    if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const chunk = filePaths.slice(index, index + CACHE_UPLOAD_CHUNK_SIZE);
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
      (cache): cache is CacheSummary & { name: string } =>
        typeof cache.name === 'string' &&
        cache.displayName === displayName &&
        cache.name !== keepName,
    );
    await Promise.allSettled(stale.map((cache) => getAI().caches.delete({ name: cache.name })));
  } catch {
    // Best-effort cleanup — failures are non-fatal.
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
    void ctx.mcpReq.log('debug', 'Elicitation not supported for cache deletion');
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

export function buildCreateCacheWork(rootsFetcher: RootsFetcher) {
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

      return buildCreateCacheResult(cache);
    } catch (err) {
      throw normalizeCreateCacheError(err);
    } finally {
      await deleteUploadedFiles(uploadedFileNames, cleanupErrorLogger(ctx));
    }
  };
}

export async function deleteCacheWork(
  { cacheName, confirm }: DeleteCacheInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (confirm !== true) {
    const confirmation = await confirmCacheDeletion(ctx, cacheName);
    if (confirmation === 'declined') {
      return {
        content: [{ type: 'text', text: 'Cache deletion cancelled.' }],
        structuredContent: { cacheName, deleted: false },
      };
    }

    if (confirmation === 'unsupported') {
      return {
        content: [
          {
            type: 'text',
            text: 'Interactive confirmation is unavailable. Re-run delete_cache with confirm=true to delete the cache.',
          },
        ],
        structuredContent: {
          cacheName,
          deleted: false,
          confirmationRequired: true,
        },
      };
    }
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

export async function updateCacheWork(
  { cacheName, ttl }: UpdateCacheInput,
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

function sessionUris(sessionId: string): string[] {
  return [
    `memory://sessions/${sessionId}`,
    `memory://sessions/${sessionId}/transcript`,
    `memory://sessions/${sessionId}/events`,
  ];
}

async function memoryWork(
  sessionStore: SessionStore,
  rootsFetcher: RootsFetcher,
  createCacheWork: ReturnType<typeof buildCreateCacheWork>,
  args: MemoryInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const base = buildBaseStructuredOutput(ctx.task?.id);

  switch (args.action) {
    case 'sessions.list': {
      const sessions = sessionStore.listSessionEntries();
      return {
        content: [
          { type: 'text', text: `Found ${String(sessions.length)} active session(s).` },
          createResourceLink('memory://sessions', 'Chat Sessions'),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Found ${String(sessions.length)} active session(s).`,
          sessions,
          resourceUris: ['memory://sessions'],
        },
      };
    }

    case 'sessions.get': {
      const session = sessionStore.getSessionEntry(args.sessionId);
      if (!session) {
        return new AppError(
          'memory',
          `memory: Session '${args.sessionId}' not found.`,
        ).toToolResult();
      }
      return {
        content: [
          { type: 'text', text: `Session ${args.sessionId} is active.` },
          ...sessionUris(args.sessionId).map((uri, index) =>
            createResourceLink(uri, ['Session', 'Transcript', 'Events'][index] ?? uri),
          ),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Session ${args.sessionId} is active.`,
          session,
          resourceUris: sessionUris(args.sessionId),
        },
      };
    }

    case 'sessions.transcript': {
      const transcript = sessionStore.listSessionTranscriptEntries(args.sessionId);
      if (!transcript) {
        return new AppError(
          'memory',
          `memory: Session '${args.sessionId}' not found.`,
        ).toToolResult();
      }
      return {
        content: [
          { type: 'text', text: `Transcript entries: ${String(transcript.length)}.` },
          createResourceLink(
            `memory://sessions/${args.sessionId}/transcript`,
            `Transcript ${args.sessionId}`,
          ),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Transcript entries: ${String(transcript.length)}.`,
          transcript,
          resourceUris: [`memory://sessions/${args.sessionId}/transcript`],
        },
      };
    }

    case 'sessions.events': {
      const events = sessionStore.listSessionEventEntries(args.sessionId);
      if (!events) {
        return new AppError(
          'memory',
          `memory: Session '${args.sessionId}' not found.`,
        ).toToolResult();
      }
      return {
        content: [
          { type: 'text', text: `Event entries: ${String(events.length)}.` },
          createResourceLink(
            `memory://sessions/${args.sessionId}/events`,
            `Events ${args.sessionId}`,
          ),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Event entries: ${String(events.length)}.`,
          events,
          resourceUris: [`memory://sessions/${args.sessionId}/events`],
        },
      };
    }

    case 'caches.list': {
      const caches = await listCacheSummaries(ctx.mcpReq.signal);
      return {
        content: [
          { type: 'text', text: `Found ${String(caches.length)} active cache(s).` },
          createResourceLink('memory://caches', 'Caches'),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Found ${String(caches.length)} active cache(s).`,
          caches,
          resourceUris: ['memory://caches'],
        },
      };
    }

    case 'caches.get': {
      const cache = await getCacheSummary(args.cacheName, ctx.mcpReq.signal);
      return {
        content: [
          { type: 'text', text: `Cache ${args.cacheName} loaded.` },
          createResourceLink(
            `memory://caches/${encodeURIComponent(args.cacheName)}`,
            args.cacheName,
          ),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Cache ${args.cacheName} loaded.`,
          cache,
          resourceUris: [`memory://caches/${encodeURIComponent(args.cacheName)}`],
        },
      };
    }

    case 'caches.create': {
      const createArgs =
        args.systemInstruction !== undefined
          ? {
              displayName: args.displayName,
              filePaths: args.filePaths,
              systemInstruction: args.systemInstruction,
              ttl: args.ttl,
            }
          : {
              displayName: args.displayName,
              filePaths: args.filePaths ?? [],
              ttl: args.ttl,
            };
      const result = await createCacheWork(createArgs, ctx);
      if (result.isError) return result;
      const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
      const resourceUris =
        typeof structured.name === 'string'
          ? ['memory://caches', `memory://caches/${encodeURIComponent(structured.name)}`]
          : ['memory://caches'];
      return {
        ...result,
        structuredContent: {
          ...base,
          action: args.action,
          summary:
            typeof structured.name === 'string'
              ? `Created cache ${structured.name}.`
              : 'Created cache.',
          cache: structured,
          resourceUris,
        },
      };
    }

    case 'caches.update': {
      const result = await updateCacheWork({ cacheName: args.cacheName, ttl: args.ttl }, ctx);
      if (result.isError) return result;
      const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
      return {
        ...result,
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Updated cache ${args.cacheName}.`,
          cache: structured,
          resourceUris: [`memory://caches/${encodeURIComponent(args.cacheName)}`],
        },
      };
    }

    case 'caches.delete': {
      const result = await deleteCacheWork(
        { cacheName: args.cacheName, confirm: args.confirm },
        ctx,
      );
      if (result.isError) return result;
      const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
      return {
        ...result,
        structuredContent: {
          ...base,
          action: args.action,
          summary:
            structured.deleted === true
              ? `Deleted cache ${args.cacheName}.`
              : structured.confirmationRequired === true
                ? `Deletion for ${args.cacheName} requires confirmation.`
                : `Did not delete cache ${args.cacheName}.`,
          deleted: structured.deleted,
          confirmationRequired: structured.confirmationRequired,
          resourceUris: ['memory://caches'],
        },
      };
    }

    case 'workspace.context': {
      const roots = await getAllowedRoots(rootsFetcher);
      const workspaceContext = await assembleWorkspaceContext(roots);
      return {
        content: [
          {
            type: 'text',
            text: `Workspace context assembled from ${String(workspaceContext.sources.length)} source(s).`,
          },
          createResourceLink('memory://workspace/context', 'Workspace Context', 'text/markdown'),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: `Workspace context assembled from ${String(workspaceContext.sources.length)} source(s).`,
          workspaceContext,
          resourceUris: ['memory://workspace/context'],
        },
      };
    }

    case 'workspace.cache': {
      const workspaceCache = workspaceCacheManager.getCacheStatus();
      return {
        content: [
          { type: 'text', text: 'Workspace cache status loaded.' },
          createResourceLink('memory://workspace/cache', 'Workspace Cache'),
        ],
        structuredContent: {
          ...base,
          action: args.action,
          summary: 'Workspace cache status loaded.',
          workspaceCache,
          resourceUris: ['memory://workspace/cache'],
        },
      };
    }
  }

  return new AppError(
    'memory',
    `memory: Unsupported action ${(args as { action?: string }).action ?? ''}.`,
  ).toToolResult();
}

export function registerMemoryTool(
  server: McpServer,
  sessionStore: SessionStore,
  taskMessageQueue: TaskMessageQueue,
): void {
  const rootsFetcher = buildServerRootsFetcher(server);
  const createCacheWork = buildCreateCacheWork(rootsFetcher);

  registerTaskTool(
    server,
    'memory',
    {
      title: 'Memory',
      description: 'Inspect and manage sessions, caches, and workspace memory state.',
      inputSchema: createMemoryInputSchema(sessionStore.completeSessionIds.bind(sessionStore)),
      outputSchema: MemoryOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: MemoryInput, ctx: ServerContext) =>
      memoryWork(sessionStore, rootsFetcher, createCacheWork, args, ctx),
  );
}
