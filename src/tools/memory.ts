import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { AppError, cleanupErrorLogger, withRetry } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { logger } from '../lib/logger.js';
import { ProgressReporter } from '../lib/progress.js';
import { sessionDetailUri, sessionEventsUri, sessionTranscriptUri } from '../lib/resource-uris.js';
import {
  buildBaseStructuredOutput,
  createResourceLink,
  withRelatedTaskMeta,
} from '../lib/response.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerTaskTool,
} from '../lib/task-utils.js';
import { buildServerRootsFetcher, getAllowedRoots, type RootsFetcher } from '../lib/validation.js';
import {
  assembleWorkspaceContext,
  workspaceCacheManager,
  type WorkspaceCacheManagerImpl,
} from '../lib/workspace-context.js';
import {
  type CreateCacheInput,
  createMemoryInputSchema,
  type DeleteCacheInput,
  DeleteCacheInputSchema,
  type MemoryInput,
  type UpdateCacheInput,
} from '../schemas/inputs.js';
import { DeleteCachePublicOutputSchema, MemoryOutputSchema } from '../schemas/outputs.js';

import { type CacheSummary, getAI, getCacheSummary, listCacheSummaries, MODEL } from '../client.js';
import type { SessionStore } from '../sessions.js';

type CachePart = ReturnType<typeof createPartFromUri>;

const CACHE_UPLOAD_CHUNK_SIZE = 3;
const CACHE_OWNERSHIP_PREFIX = 'gemini-assistant/';
const CREATE_CACHE_TOOL_LABEL = 'Create Cache';
const log = logger.child('memory');

export interface CacheChangeEvent {
  listChanged: boolean;
}

type CacheChangeSubscriber = (event: CacheChangeEvent) => void;

const cacheChangeSubscribers = new Set<CacheChangeSubscriber>();

export function subscribeCacheChange(cb: CacheChangeSubscriber): () => void {
  cacheChangeSubscribers.add(cb);
  return () => {
    cacheChangeSubscribers.delete(cb);
  };
}

