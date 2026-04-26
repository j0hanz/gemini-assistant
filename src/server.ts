import { McpServer } from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from './lib/errors.js';
import { InMemoryEventStore } from './lib/event-store.js';
import { logger } from './lib/logger.js';
import { createSharedTaskInfra, type SharedTaskInfra } from './lib/task-infra.js';
import { buildServerRootsFetcher, type RootsFetcher } from './lib/validation.js';
import { createWorkspaceCacheManager } from './lib/workspace-context.js';

import { getStatelessTransportFlag } from './config.js';
import { registerPrompts } from './prompts.js';
import { PUBLIC_STATIC_RESOURCE_URIS, PUBLIC_TOOL_NAMES } from './public-contract.js';
import { registerResources, SESSIONS_LIST_URI } from './resources.js';
import { createSessionStore, type SessionChangeEvent, type SessionStore } from './sessions.js';
import { registerAnalyzeTool } from './tools/analyze.js';
import { registerChatTool } from './tools/chat.js';
import { registerResearchTool } from './tools/research.js';
import { registerReviewTool } from './tools/review.js';
import type { ServerInstance } from './transport.js';

function resolvePackageVersion(): string {
  const candidatePaths = [
    join(import.meta.dirname, '..', 'package.json'),
    join(import.meta.dirname, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const parsed = JSON.parse(readFileSync(candidatePath, 'utf-8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      continue;
    }
  }

  const envVersion = process.env.npm_package_version?.trim();
  if (envVersion) {
    return envVersion;
  }

  return '0.0.0';
}

const version = resolvePackageVersion();

const log = logger.child('server');
interface ServerServices {
  sessionStore: SessionStore;
  workspaceCacheManager: ReturnType<typeof createWorkspaceCacheManager>;
  rootsFetcher: RootsFetcher;
}

type ServerRegistrar = (server: McpServer, services: ServerServices) => void;

const SERVER_TOOL_REGISTRARS = [
  (server, services) => {
    registerChatTool(server, services.sessionStore, services.workspaceCacheManager);
  },
  (server, services) => {
    registerResearchTool(server, services.workspaceCacheManager);
  },
  (server, services) => {
    registerAnalyzeTool(server, services.workspaceCacheManager, services.rootsFetcher);
  },
  (server, services) => {
    registerReviewTool(server, services.workspaceCacheManager, services.rootsFetcher);
  },
] as const satisfies readonly ServerRegistrar[];

export const SERVER_INSTRUCTIONS =
  `Public tools: ${PUBLIC_TOOL_NAMES.join(', ')}. ` +
  'chat (direct Gemini chat with optional in-memory sessions; ' +
  'chat sessions are server-memory only, expire/evict over time, and require a stateful transport path), ' +
  'research (explicit quick or deep grounded research), ' +
  'analyze (file, URL, small file-set analysis, or diagram generation), ' +
  'review (diff review, file comparison, or failure diagnosis). ' +
  'Tasks (the tools/call task-aware path) are process-local and lost across restarts; ' +
  'deep research tasks may take several minutes — poll tasks/get until terminal. ' +
  'Use discover://catalog and discover://workflows for the canonical public surface.';

const STATIC_RESOURCE_URIS = new Set<string>(PUBLIC_STATIC_RESOURCE_URIS);
const SESSION_DETAIL_URI_PATTERN = /^session:\/\/[^/]+$/;
const SESSION_TRANSCRIPT_URI_PATTERN = /^session:\/\/[^/]+\/transcript$/;
const SESSION_EVENTS_URI_PATTERN = /^session:\/\/[^/]+\/events$/;
const SESSION_TURN_PARTS_URI_PATTERN = /^gemini:\/\/sessions\/[^/]+\/turns\/\d+\/parts$/;

export function isKnownResourceUri(uri: string): boolean {
  return (
    STATIC_RESOURCE_URIS.has(uri) ||
    SESSION_DETAIL_URI_PATTERN.test(uri) ||
    SESSION_TRANSCRIPT_URI_PATTERN.test(uri) ||
    SESSION_EVENTS_URI_PATTERN.test(uri) ||
    SESSION_TURN_PARTS_URI_PATTERN.test(uri)
  );
}

export function sendResourceChangedForServer(server: McpServer, listUri: string | undefined): void {
  if (!server.isConnected()) return;
  if (!listUri) return;
  if (!isKnownResourceUri(listUri)) {
    log.warn(`Blocked resource notification with unregistered URI: ${listUri}`);
    return;
  }
  server.sendResourceListChanged();
}

function registerServerTools(server: McpServer, services: ServerServices): void {
  for (const register of SERVER_TOOL_REGISTRARS) {
    register(server, services);
  }
}

function runCloseStep(closeErrors: Error[], label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const error = new Error(`close: ${label} failed: ${AppError.formatMessage(err)}`);
    closeErrors.push(error);
    log.warn(error.message, { stack: err instanceof Error ? err.stack : undefined });
  }
}

async function runCloseStepAsync(
  closeErrors: Error[],
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const error = new Error(`close: ${label} failed: ${AppError.formatMessage(err)}`);
    closeErrors.push(error);
    log.warn(error.message, { stack: err instanceof Error ? err.stack : undefined });
  }
}

