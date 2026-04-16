import { InMemoryTaskStore, McpServer } from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InMemoryEventStore } from './lib/event-store.js';
import { logger } from './lib/logger.js';
import { globalTaskMessageQueue } from './lib/task-utils.js';
import { onWorkspaceCacheChange } from './lib/workspace-context.js';

import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { onSessionChange, type SessionChangeEvent } from './sessions.js';
import { registerAskTool } from './tools/ask.js';
import { type CacheChangeEvent, onCacheChange } from './tools/cache.js';
import { registerCacheTools } from './tools/cache.js';
import { registerCompareFilesTool } from './tools/compare.js';
import { registerGenerateDiagramTool } from './tools/diagram.js';
import { registerAnalyzeFileTool, registerExecuteCodeTool } from './tools/execution.js';
import { registerExplainErrorTool } from './tools/explain-error.js';
import { registerAnalyzePrTool } from './tools/pr.js';
import {
  registerAgenticSearchTool,
  registerAnalyzeUrlTool,
  registerSearchTool,
} from './tools/research.js';
import type { ServerInstance } from './transport.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const activeServers = new Set<McpServer>();
type ServerRegistrar = (server: McpServer) => void;

export const SERVER_TOOL_REGISTRARS = [
  registerAskTool,
  registerExecuteCodeTool,
  registerSearchTool,
  registerAgenticSearchTool,
  registerAnalyzeFileTool,
  registerAnalyzeUrlTool,
  registerAnalyzePrTool,
  registerExplainErrorTool,
  registerCompareFilesTool,
  registerGenerateDiagramTool,
  registerCacheTools,
] as const satisfies readonly ServerRegistrar[];

const SERVER_DESCRIPTION =
  'Gemini AI assistant: multi-turn chat, sandboxed code execution, ' +
  'Google Search grounding, file analysis, context caching, PR diff analysis, ' +
  'error diagnosis, file comparison, and diagram generation.';

const SERVER_INSTRUCTIONS =
  'Tools: ask (chat, multi-turn via sessionId, temperature/seed control), execute_code (sandboxed code), ' +
  'search (web-grounded answers, optional URL Context), ' +
  'agentic_search (deep multi-step research with progress notifications), ' +
  'analyze_file (file upload, mediaResolution for images/video), analyze_url (URL content analysis), ' +
  'create_cache/list_caches/update_cache/delete_cache (context caching, ≥32k tokens), ' +
  'analyze_pr (inspect the current repo, auto-generate a local diff, and review it with Gemini), ' +
  'explain_error (diagnose stack traces and error messages), ' +
  'compare_files (upload two files for structured comparison), ' +
  'generate_diagram (create Mermaid/PlantUML diagrams from descriptions or code). ' +
  'Use cacheName with ask to attach cached context. displayName auto-replaces stale caches.';

function sendResourceChanged(listUri: string, detailUris: readonly string[] = []): void {
  for (const server of activeServers) {
    if (!server.isConnected()) continue;
    server.sendResourceListChanged();
    void server.server.sendResourceUpdated({ uri: listUri });
    for (const uri of detailUris) {
      void server.server.sendResourceUpdated({ uri });
    }
  }
}

onSessionChange(({ detailUris, eventUris, transcriptUris }: SessionChangeEvent) => {
  sendResourceChanged('sessions://list', [...detailUris, ...transcriptUris, ...eventUris]);
});
onCacheChange(({ detailUris }: CacheChangeEvent) => {
  sendResourceChanged('caches://list', detailUris);
});
onWorkspaceCacheChange(() => {
  sendResourceChanged('workspace://cache');
});

export function createServerInstance(): ServerInstance {
  const taskStore = new InMemoryTaskStore();
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
          taskMessageQueue: globalTaskMessageQueue,
        },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  let closed = false;

  activeServers.add(server);

  for (const register of SERVER_TOOL_REGISTRARS) {
    register(server);
  }

  logger.attachServer(server);
  registerPrompts(server);
  registerResources(server);

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      activeServers.delete(server);
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
