import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';

import { registerAnalyzeFileTool } from './tools/analyze-file.js';
import { registerAskTool } from './tools/ask.js';
import { registerCacheTools } from './tools/cache.js';
import { registerExecuteCodeTool } from './tools/execute-code.js';
import { registerSearchTool } from './tools/search.js';

const server = new McpServer(
  { name: 'gemini-assistant', version: '1.0.0' },
  {
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('gemini-assistant MCP server running on stdio');
