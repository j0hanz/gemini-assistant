import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode, ResourceTemplate } from '@modelcontextprotocol/server';

import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { buildServerRootsFetcher, getAllowedRoots, type RootsFetcher } from './lib/validation.js';
import {
  assembleWorkspaceContext,
  summarizeRootForDashboard,
  type WorkspaceCacheManagerImpl,
} from './lib/workspace-context.js';

import {
  listDiscoveryEntries,
  listWorkflowEntries,
  renderDiscoveryCatalogMarkdown,
  renderWorkflowCatalogMarkdown,
} from './catalog.js';
import {
  getExposeSessionResources,
  getExposeThoughts,
  getGeminiModel,
  getSessionLimits,
  getWorkspaceAutoScan,
  getWorkspaceCacheEnabled,
  getWorkspaceCacheTtl,
} from './config.js';
import { sanitizeSessionText, type SessionStore, type SessionSummary } from './sessions.js';

export { PUBLIC_RESOURCE_URIS } from './public-contract.js';

export const DISCOVER_CATALOG_URI = 'discover://catalog' as const;
export const DISCOVER_WORKFLOWS_URI = 'discover://workflows' as const;
export const DISCOVER_CONTEXT_URI = 'discover://context' as const;
export const SESSIONS_LIST_URI = 'session://' as const;
export const WORKSPACE_CONTEXT_URI = 'workspace://context' as const;
export const WORKSPACE_CACHE_URI = 'workspace://cache' as const;

const MIME_JSON = 'application/json' as const;
const MIME_MARKDOWN = 'text/markdown' as const;
const MIME_TEXT = 'text/plain' as const;
const JSON_WITH_MARKDOWN_ALT_DESC =
  'Served as application/json with a secondary text/markdown rendering.' as const;
const SESSION_ID_REQUIRED_MSG = 'Session ID required' as const;
const SESSION_RESOURCES_DISABLED_MSG = 'Session resources are disabled' as const;
const sessionNotFoundMsg = (id: string): string => `Session '${id}' not found`;

type SessionDetailUri = `session://${string}`;
type SessionTranscriptUri = `session://${string}/transcript`;
type SessionEventsUri = `session://${string}/events`;
type SessionTurnPartsUri = `gemini://sessions/${string}/turns/${string}/parts`;

export function sessionDetailUri(sessionId: string): SessionDetailUri {
  return `session://${encodeURIComponent(sessionId)}`;
}

export function sessionTranscriptUri(sessionId: string): SessionTranscriptUri {
  return `${sessionDetailUri(sessionId)}/transcript`;
}

export function sessionEventsUri(sessionId: string): SessionEventsUri {
  return `${sessionDetailUri(sessionId)}/events`;
}

export function sessionTurnPartsUri(sessionId: string, turnIndex: number): SessionTurnPartsUri {
  return `gemini://sessions/${encodeURIComponent(sessionId)}/turns/${String(turnIndex)}/parts`;
}

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
        mimeType: MIME_JSON,
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
        mimeType: MIME_JSON,
        text: JSON.stringify(data),
      },
      {
        uri,
        mimeType: MIME_MARKDOWN,
        text: markdown,
      },
    ],
  };
}

function textResource(uri: string, text: string, mimeType: string = MIME_TEXT): ReadResourceResult {
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
  return textResource(toResourceUri(uri), renderWorkspaceContextMarkdown(data), MIME_MARKDOWN);
}

function buildSessionResourceEntries(
  sessionEntries: readonly SessionSummary[],
  uriFor: SessionResourceUriBuilder,
  labelFor: (sessionId: string) => string,
): ResourceListEntry[] {
  return sessionEntries.map((session) => ({
    uri: uriFor(session.id),
    name: labelFor(session.id),
  }));
}

function sessionDetailResources(sessionStore: SessionStore): ResourceListEntry[] {
  const entries = sessionStore.listSessionEntries();
  return buildSessionResourceEntries(
    entries,
    sessionDetailUri,
    (sessionId) => `Session ${sessionId}`,
  );
}

function sessionTranscriptResources(sessionStore: SessionStore): ResourceListEntry[] {
  if (!getExposeSessionResources()) return [];
  const entries = sessionStore.listSessionEntries();
  return buildSessionResourceEntries(
    entries,
    sessionTranscriptUri,
    (sessionId) => `Transcript ${sessionId}`,
  );
}

function sessionEventResources(sessionStore: SessionStore): ResourceListEntry[] {
  if (!getExposeSessionResources()) return [];
  const entries = sessionStore.listSessionEntries();
  return buildSessionResourceEntries(
    entries,
    sessionEventsUri,
    (sessionId) => `Events ${sessionId}`,
  );
}

