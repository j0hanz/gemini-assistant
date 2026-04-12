import type { CallToolResult } from '@modelcontextprotocol/server';

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  403: 'Permission denied / invalid API key',
  404: 'Resource or model not found',
  429: 'Rate limited — try again later',
  500: 'Gemini server error',
  503: 'Gemini service unavailable',
};

export function geminiErrorResult(toolName: string, err: unknown): CallToolResult {
  if (err instanceof Error && 'status' in err && typeof err.status === 'number') {
    const hint = STATUS_MESSAGES[err.status] ?? `HTTP ${err.status}`;
    return errorResult(`${toolName} failed: ${hint} — ${err.message}`);
  }
  return errorResult(`${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
}
