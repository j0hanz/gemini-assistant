import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
} from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InMemoryEventStore } from './lib/event-store.js';
import { logger } from './lib/logger.js';
import { buildServerRootsFetcher } from './lib/validation.js';
import { onWorkspaceCacheChange } from './lib/workspace-context.js';

import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { createSessionStore, type SessionChangeEvent, type SessionStore } from './sessions.js';
import { registerAnalyzeTool } from './tools/analyze.js';
import { registerChatTool } from './tools/chat.js';
import { registerDiscoverTool } from './tools/discover.js';
import { registerMemoryTool } from './tools/memory.js';
import { type CacheChangeEvent, onCacheChange } from './tools/memory.js';
import { registerResearchTool } from './tools/research-job.js';
import { registerReviewTool } from './tools/review.js';
import type { ServerInstance } from './transport.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const activeServers = new Set<McpServer>();
interface ServerServices {
  sessionStore: SessionStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
}

type ServerRegistrar = (server: McpServer, services: ServerServices) => void;

export const SERVER_TOOL_REGISTRARS = [
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
  (server) => {
    registerDiscoverTool(server);
  },
] as const satisfies readonly ServerRegistrar[];

const SERVER_DESCRIPTION =
  'Gemini AI assistant with six job-first public tools: chat, research, analyze, review, memory, and discover.';

const SERVER_INSTRUCTIONS =
  'Public tools: ' +
  'chat (direct Gemini chat with optional in-memory sessions and cache memory), ' +
  'research (explicit quick or deep grounded research), ' +
  'analyze (file, URL, or small file-set analysis), ' +
  'review (diff review, file comparison, or failure diagnosis), ' +
  'memory (sessions, caches, and workspace memory inspection/mutation), ' +
  'discover (guidance, workflows, prompts, resources, and limitation notes). ' +
  'Use discover://catalog and discover://workflows for the canonical public surface.';

function sendResourceChangedForServer(
  server: McpServer,
  listUri: string,
  detailUris: readonly string[] = [],
): void {
  if (!server.isConnected()) return;
  server.sendResourceListChanged();
  void server.server.sendResourceUpdated({ uri: listUri });
  for (const uri of detailUris) {
    void server.server.sendResourceUpdated({ uri });
  }
}

function sendResourceChanged(listUri: string, detailUris: readonly string[] = []): void {
  for (const server of activeServers) {
    sendResourceChangedForServer(server, listUri, detailUris);
  }
}

onCacheChange(({ detailUris }: CacheChangeEvent) => {
  sendResourceChanged('memory://caches', detailUris);
});
onWorkspaceCacheChange(() => {
  sendResourceChanged('memory://workspace/cache');
});

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
    },
  );

  activeServers.add(server);

  for (const register of SERVER_TOOL_REGISTRARS) {
    register(server, { sessionStore, taskMessageQueue });
  }

  const rootsFetcher = buildServerRootsFetcher(server);
  registerPrompts(server, rootsFetcher);
  registerResources(server, sessionStore, rootsFetcher);

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribeSessionChange();
      sessionStore.close();
      activeServers.delete(server);
      detachLogger();
      taskStore.cleanup();
      await server.close();
    },
  };
}

export function createEventStore(): InMemoryEventStore {
  const eventStore = new InMemoryEventStore();
  eventStore.startPeriodicCleanup();
  return eventStore;
}
