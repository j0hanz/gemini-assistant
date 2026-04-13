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

import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { onSessionChange } from './sessions.js';
import { registerAnalyzeFileTool } from './tools/analyze-file.js';
import { registerAnalyzeUrlTool } from './tools/analyze-url.js';
import { registerAskTool } from './tools/ask.js';
import { onCacheChange, registerCacheTools } from './tools/cache.js';
import { registerExecuteCodeTool } from './tools/execute-code.js';
import { registerSearchTool } from './tools/search.js';
import type { HttpTransportResult } from './transport/http.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const taskStore = new InMemoryTaskStore();

const server = new McpServer(
  {
    name: 'gemini-assistant',
    version,
    description:
      'Gemini AI assistant: multi-turn chat, sandboxed code execution, ' +
      'Google Search grounding, file analysis, and context caching.',
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
      'Tools: ask (chat, multi-turn via sessionId), execute_code (sandboxed code), ' +
      'search (web-grounded answers, optional URL Context), analyze_file (file upload), ' +
      'analyze_url (URL content analysis), ' +
      'create_cache/list_caches/update_cache/delete_cache (context caching, ≥32k tokens). ' +
      'Use cacheName with ask to attach cached context. displayName auto-replaces stale caches.',
  },
);

registerAskTool(server);
registerExecuteCodeTool(server);
registerSearchTool(server);
registerAnalyzeFileTool(server);
registerAnalyzeUrlTool(server);
registerCacheTools(server);
registerPrompts(server);
registerResources(server);

function sendResourceChanged(uri: string, taskId?: string): void {
  if (!server.isConnected()) return;
  server.sendResourceListChanged();
  void server.server.sendResourceUpdated({
    uri,
    ...(taskId ? { _meta: { 'io.modelcontextprotocol/related-task': { taskId } } } : {}),
  });
}

onSessionChange((taskId) => {
  sendResourceChanged('sessions://list', taskId);
});
onCacheChange((taskId) => {
  sendResourceChanged('caches://list', taskId);
});

const transportMode = process.env.MCP_TRANSPORT ?? 'stdio';
let httpResult: HttpTransportResult | undefined;
let eventStore: InMemoryEventStore | undefined;

if (transportMode === 'http') {
  const { startHttpTransport } = await import('./transport/http.js');
  eventStore = new InMemoryEventStore();
  httpResult = await startHttpTransport(server, eventStore);
} else {
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    await server.sendLoggingMessage({
      level: 'info',
      logger: 'gemini-assistant',
      data: 'MCP server running on stdio',
    });
  } catch (err) {
    console.error('Failed to connect transport:', err);
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  try {
    taskStore.cleanup();
    eventStore?.cleanup();
    if (httpResult) await httpResult.close();
    await server.close();
  } finally {
    clearTimeout(forceExit);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

function logCriticalAndExit(label: string, err: unknown): void {
  if (server.isConnected()) {
    void server.sendLoggingMessage({
      level: 'emergency',
      logger: 'gemini-assistant',
      data: `${label}: ${formatError(err)}`,
    });
  }
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  logCriticalAndExit('Uncaught Exception', err);
});
process.on('unhandledRejection', (reason) => {
  logCriticalAndExit('Unhandled Rejection', reason);
});
