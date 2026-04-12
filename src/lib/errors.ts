import type { CallToolResult } from '@modelcontextprotocol/server';

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
