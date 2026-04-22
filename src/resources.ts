import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode, ResourceTemplate } from '@modelcontextprotocol/server';

import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import {
  cacheDetailUri,
  DISCOVER_CATALOG_URI,
  DISCOVER_CONTEXT_URI,
  DISCOVER_WORKFLOWS_URI,
  MEMORY_CACHES_URI,
  MEMORY_WORKSPACE_CACHE_URI,
  MEMORY_WORKSPACE_CONTEXT_URI,
  sessionDetailUri,
  sessionEventsUri,
  sessionTranscriptUri,
} from './lib/resource-uris.js';
import { buildServerRootsFetcher, getAllowedRoots, type RootsFetcher } from './lib/validation.js';
import {
  assembleWorkspaceContext,
  summarizeRootForDashboard,
  workspaceCacheManager,
} from './lib/workspace-context.js';

import {
  listDiscoveryEntries,
  listWorkflowEntries,
  renderDiscoveryCatalogMarkdown,
  renderWorkflowCatalogMarkdown,
} from './catalog.js';
import { completeCacheNames, getCacheSummary, listCacheSummaries } from './client.js';
import {
  getExposeThoughts,
  getGeminiModel,
  getSessionLimits,
  getWorkspaceAutoScan,
  getWorkspaceCacheEnabled,
  getWorkspaceCacheTtl,
} from './config.js';
import type { SessionStore } from './sessions.js';

export { PUBLIC_RESOURCE_URIS } from './public-contract.js';

interface ResourceListEntry {
  uri: string;
  name: string;
}

type SessionResourceUriBuilder = (sessionId: string) => string;

type SessionTranscriptResourceData = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  taskId?: string;
}[];

type SessionEventsResourceData = NonNullable<ReturnType<SessionStore['listSessionEventEntries']>>;

const DISCOVER_CATALOG_RESOURCE: ResourceListEntry = {
  uri: DISCOVER_CATALOG_URI,
  name: 'Discovery catalog for tools, prompts, and resources',
};

const DISCOVER_WORKFLOWS_RESOURCE: ResourceListEntry = {
  uri: DISCOVER_WORKFLOWS_URI,
  name: 'Guided workflows for common gemini-assistant jobs',
};

const DISCOVER_CONTEXT_RESOURCE: ResourceListEntry = {
  uri: DISCOVER_CONTEXT_URI,
  name: 'Server context dashboard showing workspace, sessions, caches, and config',
};

function jsonResource(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data),
      },
    ],
  };
}

function dualContentResource(uri: string, data: unknown, markdown: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data),
      },
      {
        uri,
        mimeType: 'text/markdown',
        text: markdown,
      },
    ],
  };
}

function textResource(uri: string, text: string, mimeType = 'text/plain'): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType,
        text,
      },
    ],
  };
}

function normalizeTemplateParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodeTemplateParam(value: string | string[] | undefined): string | undefined {
  const normalized = normalizeTemplateParam(value);
  if (!normalized) {
    return normalized;
  }

  try {
    return decodeURIComponent(normalized);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Invalid percent-encoding in resource URI parameter',
    );
  }
}