function sessionTurnPartsResources(sessionStore: SessionStore): ResourceListEntry[] {
  if (!getExposeSessionResources()) return [];
  return sessionStore.listSessionEntries().flatMap((session) => {
    const entries = sessionStore.listSessionContentEntries(session.id) ?? [];
    return entries.flatMap((entry, index) =>
      entry.role === 'model'
        ? [
            {
              uri: sessionTurnPartsUri(session.id, index),
              name: `Turn ${String(index)} Parts ${session.id}`,
            },
          ]
        : [],
    );
  });
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

function formatCacheStatus(cacheStatus: ServerContextSnapshot['workspace']['cacheStatus']): string {
  if (!cacheStatus.enabled) return 'disabled';
  if (!cacheStatus.cacheName) return `enabled, no active cache, TTL ${cacheStatus.ttl}`;
  return `active (\`${cacheStatus.cacheName}\`), ${cacheStatus.fresh ? 'fresh' : 'stale'}, TTL ${cacheStatus.ttl}`;
}

function formatScannedFiles(scannedFiles: string[]): string {
  const displayedFiles = scannedFiles.slice(0, 10);
  const hiddenFileCount = Math.max(scannedFiles.length - displayedFiles.length, 0);
  const scannedFileLabel = displayedFiles.length > 0 ? displayedFiles.join(', ') : 'none';
  const scannedFileSuffix = hiddenFileCount > 0 ? ` (+${String(hiddenFileCount)} more)` : '';
  return `${scannedFileLabel}${scannedFileSuffix}`;
}

export function renderServerContextMarkdown(snapshot: ServerContextSnapshot): string {
  const { workspace, sessions, config } = snapshot;
  const cacheStatus = formatCacheStatus(workspace.cacheStatus);
  const scannedFilesStr = formatScannedFiles(workspace.scannedFiles);

  return [
    '# Server Context',
    '',
    '## Workspace',
    '',
    `- **Roots**: ${workspace.roots.join(', ') || 'none'}`,
    `- **Scanned files**: ${scannedFilesStr} (${String(workspace.scannedFiles.length)} files)`,
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
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl,
): Promise<ServerContextSnapshot> {
  const roots = await getAllowedRoots(rootsFetcher);
  const sessionLimits = getSessionLimits();
  const cacheStatus = workspaceCacheManagerInstance.getCacheStatus();
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
        fresh: isWorkspaceCacheFresh(cacheStatus.createdAt, cacheStatus.ttl),
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
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl,
): Promise<ReadResourceResult> {
  const snapshot = await buildServerContextSnapshot(
    rootsFetcher,
    sessionStore,
    workspaceCacheManagerInstance,
  );
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
  if (!getExposeSessionResources()) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, SESSION_RESOURCES_DISABLED_MSG);
  }

  if (!sessionId) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, SESSION_ID_REQUIRED_MSG);
  }

  const transcript = sessionStore.listSessionTranscriptEntries(sessionId);
  if (!transcript) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, sessionNotFoundMsg(sessionId));
  }
  return transcript;
}

export function getSessionEventsResourceData(
  sessionStore: SessionStore,
  sessionId: string | undefined,
): SessionEventsResourceData {
  if (!getExposeSessionResources()) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, SESSION_RESOURCES_DISABLED_MSG);
  }

  if (!sessionId) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, SESSION_ID_REQUIRED_MSG);
  }

  const events = sessionStore.listSessionEventEntries(sessionId);
  if (!events) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, sessionNotFoundMsg(sessionId));
  }
  return events;
}

export function getSessionTurnPartsResourceData(
  sessionStore: SessionStore,
  sessionId: string | undefined,
  turnIndexText: string | undefined,
): unknown[] {
  if (!getExposeSessionResources()) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, SESSION_RESOURCES_DISABLED_MSG);
  }

  if (!sessionId) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, SESSION_ID_REQUIRED_MSG);
  }

  const entry = sessionStore.getSessionEntry(sessionId);
  if (!entry) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, sessionNotFoundMsg(sessionId));
  }

  if (!turnIndexText || !/^\d+$/.test(turnIndexText)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Turn index required');
  }

  const turnIndex = Number.parseInt(turnIndexText, 10);
  const contentEntry = sessionStore.listSessionContentEntries(sessionId)?.[turnIndex];
  if (!contentEntry) {
    throw new ProtocolError(
      ProtocolErrorCode.ResourceNotFound,
      `Session '${sessionId}' turn ${String(turnIndex)} not found`,
    );
  }

  const serialized = JSON.stringify(structuredClone(contentEntry.rawParts ?? contentEntry.parts));
  const sanitized = sanitizeSessionText(serialized) ?? serialized;
  return JSON.parse(sanitized) as unknown[];
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

export function readSessionTurnPartsResource(
  sessionStore: SessionStore,
  uri: URL | string,
  sessionId: string | string[] | undefined,
  turnIndex: string | string[] | undefined,
): ReadResourceResult {
  const id = decodeTemplateParam(sessionId);
  const index = normalizeTemplateParam(turnIndex);
  const data = getSessionTurnPartsResourceData(sessionStore, id, index);
  return jsonResource(toResourceUri(uri), data);
}

