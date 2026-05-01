import { McpServer } from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from './lib/errors.js';
import { InMemoryEventStore } from './lib/event-store.js';
import { logger } from './lib/logger.js';
import { ResourceNotifier } from './lib/resource-notifier.js';
import { createSharedTaskInfra, type SharedTaskInfra } from './lib/tasks.js';
import type { ToolServices } from './lib/tool-context.js';
import { buildServerRootsFetcher, type RootsFetcher } from './lib/validation.js';
import { createWorkspaceAccess, createWorkspaceCacheManager } from './lib/workspace-context.js';

import { getExposeSessionResources, getStatelessTransportFlag } from './config.js';
import { registerPrompts } from './prompts.js';
import { PUBLIC_TOOL_NAMES } from './public-contract.js';
import { registerAllResources } from './resources.js';
import { sessionResourceUri, turnPartsUri } from './resources/uris.js';
import {
  createSessionAccess,
  createSessionStore,
  type SessionChangeEvent,
  type SessionStore,
} from './sessions.js';
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
  toolServices: ToolServices;
  rootsFetcher: RootsFetcher;
}

type ServerRegistrar = (server: McpServer, services: ServerServices) => void;

const SERVER_TOOL_REGISTRARS = [
  (server, services) => {
    registerChatTool(server, services.toolServices);
  },
  (server, services) => {
    registerResearchTool(server, services.toolServices);
  },
  (server, services) => {
    registerAnalyzeTool(server, services.toolServices);
  },
  (server, services) => {
    registerReviewTool(server, services.toolServices);
  },
] as const satisfies readonly ServerRegistrar[];

const SERVER_INSTRUCTIONS =
  `Public tools: ${PUBLIC_TOOL_NAMES.join(', ')}. ` +
  'chat (direct Gemini chat with optional in-memory sessions; ' +
  'chat sessions are server-memory only, expire/evict over time, and require a stateful transport path), ' +
  'research (explicit quick or deep grounded research), ' +
  'analyze (file, URL, small file-set analysis, or diagram generation), ' +
  'review (diff review, file comparison, or failure diagnosis). ' +
  'Tasks (the tools/call task-aware path) are process-local and lost across restarts; ' +
  'when STATELESS=true, task-aware tools/call requests are unavailable because the tasks capability is not advertised. ' +
  'deep research tasks may take several minutes — poll tasks/get until terminal. ' +
  'Use discover://catalog and discover://workflows for the canonical public surface.';

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

export function createServerInstance(sharedTaskInfra?: SharedTaskInfra): ServerInstance {
  const sessionStore = createSessionStore();
  const taskInfra = sharedTaskInfra ?? createSharedTaskInfra();
  const ownTaskInfra = sharedTaskInfra ? undefined : taskInfra;
  const { taskStore, taskMessageQueue } = taskInfra;
  const workspaceCacheManager = createWorkspaceCacheManager();
  const isStateless = getStatelessTransportFlag();
  const exposeSessionResources = getExposeSessionResources();
  const server = new McpServer(
    {
      name: 'gemini-assistant',
      title: 'Gemini Assistant',
      version,
      websiteUrl: 'https://github.com/j0hanz/gemini-assistant',
    },
    {
      capabilities: {
        logging: {},
        completions: {},
        prompts: {},
        resources: { listChanged: true, subscribe: true },
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
      ...(exposeSessionResources
        ? {
            debouncedNotificationMethods: [
              'notifications/resources/list_changed',
              'notifications/resources/updated',
            ],
          }
        : {}),
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  let closed = false;
  const detachLogger = logger.attachServer(server);
  const notifier = new ResourceNotifier(server.server);

  const unsubscribeSessionChange = sessionStore.subscribe(
    ({ listChanged, turnPartsAdded }: SessionChangeEvent) => {
      if (turnPartsAdded) {
        // New turn-parts URIs are only listed under `gemini://sessions/...`
        // when MCP_EXPOSE_SESSION_RESOURCES=true; suppress the broadcast
        // otherwise so non-exposed installs don't notify on every model turn.
        if (!getExposeSessionResources()) return;

        void notifier.notifyListChanged();
        // Targeted updates so subscribers to specific session resources are
        // notified without re-listing the entire collection.
        void notifier.notifyUpdated(
          turnPartsUri(turnPartsAdded.sessionId, turnPartsAdded.turnIndex),
        );
        void notifier.notifyUpdated(sessionResourceUri(turnPartsAdded.sessionId));
        return;
      }

      if (listChanged) {
        void notifier.notifyListChanged();
      }
    },
  );

  const rootsFetcher = buildServerRootsFetcher(server);
  const toolServices: ToolServices = {
    rootsFetcher,
    session: createSessionAccess(sessionStore),
    workspace: createWorkspaceAccess(workspaceCacheManager, rootsFetcher),
    clientCapabilities: () => server.server.getClientCapabilities(),
  };

  registerServerTools(server, {
    sessionStore,
    toolServices,
    rootsFetcher,
  });

  registerPrompts(server);
  registerAllResources(server, {
    sessionStore,
    toolServices,
    rootsFetcher,
  });

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      const closeErrors: Error[] = [];
      runCloseStep(closeErrors, 'unsubscribeSessionChange', unsubscribeSessionChange);
      runCloseStep(closeErrors, 'notifier.dispose', () => {
        notifier.dispose();
      });
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