function notifyCacheChange(listChanged: boolean): void {
  if (cacheChangeSubscribers.size === 0) return;
  const event: CacheChangeEvent = { listChanged };
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

function taskResourceLink(uri: string, name: string, taskId?: string, mimeType?: string) {
  return withRelatedTaskMeta(createResourceLink(uri, name, mimeType), taskId);
}

function cacheResourceLink(cacheName: string, displayName?: string, taskId?: string) {
  return taskResourceLink(
    `memory://caches/${encodeURIComponent(cacheName)}`,
    displayName ?? `Cache ${truncateName(cacheName)}`,
    taskId,
  );
}

function cacheListResourceLink(taskId?: string) {
  return taskResourceLink('memory://caches', 'Active Caches', taskId);
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
  const progress = new ProgressReporter(ctx, toolLabel);
  await progress.step(0, totalSteps, `Preparing ${filePaths.length}`);

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
        await progress.step(
          filesUploaded,
          totalSteps,
          `${fileNameFromPath(filePath)} (${filesUploaded}/${filePaths.length})`,
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
        typeof cache.displayName === 'string' &&
        cache.displayName.startsWith(CACHE_OWNERSHIP_PREFIX) &&
        cache.displayName.slice(CACHE_OWNERSHIP_PREFIX.length) === displayName &&
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
    ...(displayName ? { displayName: `${CACHE_OWNERSHIP_PREFIX}${displayName}` } : {}),
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
  const progress = new ProgressReporter(ctx, CREATE_CACHE_TOOL_LABEL);
  await progress.step(totalSteps - 1, totalSteps, 'Creating cache');

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
      onRetry: async (attempt, max, delayMs) => {
        await progress.send(
          totalSteps - 1,
          totalSteps,
          `Retrying cache creation (${attempt}/${max}, ~${Math.round(delayMs / 1000)}s)`,
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

function buildCreateCacheResult(
  cache: {
    name?: string;
    displayName?: string;
    model?: string;
    expireTime?: string;
  },
  publicDisplayName?: string,
  taskId?: string,
): CallToolResult {
  if (!cache.name) {
    throw new AppError('memory', 'memory: Gemini returned a cache with no resource name.');
  }
  const cacheName = cache.name;
  const shortName = truncateName(cacheName);

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `**Cache Created**\n\n` +
          `- **Name:** ${shortName} (\`${cacheName}\`)\n` +
          `- **Display Name:** ${publicDisplayName ?? cache.displayName ?? 'N/A'}\n` +
          `- **Model:** ${cache.model ?? 'N/A'}\n` +
          `- **Expires:** ${cache.expireTime ?? 'N/A'}`,
      },
      cacheResourceLink(cacheName, publicDisplayName ?? cache.displayName ?? cacheName, taskId),
      cacheListResourceLink(taskId),
    ],
    structuredContent: {
      name: cacheName,
      ...(publicDisplayName ? { displayName: publicDisplayName } : {}),
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
      notifyCacheChange(true);

      return buildCreateCacheResult(cache, displayName, ctx.task?.id);
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
        structuredContent: { cacheName, deleted: false, confirmationRequired: false },
      };
    }

    if (confirmation === 'unsupported') {
      return {
        content: [
          {
            type: 'text',
            text: 'Interactive confirmation is unavailable. Re-run memory action=caches.delete with confirm=true to delete the cache.',
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
  notifyCacheChange(true);
  await ctx.mcpReq.log('info', `Deleted cache: ${cacheName}`);
  return {
    content: [
      { type: 'text', text: `Cache '${cacheName}' deleted.` },
      cacheListResourceLink(ctx.task?.id),
    ],
    structuredContent: { cacheName, deleted: true },
  };
}

async function updateCacheWork(
  { cacheName, ttl }: UpdateCacheInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const updated = await getAI().caches.update({
    name: cacheName,
    config: { ttl, abortSignal: ctx.mcpReq.signal },
  });
  // TTL update does not change list membership; do not fire list_changed.
  notifyCacheChange(false);
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
      cacheResourceLink(cacheName, undefined, ctx.task?.id),
    ],
    structuredContent: {
      cacheName,
      ...(updated.expireTime ? { expireTime: updated.expireTime } : {}),
    },
  };
}

function handleSessionsList(
  sessionStore: SessionStore,
  base: Record<string, unknown>,
  action: string,
  taskId?: string,
): CallToolResult {
  const sessions = sessionStore.listSessionEntries();
  return {
    content: [
      { type: 'text', text: `Found ${String(sessions.length)} active session(s).` },
      taskResourceLink('memory://sessions', 'Chat Sessions', taskId),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Found ${String(sessions.length)} active session(s).`,
      sessions,
      resourceUris: ['memory://sessions'],
    },
  };
}

function handleSessionsGet(
  sessionStore: SessionStore,
  base: Record<string, unknown>,
  action: string,
  sessionId: string,
  taskId?: string,
): CallToolResult {
  const session = sessionStore.getSessionEntry(sessionId);
  if (!session) {
    return new AppError('memory', `memory: Session '${sessionId}' not found.`).toToolResult();
  }
  const sessionResources = [
    ['Session', sessionDetailUri(sessionId)],
    ['Transcript', sessionTranscriptUri(sessionId)],
    ['Events', sessionEventsUri(sessionId)],
  ] as const;
  return {
    content: [
      { type: 'text', text: `Session ${sessionId} is active.` },
      ...sessionResources.map(([label, uri]) => taskResourceLink(uri, label, taskId)),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Session ${sessionId} is active.`,
      session,
      resourceUris: sessionResources.map(([, uri]) => uri),
    },
  };
}

function handleSessionsTranscript(
  sessionStore: SessionStore,
  base: Record<string, unknown>,
  action: string,
  sessionId: string,
  taskId?: string,
): CallToolResult {
  const transcript = sessionStore.listSessionTranscriptEntries(sessionId);
  if (!transcript) {
    return new AppError('memory', `memory: Session '${sessionId}' not found.`).toToolResult();
  }
  return {
    content: [
      { type: 'text', text: `Transcript entries: ${String(transcript.length)}.` },
      taskResourceLink(sessionTranscriptUri(sessionId), `Transcript ${sessionId}`, taskId),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Transcript entries: ${String(transcript.length)}.`,
      transcript,
      resourceUris: [sessionTranscriptUri(sessionId)],
    },
  };
}

function handleSessionsEvents(
  sessionStore: SessionStore,
  base: Record<string, unknown>,
  action: string,
  sessionId: string,
  taskId?: string,
): CallToolResult {
  const events = sessionStore.listSessionEventEntries(sessionId);
  if (!events) {
    return new AppError('memory', `memory: Session '${sessionId}' not found.`).toToolResult();
  }
  return {
    content: [
      { type: 'text', text: `Event entries: ${String(events.length)}.` },
      taskResourceLink(sessionEventsUri(sessionId), `Events ${sessionId}`, taskId),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Event entries: ${String(events.length)}.`,
      events,
      resourceUris: [sessionEventsUri(sessionId)],
    },
  };
}

async function handleCachesList(
  base: Record<string, unknown>,
  action: string,
  taskId?: string,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const caches = await listCacheSummaries(signal);
  return {
    content: [
      { type: 'text', text: `Found ${String(caches.length)} active cache(s).` },
      taskResourceLink('memory://caches', 'Caches', taskId),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Found ${String(caches.length)} active cache(s).`,
      caches,
      resourceUris: ['memory://caches'],
    },
  };
}

async function handleCachesGet(
  base: Record<string, unknown>,
  action: string,
  cacheName: string,
  taskId?: string,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  let cache: CacheSummary;
  try {
    cache = await getCacheSummary(cacheName, signal);
  } catch (err) {
    if (isNotFoundCacheError(err)) {
      return new AppError('memory', `memory: Cache '${cacheName}' not found.`).toToolResult();
    }
    throw err;
  }
  return {
    content: [
      { type: 'text', text: `Cache ${cacheName} loaded.` },
      taskResourceLink(`memory://caches/${encodeURIComponent(cacheName)}`, cacheName, taskId),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Cache ${cacheName} loaded.`,
      cache,
      resourceUris: [`memory://caches/${encodeURIComponent(cacheName)}`],
    },
  };
}

function isNotFoundCacheError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const record = err as Record<string, unknown>;
  const status = record.status;
  if (status === 404 || status === '404') {
    return true;
  }

  const code = record.code;
  if (code === 404 || code === '404' || code === 'NOT_FOUND') {
    return true;
  }

  const raw = err instanceof Error ? err.message : AppError.formatMessage(err);
  return /not found|404/i.test(raw);
}

async function handleCachesCreate(
  createCacheWork: ReturnType<typeof buildCreateCacheWork>,
  base: Record<string, unknown>,
  args: Extract<MemoryInput, { action: 'caches.create' }>,
  ctx: ServerContext,
): Promise<CallToolResult> {
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
  const structured = result.structuredContent ?? {};
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

async function handleCachesUpdate(
  base: Record<string, unknown>,
  args: MemoryInput & { cacheName: string; ttl: string },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result = await updateCacheWork({ cacheName: args.cacheName, ttl: args.ttl }, ctx);
  if (result.isError) return result;
  const structured = result.structuredContent ?? {};
  const cacheEntry = {
    name: args.cacheName,
    ...(typeof structured.expireTime === 'string' ? { expireTime: structured.expireTime } : {}),
  };
  return {
    ...result,
    structuredContent: {
      ...base,
      action: args.action,
      summary: `Updated cache ${args.cacheName}.`,
      cache: cacheEntry,
      resourceUris: [`memory://caches/${encodeURIComponent(args.cacheName)}`],
    },
  };
}

async function handleWorkspaceContext(
  rootsFetcher: RootsFetcher,
  base: Record<string, unknown>,
  action: string,
  taskId?: string,
): Promise<CallToolResult> {
  const roots = await getAllowedRoots(rootsFetcher);
  const workspaceContext = await assembleWorkspaceContext(roots);
  return {
    content: [
      {
        type: 'text',
        text: `Workspace context assembled from ${String(workspaceContext.sources.length)} source(s).`,
      },
      taskResourceLink('memory://workspace/context', 'Workspace Context', taskId, 'text/markdown'),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Workspace context assembled from ${String(workspaceContext.sources.length)} source(s).`,
      workspaceContext,
      resourceUris: ['memory://workspace/context'],
    },
  };
}

function handleWorkspaceCache(
  base: Record<string, unknown>,
  action: string,
  taskId?: string,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
): CallToolResult {
  const workspaceCache = workspaceCacheManagerInstance.getCacheStatus();
  return {
    content: [
      { type: 'text', text: 'Workspace cache status loaded.' },
      taskResourceLink('memory://workspace/cache', 'Workspace Cache', taskId),
    ],
    structuredContent: {
      ...base,
      action,
      summary: 'Workspace cache status loaded.',
      workspaceCache,
      resourceUris: ['memory://workspace/cache'],
    },
  };
}

export async function memoryWork(
  sessionStore: SessionStore,
  rootsFetcher: RootsFetcher,
  createCacheWork: ReturnType<typeof buildCreateCacheWork>,
  args: MemoryInput,
  ctx: ServerContext,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
): Promise<CallToolResult> {
  const base = buildBaseStructuredOutput(ctx.task?.id);
  const taskId = ctx.task?.id;
  switch (args.action) {
    case 'sessions.list':
      return handleSessionsList(sessionStore, base, args.action, taskId);
    case 'sessions.get':
      return handleSessionsGet(sessionStore, base, args.action, args.sessionId, taskId);
    case 'sessions.transcript':
      return handleSessionsTranscript(sessionStore, base, args.action, args.sessionId, taskId);
    case 'sessions.events':
      return handleSessionsEvents(sessionStore, base, args.action, args.sessionId, taskId);
    case 'caches.list':
      return await handleCachesList(base, args.action, taskId, ctx.mcpReq.signal);
    case 'caches.get':
      return await handleCachesGet(base, args.action, args.cacheName, taskId, ctx.mcpReq.signal);
    case 'caches.create':
      return await handleCachesCreate(createCacheWork, base, args, ctx);
    case 'caches.update':
      return await handleCachesUpdate(base, args, ctx);
    case 'workspace.context':
      return await handleWorkspaceContext(rootsFetcher, base, args.action, taskId);
    case 'workspace.cache':
      return handleWorkspaceCache(base, args.action, taskId, workspaceCacheManagerInstance);
    default:
      throw new Error(`Unhandled action '${String((args as { action?: unknown }).action)}'`);
  }
}

export function registerMemoryTool(
  server: McpServer,
  sessionStore: SessionStore,
  taskMessageQueue: TaskMessageQueue,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
): void {
  const rootsFetcher = buildServerRootsFetcher(server);
  const createCacheWork = buildCreateCacheWork(rootsFetcher);

  registerTaskTool(
    server,
    'memory',
    {
      title: 'Memory',
      description:
        'Inspect and manage sessions, caches, and workspace memory state. Use the `delete_cache` tool to remove caches.',
      inputSchema: createMemoryInputSchema(sessionStore.completeSessionIds.bind(sessionStore)),
      outputSchema: MemoryOutputSchema,
      annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: MemoryInput, ctx: ServerContext) =>
      memoryWork(
        sessionStore,
        rootsFetcher,
        createCacheWork,
        args,
        ctx,
        workspaceCacheManagerInstance,
      ),
  );
}

export function registerDeleteCacheTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
): void {
  registerTaskTool(
    server,
    'delete_cache',
    {
      title: 'Delete Cache',
      description:
        'Delete a Gemini cache. Requires interactive confirmation or `confirm=true` for non-interactive clients.',
      inputSchema: DeleteCacheInputSchema,
      outputSchema: DeleteCachePublicOutputSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    taskMessageQueue,
    async (args: DeleteCacheInput, ctx: ServerContext): Promise<CallToolResult> => {
      const result = await deleteCacheWork(args, ctx);
      if (result.isError) return result;
      const base = buildBaseStructuredOutput(ctx.task?.id);
      const structured = (result.structuredContent ?? {}) as {
        deleted?: boolean;
        confirmationRequired?: boolean;
      };
      const summary =
        structured.deleted === true
          ? `Deleted cache ${args.cacheName}.`
          : structured.confirmationRequired === true
            ? `Deletion for ${args.cacheName} requires confirmation.`
            : `Did not delete cache ${args.cacheName}.`;
      return {
        ...result,
        structuredContent: {
          ...base,
          summary,
          cacheName: args.cacheName,
          ...(typeof structured.deleted === 'boolean' ? { deleted: structured.deleted } : {}),
          ...(typeof structured.confirmationRequired === 'boolean'
            ? { confirmationRequired: structured.confirmationRequired }
            : {}),
          resourceUris: ['memory://caches'],
        },
      };
    },
  );
}