function requireTemplateParam(value: string | string[] | undefined, label: string): string {
  const decoded = decodeTemplateParam(value);
  if (!decoded) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${label} required`);
  }
  return decoded;
}

function toResourceUri(uri: URL | string): string {
  return typeof uri === 'string' ? uri : uri.href;
}

interface WorkspaceContextResourceData {
  content: string;
  estimatedTokens: number;
  sources: string[];
}

export function renderWorkspaceContextMarkdown({
  content,
  estimatedTokens,
  sources,
}: WorkspaceContextResourceData): string {
  const sections = [
    '# Workspace Context',
    '',
    `Estimated tokens: ${estimatedTokens}`,
    '',
    '## Sources',
    ...(sources.length > 0 ? sources.map((source) => `- ${source}`) : ['- None']),
    '',
    '## Content',
    '',
    content || '_No workspace context assembled._',
  ];

  return sections.join('\n');
}

export function readWorkspaceContextResource(
  uri: URL | string,
  data: WorkspaceContextResourceData,
): ReadResourceResult {
  return textResource(toResourceUri(uri), renderWorkspaceContextMarkdown(data), 'text/markdown');
}

function buildSessionResourceEntries(
  sessionStore: SessionStore,
  uriFor: SessionResourceUriBuilder,
  labelFor: (sessionId: string) => string,
): ResourceListEntry[] {
  return sessionStore.listSessionEntries().map((session) => ({
    uri: uriFor(session.id),
    name: labelFor(session.id),
  }));
}

function sessionDetailResources(sessionStore: SessionStore): ResourceListEntry[] {
  return buildSessionResourceEntries(
    sessionStore,
    sessionDetailUri,
    (sessionId) => `Session ${sessionId}`,
  );
}

function sessionTranscriptResources(sessionStore: SessionStore): ResourceListEntry[] {
  return buildSessionResourceEntries(
    sessionStore,
    sessionTranscriptUri,
    (sessionId) => `Transcript ${sessionId}`,
  );
}

function sessionEventResources(sessionStore: SessionStore): ResourceListEntry[] {
  return buildSessionResourceEntries(
    sessionStore,
    sessionEventsUri,
    (sessionId) => `Events ${sessionId}`,
  );
}

function cacheDetailResources(
  caches: Awaited<ReturnType<typeof listCacheSummaries>>,
): ResourceListEntry[] {
  return caches
    .filter((cache): cache is typeof cache & { name: string } => typeof cache.name === 'string')
    .map((cache) => ({
      uri: cacheDetailUri(cache.name),
      name: cache.displayName ?? cache.name,
    }));
}

export async function readCacheDetailResource(
  uri: URL | string,
  cacheName: string | string[] | undefined,
  getCacheSummaryImpl: (
    name: string,
  ) => Promise<Awaited<ReturnType<typeof getCacheSummary>> | null | undefined> = getCacheSummary,
): Promise<ReadResourceResult> {
  const log = logger.child('resources');
  const decoded = requireTemplateParam(cacheName, 'Cache name');

  try {
    const summary = await getCacheSummaryImpl(decoded);
    if (!summary) {
      throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Cache '${decoded}' not found`);
    }

    return jsonResource(toResourceUri(uri), summary);
  } catch (err) {
    if (err instanceof ProtocolError) {
      throw err;
    }

    log.error(`Failed to get cache '${decoded}': ${AppError.formatMessage(err)}`);
    throw new ProtocolError(ProtocolErrorCode.InternalError, `Failed to read cache '${decoded}'`);
  }
}

export function readDiscoverCatalogResource(
  uri: URL | string = DISCOVER_CATALOG_RESOURCE.uri,
): ReadResourceResult {
  const entries = listDiscoveryEntries();
  return dualContentResource(toResourceUri(uri), entries, renderDiscoveryCatalogMarkdown(entries));
}

export function readDiscoverWorkflowsResource(
  uri: URL | string = DISCOVER_WORKFLOWS_RESOURCE.uri,
): ReadResourceResult {
  const entries = listWorkflowEntries();
  return dualContentResource(toResourceUri(uri), entries, renderWorkflowCatalogMarkdown(entries));
}

interface ServerContextSnapshot {
  workspace: {
    roots: string[];
    scannedFiles: string[];
    estimatedTokens: number;
    cacheStatus: {
      enabled: boolean;
      cacheName: string | undefined;
      fresh: boolean;
      ttl: string;
    };
  };
  sessions: {
    active: number;
    maxSessions: number;
    ttlMs: number;
    ids: string[];
  };
  config: {
    model: string;
    exposeThoughts: boolean;
    workspaceCacheEnabled: boolean;
    workspaceAutoScan: boolean;
  };
}

