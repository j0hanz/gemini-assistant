import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
} from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from './lib/errors.js';
import { InMemoryEventStore } from './lib/event-store.js';
import { logger } from './lib/logger.js';
import { installTaskSafeToolCallHandler } from './lib/task-utils.js';
import { buildServerRootsFetcher } from './lib/validation.js';
import { subscribeWorkspaceCacheChange } from './lib/workspace-context.js';

import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { createSessionStore, type SessionChangeEvent, type SessionStore } from './sessions.js';
import { registerAnalyzeTool } from './tools/analyze.js';
import { registerChatTool } from './tools/chat.js';
import { registerMemoryTool } from './tools/memory.js';
import { type CacheChangeEvent, subscribeCacheChange } from './tools/memory.js';
import { registerResearchTool } from './tools/research.js';
import { registerReviewTool } from './tools/review.js';
import type { ServerInstance } from './transport.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const activeServers = new Set<McpServer>();
const log = logger.child('server');
interface ServerServices {
  sessionStore: SessionStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
}

type ServerRegistrar = (server: McpServer, services: ServerServices) => void;

const SERVER_TOOL_REGISTRARS = [
  (server, services) => {
    registerChatTool(server, services.sessionStore, services.taskMessageQueue);
  },
  (server, services) => {
    registerResearchTool(server, services.taskMessageQueue);
  },
  (server, services) => {
    registerAnalyzeTool(server, services.taskMessageQueue);
  },
  (server, services) => {
    registerReviewTool(server, services.taskMessageQueue);
  },
  (server, services) => {
    registerMemoryTool(server, services.sessionStore, services.taskMessageQueue);
  },
] as const satisfies readonly ServerRegistrar[];

const SERVER_DESCRIPTION =
  'Gemini AI assistant with five job-first public tools: chat, research, analyze, review, and memory.';

const SERVER_INSTRUCTIONS =
  'Public tools: ' +
  'chat (direct Gemini chat with optional in-memory sessions and cache memory; ' +
  'chat sessions are server-memory only, expire/evict over time, and require a stateful transport path), ' +
  'research (explicit quick or deep grounded research), ' +
  'analyze (file, URL, small file-set analysis, or diagram generation), ' +
  'review (diff review, file comparison, or failure diagnosis), ' +
  'memory (sessions, caches, and workspace memory inspection/mutation). ' +
  'Use discover://catalog and discover://workflows for the canonical public surface.';

const ALLOWED_URI_SCHEMES = ['memory://', 'discover://'];

function isAllowedResourceUri(uri: string): boolean {
  return ALLOWED_URI_SCHEMES.some((scheme) => uri.startsWith(scheme));
}

function sendResourceChangedForServer(
  server: McpServer,
  listUri: string,
  detailUris: readonly string[] = [],
): void {
  if (!server.isConnected()) return;
  if (!isAllowedResourceUri(listUri)) {
    log.warn(`Blocked resource notification with unexpected URI: ${listUri}`);
    return;
  }
  server.sendResourceListChanged();
  void server.server.sendResourceUpdated({ uri: listUri });
  for (const uri of detailUris) {
    if (!isAllowedResourceUri(uri)) {
      log.warn(`Blocked resource notification with unexpected URI: ${uri}`);
      continue;
    }
    void server.server.sendResourceUpdated({ uri });
  }
}

function sendResourceChanged(listUri: string, detailUris: readonly string[] = []): void {
  for (const server of activeServers) {
    sendResourceChangedForServer(server, listUri, detailUris);
  }
}

function handleCacheChange({ detailUris }: CacheChangeEvent): void {
  sendResourceChanged('memory://caches', detailUris);
  sendResourceChanged('discover://context');
}

function handleWorkspaceCacheChange(): void {
  sendResourceChanged('memory://workspace/cache');
  sendResourceChanged('discover://context');
}

export function createServerInstance(): ServerInstance {
  const sessionStore = createSessionStore();
  const taskStore = new InMemoryTaskStore();
  const taskMessageQueue = new InMemoryTaskMessageQueue();
  const server = new McpServer(
    {
      name: 'gemini-assistant',
      version,
      description: SERVER_DESCRIPTION,
      websiteUrl: 'https://github.com/j0hanz/gemini-assistant',
    },
    {
      capabilities: {
        logging: {},
        prompts: {},
        resources: { listChanged: true, subscribe: true },
        tasks: {
          requests: { tools: { call: {} } },
          taskStore,
          taskMessageQueue,
        },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  let closed = false;
  const detachLogger = logger.attachServer(server);
  const unsubscribeSessionChange = sessionStore.subscribe(
    ({ detailUris, eventUris, transcriptUris }: SessionChangeEvent) => {
      sendResourceChangedForServer(server, 'memory://sessions', [
        ...detailUris,
        ...transcriptUris,
        ...eventUris,
      ]);
      sendResourceChangedForServer(server, 'discover://context');
    },
  );
  const unsubscribeCacheChange = subscribeCacheChange(handleCacheChange);
  const unsubscribeWorkspaceCacheChange = subscribeWorkspaceCacheChange(handleWorkspaceCacheChange);

  activeServers.add(server);

  for (const register of SERVER_TOOL_REGISTRARS) {
    register(server, { sessionStore, taskMessageQueue });
  }
  installTaskSafeToolCallHandler(server);

  const rootsFetcher = buildServerRootsFetcher(server);
  registerPrompts(server);
  registerResources(server, sessionStore, rootsFetcher);

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      const closeErrors: Error[] = [];
      const safeRun = (label: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          const error = new Error(`close: ${label} failed: ${AppError.formatMessage(err)}`);
          closeErrors.push(error);
          log.warn(error.message, { stack: err instanceof Error ? err.stack : undefined });
        }
      };
      safeRun('unsubscribeSessionChange', unsubscribeSessionChange);
      safeRun('unsubscribeCacheChange', unsubscribeCacheChange);
      safeRun('unsubscribeWorkspaceCacheChange', unsubscribeWorkspaceCacheChange);
      safeRun('sessionStore.close', () => {
        sessionStore.close();
      });
      safeRun('activeServers.delete', () => {
        activeServers.delete(server);
      });
      safeRun('detachLogger', detachLogger);
      safeRun('taskStore.cleanup', () => {
        taskStore.cleanup();
      });
      try {
        await server.close();
      } catch (err) {
        const error = new Error(`close: server.close failed: ${AppError.formatMessage(err)}`);
        closeErrors.push(error);
        log.warn(error.message, { stack: err instanceof Error ? err.stack : undefined });
      }

      if (closeErrors.length === 1) {
        const firstError = closeErrors[0];
        if (firstError) {
          throw firstError;
        }
      }

      if (closeErrors.length > 1) {
        throw new AggregateError(closeErrors, 'Server instance shutdown failed');
      }
    },
  };
}

export function createEventStore(): InMemoryEventStore {
  const eventStore = new InMemoryEventStore();
  eventStore.startPeriodicCleanup();
  return eventStore;
}