function throwCloseErrors(closeErrors: Error[]): void {
  if (closeErrors.length === 1) {
    throw closeErrors[0] ?? new Error('Server instance shutdown failed');
  }

  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, 'Server instance shutdown failed');
  }
}

export { createSharedTaskInfra };
export type { SharedTaskInfra };

export function createServerInstance(sharedTaskInfra?: SharedTaskInfra): ServerInstance {
  const sessionStore = createSessionStore();
  const taskInfra = sharedTaskInfra ?? createSharedTaskInfra();
  const ownTaskInfra = sharedTaskInfra ? undefined : taskInfra;
  const { taskStore, taskMessageQueue } = taskInfra;
  const workspaceCacheManager = createWorkspaceCacheManager();
  const isStateless = getStatelessTransportFlag();
  const server = new McpServer(
    {
      name: 'gemini-assistant',
      title: 'Gemini Assistant',
      version,
    },
    {
      capabilities: {
        logging: {},
        completions: {},
        prompts: {},
        resources: { listChanged: true },
        tools: {},
        ...(isStateless
          ? {}
          : {
              tasks: {
                requests: { tools: { call: {} } },
                taskStore,
                taskMessageQueue,
              },
            }),
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  let closed = false;
  const detachLogger = logger.attachServer(server);
  const unsubscribeSessionChange = sessionStore.subscribe(({ listChanged }: SessionChangeEvent) => {
    sendResourceChangedForServer(server, listChanged ? SESSIONS_LIST_URI : undefined);
  });

  const rootsFetcher = buildServerRootsFetcher(server);

  registerServerTools(server, {
    sessionStore,
    workspaceCacheManager,
    rootsFetcher,
  });

  registerPrompts(server);
  registerResources(server, sessionStore, workspaceCacheManager, rootsFetcher);

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      const closeErrors: Error[] = [];
      runCloseStep(closeErrors, 'unsubscribeSessionChange', unsubscribeSessionChange);
      await runCloseStepAsync(closeErrors, 'workspaceCacheManager.close', () =>
        workspaceCacheManager.close(),
      );
      runCloseStep(closeErrors, 'sessionStore.close', () => {
        sessionStore.close();
      });
      runCloseStep(closeErrors, 'detachLogger', detachLogger);
      if (ownTaskInfra) {
        runCloseStep(closeErrors, 'taskStore.cleanup', () => {
          ownTaskInfra.close();
        });
      }
      try {
        await server.close();
      } catch (err) {
        const error = new Error(`close: server.close failed: ${AppError.formatMessage(err)}`);
        closeErrors.push(error);
        log.warn(error.message, { stack: err instanceof Error ? err.stack : undefined });
      }

      throwCloseErrors(closeErrors);
    },
  };
}

export function createEventStore(): InMemoryEventStore {
  const eventStore = new InMemoryEventStore();
  eventStore.startPeriodicCleanup();
  return eventStore;
}
