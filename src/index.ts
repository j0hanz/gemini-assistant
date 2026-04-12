import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { registerAskTool } from './tools/ask.js';
import { registerExecuteCodeTool } from './tools/execute-code.js';
import { registerSearchTool } from './tools/search.js';
import { registerAnalyzeFileTool } from './tools/analyze-file.js';

const server = new McpServer(
  { name: 'gemini-assistant', version: '1.0.0' },
  {
    instructions:
      'General-purpose Gemini AI assistant. Use "ask" for chat (supports multi-turn via sessionId), ' +
      '"execute_code" for sandboxed code execution, "search" for web-grounded answers, ' +
      'and "analyze_file" to analyze uploaded files.',
  },
);

registerAskTool(server);
registerExecuteCodeTool(server);
registerSearchTool(server);
registerAnalyzeFileTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('gemini-assistant MCP server running on stdio');
