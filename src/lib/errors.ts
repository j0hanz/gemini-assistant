import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';

export function throwInvalidParams(message: string): never {
  throw new ProtocolError(INVALID_PARAMS, message);
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function hasHttpStatus(err: unknown): err is Error & { status: number } {
  return err instanceof Error && 'status' in err && typeof err.status === 'number';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  403: 'Permission denied / invalid API key',
  404: 'Resource or model not found',
  429: 'Rate limited — try again later',
  500: 'Gemini server error',
  503: 'Gemini service unavailable',
};

export function finishReasonError(
  finishReason: FinishReason | undefined,
  text: string,
  toolName: string,
): CallToolResult | undefined {
  if (finishReason === FinishReason.SAFETY) {
    return errorResult(`${toolName}: response blocked by safety filter`);
  }
  if (finishReason === FinishReason.RECITATION) {
    return errorResult(`${toolName}: response blocked due to recitation policy`);
  }
  if (!text && finishReason === FinishReason.MAX_TOKENS) {
    return errorResult(`${toolName}: response truncated — max tokens reached with no output`);
  }
  return undefined;
}

export function geminiErrorResult(toolName: string, err: unknown): CallToolResult {
  if (isAbortError(err)) {
    return errorResult(`${toolName}: cancelled by client`);
  }
  if (hasHttpStatus(err)) {
    const hint = STATUS_MESSAGES[err.status] ?? `HTTP ${err.status}`;
    return errorResult(`${toolName} failed: ${hint} — ${err.message}`);
  }
  return errorResult(`${toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
}

export async function logAndReturnError(
  ctx: ServerContext,
  toolName: string,
  err: unknown,
): Promise<CallToolResult> {
  await ctx.mcpReq.log(
    'error',
    `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  return geminiErrorResult(toolName, err);
}
