import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
  StdioServerTransport,
} from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatError } from './lib/errors.js';
import { InMemoryEventStore } from './lib/event-store.js';
import { logger } from './lib/logger.js';
import { onWorkspaceCacheChange } from './lib/workspace-context.js';

import { getTransportMode } from './config.js';
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
import type {
  HttpTransportResult,
  ServerInstance,
  WebStandardTransportResult,
} from './transport.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const activeServers = new Set<McpServer>();
type ServerRegistrar = (server: McpServer) => void;

const SERVER_TOOL_REGISTRARS = [
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

function createServerInstance(): ServerInstance {
  const taskStore = new InMemoryTaskStore();
  const server = new McpServer(
    {
      name: 'gemini-assistant',
      version,
      description:
        'Gemini AI assistant: multi-turn chat, sandboxed code execution, ' +
        'Google Search grounding, file analysis, context caching, PR diff analysis, ' +
        'error diagnosis, file comparison, and diagram generation.',
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
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
      instructions:
        'Tools: ask (chat, multi-turn via sessionId, temperature/seed control), execute_code (sandboxed code), ' +
        'search (web-grounded answers, optional URL Context), ' +
        'agentic_search (deep multi-step research with progress notifications), ' +
        'analyze_file (file upload, mediaResolution for images/video), analyze_url (URL content analysis), ' +
        'create_cache/list_caches/update_cache/delete_cache (context caching, ≥32k tokens), ' +
        'analyze_pr (inspect the current repo, auto-generate a local diff, and review it with Gemini), ' +
        'explain_error (diagnose stack traces and error messages), ' +
        'compare_files (upload two files for structured comparison), ' +
        'generate_diagram (create Mermaid/PlantUML diagrams from descriptions or code). ' +
        'Use cacheName with ask to attach cached context. displayName auto-replaces stale caches.',
    },
  );

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

function createEventStore(): InMemoryEventStore {
  const eventStore = new InMemoryEventStore();
  eventStore.startPeriodicCleanup();
  return eventStore;
}

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

const transportMode = getTransportMode();
let httpResult: HttpTransportResult | undefined;
let webStandardResult: WebStandardTransportResult | undefined;
let stdioInstance: ServerInstance | undefined;

if (transportMode === 'http') {
  const { startHttpTransport } = await import('./transport.js');
  httpResult = await startHttpTransport(createServerInstance, createEventStore);
} else if (transportMode === 'web-standard') {
  const { startWebStandardTransport } = await import('./transport.js');
  webStandardResult = await startWebStandardTransport(createServerInstance, createEventStore);
} else {
  stdioInstance = createServerInstance();
  const transport = new StdioServerTransport();
  try {
    await stdioInstance.server.connect(transport);
    logger.info('system', 'MCP server running on stdio');
  } catch (err) {
    await stdioInstance.close();
    logger.fatal('system', 'Failed to connect transport', { error: err });
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  try {
    if (stdioInstance) await stdioInstance.close();
    if (httpResult) await httpResult.close();
    if (webStandardResult) await webStandardResult.close();
  } finally {
    clearTimeout(forceExit);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

function logCriticalAndExit(label: string, err: unknown): void {
  logger.fatal('system', `${label}: ${formatError(err)}`);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  logCriticalAndExit('Uncaught Exception', err);
});
process.on('unhandledRejection', (reason) => {
  logCriticalAndExit('Unhandled Rejection', reason);
});