export function renderServerContextMarkdown(snapshot: ServerContextSnapshot): string {
  const { workspace, sessions, config } = snapshot;
  const displayedFiles = workspace.scannedFiles.slice(0, 10);
  const hiddenFileCount = Math.max(workspace.scannedFiles.length - displayedFiles.length, 0);
  const scannedFileLabel = displayedFiles.length > 0 ? displayedFiles.join(', ') : 'none';
  const scannedFileSuffix = hiddenFileCount > 0 ? ` (+${String(hiddenFileCount)} more)` : '';
  const cacheStatus = workspace.cacheStatus.enabled
    ? workspace.cacheStatus.cacheName
      ? `active (\`${workspace.cacheStatus.cacheName}\`), ${workspace.cacheStatus.fresh ? 'fresh' : 'stale'}, TTL ${workspace.cacheStatus.ttl}`
      : `enabled, no active cache, TTL ${workspace.cacheStatus.ttl}`
    : 'disabled';

  return [
    '# Server Context',
    '',
    '## Workspace',
    '',
    `- **Roots**: ${workspace.roots.join(', ') || 'none'}`,
    `- **Scanned files**: ${scannedFileLabel}${scannedFileSuffix} (${String(workspace.scannedFiles.length)} files)`,
    `- **Estimated tokens**: ${String(workspace.estimatedTokens)}`,
    `- **Cache**: ${cacheStatus}`,
    '',
    '## Sessions',
    '',
    `- **Active**: ${String(sessions.active)} / ${String(sessions.maxSessions)} max`,
    `- **TTL**: ${String(Math.round(sessions.ttlMs / 60_000))} minutes`,
    ...(sessions.ids.length > 0 ? [`- **IDs**: ${sessions.ids.join(', ')}`] : []),
    '',
    '## Config',
    '',
    `- **Model**: ${config.model}`,
    `- **Thoughts**: ${config.exposeThoughts ? 'exposed' : 'hidden'}`,
    `- **Workspace cache**: ${config.workspaceCacheEnabled ? 'enabled' : 'disabled'}`,
    `- **Auto-scan**: ${config.workspaceAutoScan ? 'enabled' : 'disabled'}`,
    '',
  ].join('\n');
}

export async function buildServerContextSnapshot(
  rootsFetcher: RootsFetcher,
  sessionStore: SessionStore,
): Promise<ServerContextSnapshot> {
  const roots = await getAllowedRoots(rootsFetcher);
  const sessionLimits = getSessionLimits();
  const cacheStatus = workspaceCacheManager.getCacheStatus();
  const sessions = sessionStore.listSessionEntries();
  const rootSummaries = await Promise.all(
    roots.map(async (root) => await summarizeRootForDashboard(root)),
  );
  const scannedFiles = rootSummaries.flatMap((summary) => summary.fileNames);

  return {
    workspace: {
      roots,
      scannedFiles,
      estimatedTokens: cacheStatus.estimatedTokens ?? 0,
      cacheStatus: {
        enabled: getWorkspaceCacheEnabled(),
        cacheName: cacheStatus.cacheName ?? undefined,
        fresh: cacheStatus.createdAt !== undefined,
        ttl: getWorkspaceCacheTtl(),
      },
    },
    sessions: {
      active: sessions.length,
      maxSessions: sessionLimits.maxSessions,
      ttlMs: sessionLimits.ttlMs,
      ids: sessions.map((session) => session.id),
    },
    config: {
      model: getGeminiModel(),
      exposeThoughts: getExposeThoughts(),
      workspaceCacheEnabled: getWorkspaceCacheEnabled(),
      workspaceAutoScan: getWorkspaceAutoScan(),
    },
  };
}

export async function readDiscoverContextResource(
  uri: URL | string = DISCOVER_CONTEXT_RESOURCE.uri,
  rootsFetcher: RootsFetcher,
  sessionStore: SessionStore,
): Promise<ReadResourceResult> {
  const snapshot = await buildServerContextSnapshot(rootsFetcher, sessionStore);
  return dualContentResource(toResourceUri(uri), snapshot, renderServerContextMarkdown(snapshot));
}

function renderSessionTranscriptMarkdown(
  sessionId: string | undefined,
  data: SessionTranscriptResourceData,
): string {
  const header = sessionId ? `# Session Transcript \`${sessionId}\`` : '# Session Transcript';

  if (data.length === 0) {
    return [header, '', '_No transcript entries yet._', ''].join('\n');
  }

  const lines: string[] = [header, ''];
  for (const entry of data) {
    const ts = new Date(entry.timestamp).toISOString();
    const taskSuffix = entry.taskId ? ` · task \`${entry.taskId}\`` : '';
    lines.push(`## ${entry.role} · ${ts}${taskSuffix}`, '', entry.text, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function getSessionTranscriptResourceData(
  sessionStore: SessionStore,
  sessionId: string | undefined,
): SessionTranscriptResourceData {
  if (!sessionId) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
  }

  const transcript = sessionStore.listSessionTranscriptEntries(sessionId);
  if (!transcript) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Session '${sessionId}' not found`);
  }
  return transcript;
}

export function getSessionEventsResourceData(
  sessionStore: SessionStore,
  sessionId: string | undefined,
): SessionEventsResourceData {
  if (!sessionId) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
  }

  const events = sessionStore.listSessionEventEntries(sessionId);
  if (!events) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Session '${sessionId}' not found`);
  }
  return events;
}