function registerSessionResources(server: McpServer, sessionStore: SessionStore): void {
  server.registerResource(
    'session-list',
    SESSIONS_LIST_URI,
    {
      title: 'Active Chat Sessions',
      description: 'List of active server-managed chat sessions and their last access time.',
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    (uri): ReadResourceResult => jsonResource(uri.href, sessionStore.listSessionEntries()),
  );

  server.registerResource(
    'session-detail',
    new ResourceTemplate('session://{sessionId}', {
      list: () => ({ resources: sessionDetailResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Detail',
      description: 'Metadata for a single server-managed chat session by ID.',
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    (uri, { sessionId }): ReadResourceResult => {
      const id = requireTemplateParam(sessionId, 'Session ID');
      const entry = sessionStore.getSessionEntry(id);
      if (!entry) {
        throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, sessionNotFoundMsg(id));
      }
      return jsonResource(uri.href, entry);
    },
  );

  server.registerResource(
    'session-transcript',
    new ResourceTemplate('session://{sessionId}/transcript', {
      list: () => ({ resources: sessionTranscriptResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Transcript',
      description:
        'Transcript entries for a single active chat session by ID. ' + JSON_WITH_MARKDOWN_ALT_DESC,
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.8,
      },
    },
    (uri, { sessionId }): ReadResourceResult =>
      readSessionTranscriptResource(sessionStore, uri, sessionId),
  );

  server.registerResource(
    'session-events',
    new ResourceTemplate('session://{sessionId}/events', {
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
        JSON_WITH_MARKDOWN_ALT_DESC,
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    (uri, { sessionId }): ReadResourceResult =>
      readSessionEventsResource(sessionStore, uri, sessionId),
  );

  server.registerResource(
    'session-turn-parts',
    new ResourceTemplate('gemini://sessions/{sessionId}/turns/{turnIndex}/parts', {
      list: () => ({ resources: sessionTurnPartsResources(sessionStore) }),
      complete: {
        sessionId: sessionStore.completeSessionIds.bind(sessionStore),
      },
    }),
    {
      title: 'Chat Session Turn Parts',
      description:
        'Raw Gemini model-turn `Part[]` for replay-safe orchestration. ' +
        'Oversized `inlineData` payloads are elided but all other parts — ' +
        'including `thought` and `thoughtSignature` — are served verbatim.',
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.8,
      },
    },
    (uri, { sessionId, turnIndex }): ReadResourceResult =>
      readSessionTurnPartsResource(sessionStore, uri, sessionId, turnIndex),
  );
}

function isWorkspaceCacheFresh(createdAt: number | undefined, ttl: string): boolean {
  if (createdAt === undefined) {
    return false;
  }

  const ttlSeconds = Number.parseInt(ttl, 10);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return false;
  }

  return Date.now() - createdAt < ttlSeconds * 1000;
}

function registerDiscoveryResources(server: McpServer): void {
  server.registerResource(
    'discover-catalog',
    DISCOVER_CATALOG_URI,
    {
      title: 'Discovery Catalog',
      description:
        'Machine-readable catalog of public tools, prompts, and resources. ' +
        JSON_WITH_MARKDOWN_ALT_DESC,
      mimeType: MIME_JSON,
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
        JSON_WITH_MARKDOWN_ALT_DESC,
      mimeType: MIME_JSON,
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
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl,
): void {
  server.registerResource(
    'discover-context',
    DISCOVER_CONTEXT_URI,
    {
      title: 'Server Context Dashboard',
      description:
        'Live snapshot of workspace files, sessions, caches, and config. ' +
        JSON_WITH_MARKDOWN_ALT_DESC,
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.7,
      },
    },
    async (uri): Promise<ReadResourceResult> =>
      readDiscoverContextResource(uri, rootsFetcher, sessionStore, workspaceCacheManagerInstance),
  );
}

function registerWorkspaceResources(
  server: McpServer,
  rootsFetcher: RootsFetcher,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl,
): void {
  const log = logger.child('resources');

  server.registerResource(
    'workspace-context',
    WORKSPACE_CONTEXT_URI,
    {
      title: 'Workspace Context',
      description: 'Assembled project context from workspace files for Gemini.',
      mimeType: MIME_MARKDOWN,
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
    'workspace-cache',
    WORKSPACE_CACHE_URI,
    {
      title: 'Workspace Cache Status',
      description: 'Current status of the Gemini workspace context cache.',
      mimeType: MIME_JSON,
      annotations: {
        audience: ['assistant'],
        priority: 0.5,
      },
    },
    (uri): ReadResourceResult =>
      jsonResource(uri.href, workspaceCacheManagerInstance.getCacheStatus()),
  );
}

export function registerResources(
  server: McpServer,
  sessionStore: SessionStore,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl,
  rootsFetcher: RootsFetcher = buildServerRootsFetcher(server),
): void {
  registerSessionResources(server, sessionStore);
  registerDiscoveryResources(server);
  registerContextResource(server, sessionStore, rootsFetcher, workspaceCacheManagerInstance);
  registerWorkspaceResources(server, rootsFetcher, workspaceCacheManagerInstance);
}
