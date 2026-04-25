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
import { buildServerRootsFetcher } from './lib/validation.js';
import { createWorkspaceCacheManager } from './lib/workspace-context.js';

import { registerPrompts } from './prompts.js';
import { PUBLIC_RESOURCE_URIS } from './public-contract.js';
import { PUBLIC_TOOL_NAMES } from './public-contract.js';
import { SESSIONS_LIST_URI } from './resources.js';
import { registerResources } from './resources.js';
import { createSessionStore, type SessionChangeEvent, type SessionStore } from './sessions.js';
import { registerAnalyzeTool } from './tools/analyze.js';
import { registerChatTool } from './tools/chat.js';
import { registerResearchTool } from './tools/research.js';
import { registerReviewTool } from './tools/review.js';
import type { ServerInstance } from './transport.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const log = logger.child('server');
interface ServerServices {
  sessionStore: SessionStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
  workspaceCacheManager: ReturnType<typeof createWorkspaceCacheManager>;
}

type ServerRegistrar = (server: McpServer, services: ServerServices) => void;

const SERVER_TOOL_REGISTRARS = [
  (server, services) => {
    registerChatTool(
      server,
      services.sessionStore,
      services.taskMessageQueue,
      services.workspaceCacheManager,
    );
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
] as const satisfies readonly ServerRegistrar[];

const SERVER_DESCRIPTION =
  'Gemini AI assistant with four job-first public tools: chat, research, analyze, and review.';

export const SERVER_INSTRUCTIONS =
  `Public tools: ${PUBLIC_TOOL_NAMES.join(', ')}. ` +
  'chat (direct Gemini chat with optional in-memory sessions; ' +
  'chat sessions are server-memory only, expire/evict over time, and require a stateful transport path), ' +
  'research (explicit quick or deep grounded research), ' +
  'analyze (file, URL, small file-set analysis, or diagram generation), ' +
  'review (diff review, file comparison, or failure diagnosis). ' +
  'Use discover://catalog and discover://workflows for the canonical public surface.';

const STATIC_RESOURCE_URIS = new Set<string>(
  PUBLIC_RESOURCE_URIS.filter((uri) => !uri.includes('{')),
);
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
    const firstError = closeErrors[0];
    if (firstError) {
      throw firstError;
    }
  }

  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, 'Server instance shutdown failed');
  }
}

export function createServerInstance(): ServerInstance {
  const sessionStore = createSessionStore();
  const taskStore = new InMemoryTaskStore();
  const taskMessageQueue = new InMemoryTaskMessageQueue();
  const workspaceCacheManager = createWorkspaceCacheManager();
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
        completions: {},
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
  const unsubscribeSessionChange = sessionStore.subscribe(({ listChanged }: SessionChangeEvent) => {
    sendResourceChangedForServer(server, listChanged ? SESSIONS_LIST_URI : undefined);
  });

  registerServerTools(server, { sessionStore, taskMessageQueue, workspaceCacheManager });

  const rootsFetcher = buildServerRootsFetcher(server);
  registerPrompts(server);
  registerResources(server, sessionStore, rootsFetcher, workspaceCacheManager);

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
      runCloseStep(closeErrors, 'taskStore.cleanup', () => {
        taskStore.cleanup();
      });
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
