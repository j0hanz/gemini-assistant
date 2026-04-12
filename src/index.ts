import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';

import { registerResources } from './resources.js';
import { registerAnalyzeFileTool } from './tools/analyze-file.js';
import { registerAskTool } from './tools/ask.js';
import { registerCacheTools } from './tools/cache.js';
import { registerExecuteCodeTool } from './tools/execute-code.js';
import { registerSearchTool } from './tools/search.js';

const server = new McpServer(
  { name: 'gemini-assistant', version: '1.0.0' },
  {
    capabilities: { logging: {} },
    instructions:
      'General-purpose Gemini AI assistant. Use "ask" for chat (supports multi-turn via sessionId), ' +
      '"execute_code" for sandboxed code execution, "search" for web-grounded answers, ' +
      '"analyze_file" to analyze uploaded files, and "create_cache"/"list_caches"/"delete_cache" ' +
      'to manage Gemini context caches for large payloads (>32k tokens).',
  },
);

registerAskTool(server);
registerExecuteCodeTool(server);
registerSearchTool(server);
registerAnalyzeFileTool(server);
registerCacheTools(server);
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('gemini-assistant MCP server running on stdio');

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
