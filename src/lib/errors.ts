import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';

export { resetProgressThrottle, sendProgress } from './progress.js';

type AppErrorCategory = 'client' | 'server' | 'safety' | 'cancelled' | 'internal';

// ── Error Formatting ──────────────────────────────────────────────────

function hasHttpStatus(err: unknown): err is Error & { status: number } {
  return err instanceof Error && 'status' in err && typeof err.status === 'number';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class AppError extends Error {
  readonly category: AppErrorCategory;
  readonly retryable: boolean;
  readonly statusCode?: number | undefined;
  readonly toolName: string;

  constructor(
    toolName: string,
    message: string,
    category: AppErrorCategory = 'internal',
    retryable = false,
    statusCode?: number,
  ) {
    super(message);
    this.name = new.target.name;
    this.toolName = toolName;
    this.category = category;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }

  toToolResult(): CallToolResult {
    return {
      content: [{ type: 'text', text: this.message }],
      isError: true,
    };
  }

  static formatMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  static isRetryable(err: unknown): boolean {
    if (err instanceof AppError) {
      return err.retryable;
    }

    return hasHttpStatus(err) && RETRYABLE_STATUS_CODES.has(err.status);
  }

  static from(err: unknown, toolName: string): AppError {
    if (err instanceof AppError) {
      return err;
    }

    if (isAbortError(err)) {
      return new CancelledError(toolName);
    }

    if (hasHttpStatus(err)) {
      return AppError.fromHttpError(toolName, err);
    }

    return new AppError(toolName, `${toolName} failed: ${AppError.formatMessage(err)}`);
  }

  private static readonly HTTP_STATUS_MESSAGES: Record<number, string> = {
    400: 'Bad request',
    403: 'Permission denied / invalid API key',
    404: 'Resource or model not found',
    429: 'Rate limited — try again later',
    500: 'Gemini server error',
    503: 'Gemini service unavailable',
    504: 'Gemini request timed out',
  };

  private static fromHttpError(toolName: string, cause: Error & { status: number }): AppError {
    const statusCode = cause.status;
    const retryable = RETRYABLE_STATUS_CODES.has(statusCode);
    const category: AppErrorCategory = retryable ? 'server' : 'client';
    const hint = AppError.HTTP_STATUS_MESSAGES[statusCode] ?? `HTTP ${statusCode}`;
    return new AppError(
      toolName,
      `${toolName} failed: ${hint} — ${cause.message}`,
      category,
      retryable,
      statusCode,
    );
  }
}

export class SafetyError extends AppError {
  readonly blockReason?: string | undefined;
  readonly kind: 'response_blocked' | 'prompt_blocked' | 'recitation';

  constructor(
    toolName: string,
    kind: 'response_blocked' | 'prompt_blocked' | 'recitation',
    blockReason?: string,
  ) {
    const message =
      kind === 'response_blocked'
        ? `${toolName}: response blocked by safety filter`
        : kind === 'prompt_blocked'
          ? `${toolName}: prompt blocked by safety filter (${blockReason ?? 'unknown'})`
          : `${toolName}: response blocked due to recitation policy`;
    super(toolName, message, 'safety', false);
    this.kind = kind;
    this.blockReason = blockReason;
  }
}

export function throwValidationError(message: string): never {
  throw new ProtocolError(INVALID_PARAMS, message);
}

export class CancelledError extends AppError {
  constructor(toolName: string) {
    super(toolName, `${toolName}: cancelled by client`, 'cancelled', false);
  }
}

export class TruncationError extends AppError {
  constructor(toolName: string) {
    super(
      toolName,
      `${toolName}: response truncated — max tokens reached with no output`,
      'internal',
      false,
    );
  }
}

export function finishReasonToError(
  finishReason: FinishReason | undefined,
  text: string,
  toolName: string,
): AppError | undefined {
  if (finishReason === FinishReason.SAFETY) {
    return new SafetyError(toolName, 'response_blocked');
  }

  if (finishReason === FinishReason.RECITATION) {
    return new SafetyError(toolName, 'recitation');
  }

  if (!text && finishReason === FinishReason.MAX_TOKENS) {
    return new TruncationError(toolName);
  }

  return undefined;
}

export function cleanupErrorLogger(ctx: ServerContext): (reason: unknown) => void {
  return (reason) => {
    void ctx.mcpReq.log('warning', `File cleanup failed: ${AppError.formatMessage(reason)}`);
  };
}

// ── Retry ─────────────────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 503, 504]);
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;
const JITTER_MS = 500;

function isRetryableError(err: unknown): boolean {
  return AppError.isRetryable(err);
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const details = err as Record<string, unknown>;
  if (typeof details.retryAfter === 'number' && details.retryAfter > 0) {
    return details.retryAfter;
  }
  return undefined;
}

function computeDelay(attempt: number, retryAfterMs?: number): number {
  const exponential = Math.min(Math.pow(2, attempt) * BASE_DELAY_MS, MAX_DELAY_MS);
  const jitter = Math.random() * JITTER_MS;
  if (retryAfterMs !== undefined) {
    return Math.max(retryAfterMs, exponential) + jitter;
  }
  return exponential + jitter;
}

function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    signal?: AbortSignal;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableError(err)) throw err;
      if (options?.signal?.aborted) throw err;

      const delay = computeDelay(attempt, extractRetryAfterMs(err));
      options?.onRetry?.(attempt + 1, maxRetries, Math.round(delay));
      await delayWithAbort(delay, options?.signal);
    }
  }
}