export function readSessionTranscriptResource(
  sessionStore: SessionStore,
  uri: URL | string,
  sessionId: string | string[] | undefined,
): ReadResourceResult {
  const id = decodeTemplateParam(sessionId);
  const data = getSessionTranscriptResourceData(sessionStore, id);
  return dualContentResource(toResourceUri(uri), data, renderSessionTranscriptMarkdown(id, data));
}

function renderSessionEventsMarkdown(
  sessionId: string | undefined,
  data: SessionEventsResourceData,
): string {
  const header = sessionId ? `# Session Events \`${sessionId}\`` : '# Session Events';

  if (data.length === 0) {
    return [header, '', '_No events yet._', ''].join('\n');
  }

  const lines: string[] = [header, ''];
  for (const entry of data) {
    appendSessionEventMarkdown(lines, entry);
  }
  return lines.join('\n').trimEnd() + '\n';
}

function appendSessionEventMarkdown(
  lines: string[],
  entry: SessionEventsResourceData[number],
): void {
  const ts = new Date(entry.timestamp).toISOString();
  const taskSuffix = entry.taskId ? ` · task \`${entry.taskId}\`` : '';

  lines.push(`## ${ts}${taskSuffix}`, '');
  lines.push(`- Message: ${entry.request.message}`);

  if (entry.request.toolProfile) {
    lines.push(`- Tool profile: \`${entry.request.toolProfile}\``);
  }

  if (entry.request.urls && entry.request.urls.length > 0) {
    lines.push(`- URLs: ${entry.request.urls.join(', ')}`);
  }

  if (entry.response.text) {
    lines.push('', '### Response', '', entry.response.text);
  }

  appendSessionToolEventsMarkdown(lines, entry.response.toolEvents);
  lines.push('');
}

function appendSessionToolEventsMarkdown(
  lines: string[],
  toolEvents: SessionEventsResourceData[number]['response']['toolEvents'],
): void {
  if (!toolEvents || toolEvents.length === 0) {
    return;
  }

  lines.push('', '### Tool events', '');
  for (const toolEvent of toolEvents) {
    const suffix = toolEvent.toolType ? ` (${toolEvent.toolType})` : '';
    lines.push(`- ${toolEvent.kind}${suffix}`);
  }
}

export function readSessionEventsResource(
  sessionStore: SessionStore,
  uri: URL | string,
  sessionId: string | string[] | undefined,
): ReadResourceResult {
  const id = decodeTemplateParam(sessionId);
  const data = getSessionEventsResourceData(sessionStore, id);
  return dualContentResource(toResourceUri(uri), data, renderSessionEventsMarkdown(id, data));
}

