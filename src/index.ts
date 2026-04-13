import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
  StdioServerTransport,
} from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InMemoryEventStore } from './lib/event-store.js';

import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { onSessionChange } from './sessions.js';
import { registerAnalyzeFileTool } from './tools/analyze-file.js';
import { registerAnalyzeUrlTool } from './tools/analyze-url.js';
import { registerAskTool } from './tools/ask.js';
import { registerCacheTools } from './tools/cache.js';
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
      'General-purpose Gemini AI assistant with multi-turn chat, sandboxed code execution, ' +
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
      'search (web-grounded answers, optional URL Context), analyze_file (file upload analysis), ' +
      'analyze_url (URL content analysis via URL Context), ' +
      'create_cache/list_caches/delete_cache (context caching, ≥32k tokens). ' +
      'Use cacheName with ask to attach cached context.',
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

onSessionChange(() => {
  server.sendResourceListChanged();
  void server.server.sendResourceUpdated({ uri: 'sessions://list' });
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
  taskStore.cleanup();
  eventStore?.cleanup();
  if (httpResult) await httpResult.close();
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

process.on('uncaughtException', (err) => {
  void server.sendLoggingMessage({
    level: 'emergency',
    logger: 'gemini-assistant',
    data: `Uncaught Exception: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  void server.sendLoggingMessage({
    level: 'emergency',
    logger: 'gemini-assistant',
    data: `Unhandled Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
  process.exit(1);
});
