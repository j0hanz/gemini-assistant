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

function notifyCacheMutation(cacheName?: string): void {
  notifyCacheChange(cacheName ? [cacheName] : []);
}

function buildCreateCacheResult(
  cache: {
    name?: string;
    displayName?: string;
    model?: string;
    expireTime?: string;
  },
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
          `- **Display Name:** ${cache.displayName ?? 'N/A'}\n` +
          `- **Model:** ${cache.model ?? 'N/A'}\n` +
          `- **Expires:** ${cache.expireTime ?? 'N/A'}`,
      },
      cacheResourceLink(cacheName, cache.displayName ?? cacheName, taskId),
      cacheListResourceLink(taskId),
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

      return buildCreateCacheResult(cache, ctx.task?.id);
    } catch (err) {
      throw normalizeCreateCacheError(err);
    } finally {
      await deleteUploadedFiles(uploadedFileNames, cleanupErrorLogger(ctx));
    }
  };
}

async function deleteCacheWork(
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
  notifyCacheMutation(cacheName);
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
      cacheResourceLink(cacheName, undefined, ctx.task?.id),
    ],
    structuredContent: {
      cacheName,
      ...(updated.expireTime ? { expireTime: updated.expireTime } : {}),
    },
  };
}

function sessionUris(sessionId: string): string[] {
  return [
    sessionDetailUri(sessionId),
    sessionTranscriptUri(sessionId),
    sessionEventsUri(sessionId),
  ];
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
  return {
    content: [
      { type: 'text', text: `Session ${sessionId} is active.` },
      ...sessionUris(sessionId).map((uri, index) =>
        taskResourceLink(uri, ['Session', 'Transcript', 'Events'][index] ?? uri, taskId),
      ),
    ],
    structuredContent: {
      ...base,
      action,
      summary: `Session ${sessionId} is active.`,
      session,
      resourceUris: sessionUris(sessionId),
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
    const raw = err instanceof Error ? err.message : String(err);
    if (/not found|404/i.test(raw)) {
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

async function handleCachesCreate(
  createCacheWork: ReturnType<typeof buildCreateCacheWork>,
  base: Record<string, unknown>,
  args: MemoryInput & {
    action: 'caches.create';
  },
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
  args: MemoryInput & {
    action: 'caches.update';
    cacheName: string;
    ttl: string;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result = await updateCacheWork({ cacheName: args.cacheName, ttl: args.ttl }, ctx);
  if (result.isError) return result;
  const structured = result.structuredContent ?? {};
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

async function handleCachesDelete(
  base: Record<string, unknown>,
  args: MemoryInput & {
    action: 'caches.delete';
    cacheName: string;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result = await deleteCacheWork({ cacheName: args.cacheName, confirm: args.confirm }, ctx);
  if (result.isError) return result;
  const structured = result.structuredContent ?? {};
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
): CallToolResult {
  const workspaceCache = workspaceCacheManager.getCacheStatus();
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

function isMemoryAction<TAction extends MemoryInput['action']>(
  args: MemoryInput,
  action: TAction,
): args is MemoryInput & { action: TAction } {
  return args.action === action;
}

function hasSessionId(args: MemoryInput): args is MemoryInput & {
  sessionId: string;
} {
  return typeof args.sessionId === 'string';
}

function hasCacheName(args: MemoryInput): args is MemoryInput & {
  cacheName: string;
} {
  return typeof args.cacheName === 'string';
}

function hasTtl(args: MemoryInput): args is MemoryInput & {
  ttl: string;
} {
  return typeof args.ttl === 'string';
}

export async function memoryWork(
  sessionStore: SessionStore,
  rootsFetcher: RootsFetcher,
  createCacheWork: ReturnType<typeof buildCreateCacheWork>,
  args: MemoryInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const base = buildBaseStructuredOutput(ctx.task?.id);
  const taskId = ctx.task?.id;
  let result: CallToolResult;

  if (isMemoryAction(args, 'sessions.list')) {
    result = handleSessionsList(sessionStore, base, args.action, taskId);
  } else if (isMemoryAction(args, 'sessions.get') && hasSessionId(args)) {
    result = handleSessionsGet(sessionStore, base, args.action, args.sessionId, taskId);
  } else if (isMemoryAction(args, 'sessions.transcript') && hasSessionId(args)) {
    result = handleSessionsTranscript(sessionStore, base, args.action, args.sessionId, taskId);
  } else if (isMemoryAction(args, 'sessions.events') && hasSessionId(args)) {
    result = handleSessionsEvents(sessionStore, base, args.action, args.sessionId, taskId);
  } else if (isMemoryAction(args, 'caches.list')) {
    result = await handleCachesList(base, args.action, taskId, ctx.mcpReq.signal);
  } else if (isMemoryAction(args, 'caches.get') && hasCacheName(args)) {
    result = await handleCachesGet(base, args.action, args.cacheName, taskId, ctx.mcpReq.signal);
  } else if (isMemoryAction(args, 'caches.create')) {
    result = await handleCachesCreate(createCacheWork, base, args, ctx);
  } else if (isMemoryAction(args, 'caches.update') && hasCacheName(args) && hasTtl(args)) {
    result = await handleCachesUpdate(base, args, ctx);
  } else if (isMemoryAction(args, 'caches.delete') && hasCacheName(args)) {
    result = await handleCachesDelete(base, args, ctx);
  } else if (isMemoryAction(args, 'workspace.context')) {
    result = await handleWorkspaceContext(rootsFetcher, base, args.action, taskId);
  } else if (isMemoryAction(args, 'workspace.cache')) {
    result = handleWorkspaceCache(base, args.action, taskId);
  } else {
    throw new Error(`memory: Unhandled action '${args.action}'. Enum validation failed upstream.`);
  }

  return result;
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
      annotations: { ...MUTABLE_ANNOTATIONS, destructiveHint: true },
    },
    taskMessageQueue,
    (args: MemoryInput, ctx: ServerContext) =>
      memoryWork(sessionStore, rootsFetcher, createCacheWork, args, ctx),
  );
}