function registerSessionResources(server: McpServer, sessionStore: SessionStore): void {
  server.registerResource(
    'memory-sessions',
    'memory://sessions',
    {
      title: 'Active Chat Sessions',
      description: 'List of active server-managed chat sessions and their last access time.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    (uri): ReadResourceResult => jsonResource(uri.href, sessionStore.listSessionEntries()),
  );

  server.registerResource(
    'memory-session-detail',
    new ResourceTemplate('memory://sessions/{sessionId}', {
      list: () => ({ resources: sessionDetailResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Detail',
      description: 'Metadata for a single server-managed chat session by ID.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    (uri, { sessionId }): ReadResourceResult => {
      const id = requireTemplateParam(sessionId, 'Session ID');
      const entry = sessionStore.getSessionEntry(id);
      if (!entry) {
        throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Session '${id}' not found`);
      }
      return jsonResource(uri.href, entry);
    },
  );

  server.registerResource(
    'memory-session-transcript',
    new ResourceTemplate('memory://sessions/{sessionId}/transcript', {
      list: () => ({ resources: sessionTranscriptResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Transcript',
      description:
        'Transcript entries for a single active chat session by ID. ' +
        'Served as application/json with a secondary text/markdown rendering.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.8,
      },
    },
    (uri, { sessionId }): ReadResourceResult =>
      readSessionTranscriptResource(sessionStore, uri, sessionId),
  );

  server.registerResource(
    'memory-session-events',
    new ResourceTemplate('memory://sessions/{sessionId}/events', {
      list: () => ({ resources: sessionEventResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Events',
      description:
        'Structured Gemini tool and function inspection summary for a single active chat session. ' +
        'This is a normalized view, not a raw replay-ready Gemini history. Large payloads may be truncated. ' +
        'Served as application/json with a secondary text/markdown rendering.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    (uri, { sessionId }): ReadResourceResult =>
      readSessionEventsResource(sessionStore, uri, sessionId),
  );
}

function registerCacheResources(server: McpServer): void {
  const log = logger.child('resources');

  server.registerResource(
    'memory-caches',
    MEMORY_CACHES_URI,
    {
      title: 'Gemini Context Caches',
      description: 'List of active Gemini context caches with name, model, and expiry.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        return jsonResource(uri.href, await listCacheSummaries());
      } catch (err) {
        log.error(`Failed to list caches: ${AppError.formatMessage(err)}`);
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'Failed to list caches');
      }
    },
  );

  server.registerResource(
    'memory-cache-detail',
    new ResourceTemplate(`${MEMORY_CACHES_URI}/{cacheName}`, {
      list: async () => ({ resources: cacheDetailResources(await listCacheSummaries()) }),
      complete: {
        cacheName: completeCacheNames,
      },
    }),
    {
      title: 'Cache Detail',
      description: 'Full detail for a single Gemini context cache including token count.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    async (uri, { cacheName }) => await readCacheDetailResource(uri, cacheName),
  );
}

function registerDiscoveryResources(server: McpServer): void {
  server.registerResource(
    'discover-catalog',
    DISCOVER_CATALOG_URI,
    {
      title: 'Discovery Catalog',
      description:
        'Machine-readable catalog of public tools, prompts, and resources. ' +
        'Served as application/json with a secondary text/markdown rendering.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.8,
      },
    },
    (uri): ReadResourceResult => readDiscoverCatalogResource(uri),
  );

  server.registerResource(
    'discover-workflows',
    DISCOVER_WORKFLOWS_URI,
    {
      title: 'Workflow Catalog',
      description:
        'Machine-readable catalog of guided workflows for gemini-assistant. ' +
        'Served as application/json with a secondary text/markdown rendering.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.8,
      },
    },
    (uri): ReadResourceResult => readDiscoverWorkflowsResource(uri),
  );
}

function registerContextResource(
  server: McpServer,
  sessionStore: SessionStore,
  rootsFetcher: RootsFetcher,
): void {
  server.registerResource(
    'discover-context',
    DISCOVER_CONTEXT_URI,
    {
      title: 'Server Context Dashboard',
      description:
        'Live snapshot of workspace files, sessions, caches, and config. ' +
        'Served as application/json with a secondary text/markdown rendering.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    async (uri): Promise<ReadResourceResult> =>
      readDiscoverContextResource(uri, rootsFetcher, sessionStore),
  );
}

function registerWorkspaceResources(server: McpServer, rootsFetcher: RootsFetcher): void {
  const log = logger.child('resources');

  server.registerResource(
    'memory-workspace-context',
    MEMORY_WORKSPACE_CONTEXT_URI,
    {
      title: 'Workspace Context',
      description: 'Assembled project context from workspace files for Gemini.',
      mimeType: 'text/markdown',
      annotations: {
        audience: ['assistant'],
        priority: 1.0,
      },
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        const roots = await getAllowedRoots(rootsFetcher);
        const ctx = await assembleWorkspaceContext(roots);
        return readWorkspaceContextResource(uri, {
          content: ctx.content,
          sources: ctx.sources,
          estimatedTokens: ctx.estimatedTokens,
        });
      } catch (err) {
        log.error(`Failed to assemble workspace context: ${AppError.formatMessage(err)}`);
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'Failed to assemble workspace context',
        );
      }
    },
  );

  server.registerResource(
    'memory-workspace-cache',
    MEMORY_WORKSPACE_CACHE_URI,
    {
      title: 'Workspace Cache Status',
      description: 'Current status of the Gemini workspace context cache.',
      mimeType: 'application/json',
      annotations: {
        audience: ['assistant'],
        priority: 0.5,
      },
    },
    (uri): ReadResourceResult => jsonResource(uri.href, workspaceCacheManager.getCacheStatus()),
  );
}

export function registerResources(
  server: McpServer,
  sessionStore: SessionStore,
  rootsFetcher: RootsFetcher = buildServerRootsFetcher(server),
): void {
  registerSessionResources(server, sessionStore);
  registerCacheResources(server);
  registerDiscoveryResources(server);
  registerContextResource(server, sessionStore, rootsFetcher);
  registerWorkspaceResources(server, rootsFetcher);
}
