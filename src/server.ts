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
import { MEMORY_CACHES_URI } from './lib/resource-uris.js';
import { installTaskSafeToolCallHandler } from './lib/task-utils.js';
import { buildServerRootsFetcher } from './lib/validation.js';

import { registerPrompts } from './prompts.js';
import { PUBLIC_RESOURCE_URIS } from './public-contract.js';
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

const STATIC_RESOURCE_URIS = new Set<string>(
  PUBLIC_RESOURCE_URIS.filter((uri) => !uri.includes('{')),
);
const SESSION_DETAIL_URI_PATTERN = /^memory:\/\/sessions\/[^/]+$/;
const SESSION_TRANSCRIPT_URI_PATTERN = /^memory:\/\/sessions\/[^/]+\/transcript$/;
const SESSION_EVENTS_URI_PATTERN = /^memory:\/\/sessions\/[^/]+\/events$/;
const CACHE_DETAIL_URI_PATTERN = /^memory:\/\/caches\/[^/]+$/;

export function isKnownResourceUri(uri: string): boolean {
  return (
    STATIC_RESOURCE_URIS.has(uri) ||
    SESSION_DETAIL_URI_PATTERN.test(uri) ||
    SESSION_TRANSCRIPT_URI_PATTERN.test(uri) ||
    SESSION_EVENTS_URI_PATTERN.test(uri) ||
    CACHE_DETAIL_URI_PATTERN.test(uri)
  );
}

export function sendResourceChangedForServer(
  server: McpServer,
  listUri: string | undefined,
  detailUris: readonly string[] = [],
): void {
  if (!server.isConnected()) return;
  if (listUri) {
    if (!isKnownResourceUri(listUri)) {
      log.warn(`Blocked resource notification with unregistered URI: ${listUri}`);
      return;
    }
    server.sendResourceListChanged();
  }
  // `notifications/resources/updated` requires the `resources.subscribe`
  // capability (MCP spec); this server does not declare it and does not
  // track subscriptions, so it never emits `resources/updated`. Clients
  // rely on `notifications/resources/list_changed` + re-read. Detail URIs
  // are still validated here for log-warning parity with the firewall.
  for (const uri of detailUris) {
    if (!isKnownResourceUri(uri)) {
      log.warn(`Blocked resource notification with unregistered URI: ${uri}`);
    }
  }
}

function sendResourceChanged(
  listUri: string | undefined,
  detailUris: readonly string[] = [],
): void {
  for (const server of activeServers) {
    sendResourceChangedForServer(server, listUri, detailUris);
  }
}

function handleCacheChange({ detailUris }: CacheChangeEvent): void {
  sendResourceChanged(MEMORY_CACHES_URI, detailUris);
  // `discover://context` is a per-session aggregation and must not be
  // broadcast across servers. The session-change subscriber (bound to the
  // originating `server`) owns scoped updates to that URI.
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
        resources: { listChanged: true },
        tools: { listChanged: false },
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
    ({ listChanged, detailUris, eventUris, transcriptUris }: SessionChangeEvent) => {
      sendResourceChangedForServer(server, listChanged ? 'memory://sessions' : undefined, [
        ...detailUris,
        ...transcriptUris,
        ...eventUris,
      ]);
    },
  );
  const unsubscribeCacheChange = subscribeCacheChange(handleCacheChange);

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
