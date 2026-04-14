import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';

import { reportFailure } from './context.js';

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  return errorResult(`${toolName} failed: ${formatError(err)}`);
}

export async function logAndReturnError(
  ctx: ServerContext,
  toolName: string,
  err: unknown,
): Promise<CallToolResult> {
  await ctx.mcpReq.log('error', `${toolName} failed: ${formatError(err)}`);
  return geminiErrorResult(toolName, err);
}

export async function handleToolError(
  ctx: ServerContext,
  toolName: string,
  toolLabel: string,
  err: unknown,
): Promise<CallToolResult> {
  await reportFailure(ctx, toolLabel, err);
  return logAndReturnError(ctx, toolName, err);
}

export function cleanupErrorLogger(ctx: ServerContext): (reason: unknown) => void {
  return (reason) => {
    void ctx.mcpReq.log('warning', `File cleanup failed: ${formatError(reason)}`);
  };
}

export function withErrorLogging<TArgs>(
  toolName: string,
  toolLabel: string,
  handler: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
): (args: TArgs, ctx: ServerContext) => Promise<CallToolResult> {
  return async (args: TArgs, ctx: ServerContext) => {
    try {
      return await handler(args, ctx);
    } catch (err) {
      await reportFailure(ctx, toolLabel, err);
      await ctx.mcpReq.log('error', `${toolName} failed: ${formatError(err)}`);

      if (isAbortError(err)) {
        throw new Error(`${toolName}: cancelled by client`, { cause: err });
      }
      if (hasHttpStatus(err)) {
        const hint = STATUS_MESSAGES[err.status] ?? `HTTP ${err.status}`;
        throw new Error(`${toolName} failed: ${hint} — ${err.message}`, { cause: err });
      }
      throw err;
    }
  };
}
