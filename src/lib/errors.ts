import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';

type AppErrorCategory = 'client' | 'server' | 'safety' | 'cancelled' | 'internal';

export function assertNever(value: never, label = 'unreachable'): never {
  throw new Error(`${label}: ${String(value)}`);
}

// ── Error Formatting ──────────────────────────────────────────────────

function hasHttpStatus(err: unknown): err is Error & { status: number } {
  return err instanceof Error && 'status' in err && typeof err.status === 'number';
}

function hasRetryableNetworkCode(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }

  const code = (err as { code?: unknown }).code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof DOMException && err.name === 'AbortError')
  );
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
    if (hasRetryableNetworkCode(err)) {
      return true;
    }
    if (hasRetryableNetworkCode((err as { cause?: unknown } | undefined)?.cause)) {
      return true;
    }
    const classified = classifyError(err);
    return classified.kind === 'http' && RETRY_POLICY.retryableStatusCodes.has(classified.status);
  }

  static from(err: unknown, toolName: string): AppError {
    if (err instanceof AppError) {
      return err;
    }

    const classified = classifyError(err);
    switch (classified.kind) {
      case 'abort':
        return new CancelledError(toolName);
      case 'http':
        return AppError.fromHttpError(toolName, err as Error & { status: number });
      case 'other':
        return new AppError(toolName, `${toolName} failed: ${AppError.formatMessage(err)}`);
      default:
        return assertNever(classified, 'classifyError');
    }
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
    const retryable = RETRY_POLICY.retryableStatusCodes.has(statusCode);
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

const FINISH_REASON_ERRORS = new Map<FinishReason, { code: string; message: string }>([
  [
    FinishReason.MALFORMED_FUNCTION_CALL,
    {
      code: 'malformed_function_call',
      message: 'model returned a malformed function call',
    },
  ],
  [
    FinishReason.BLOCKLIST,
    {
      code: 'blocklist',
      message: 'response blocked by blocklist',
    },
  ],
  [
    FinishReason.PROHIBITED_CONTENT,
    {
      code: 'prohibited_content',
      message: 'response blocked due to prohibited content',
    },
  ],
  [
    FinishReason.SPII,
    {
      code: 'spii',
      message: 'response blocked because it may contain sensitive personal information',
    },
  ],
  [
    FinishReason.OTHER,
    {
      code: 'finish_other',
      message: 'response stopped for an unspecified reason',
    },
  ],
]);

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

  const mapped = finishReason ? FINISH_REASON_ERRORS.get(finishReason) : undefined;
  if (mapped) {
    return new AppError(toolName, `${toolName}: ${mapped.message} (${mapped.code})`, 'internal');
  }

  return undefined;
}

export function cleanupErrorLogger(ctx: ServerContext): (reason: unknown) => void {
  return (reason) => {
    void ctx.mcpReq.log('warning', `File cleanup failed: ${AppError.formatMessage(reason)}`);
  };
}

// ── Retry ─────────────────────────────────────────────────────────────

const RETRY_POLICY = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
  jitterMs: 500,
  retryableStatusCodes: new Set([429, 500, 503, 504]),
} as const;

type ClassifiedError = { kind: 'http'; status: number } | { kind: 'abort' } | { kind: 'other' };

function classifyError(err: unknown, signal?: AbortSignal): ClassifiedError {
  if (isAbortError(err, signal)) return { kind: 'abort' };
  if (hasHttpStatus(err)) return { kind: 'http', status: err.status };
  return { kind: 'other' };
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
  const exponential = Math.min(
    Math.pow(2, attempt) * RETRY_POLICY.baseDelayMs,
    RETRY_POLICY.maxDelayMs,
  );
  const jitter = Math.random() * RETRY_POLICY.jitterMs;
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
  options: {
    maxRetries?: number;
    signal?: AbortSignal;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void | Promise<void>;
  } = {},
): Promise<T> {
  const { maxRetries = RETRY_POLICY.maxRetries, signal, onRetry } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !AppError.isRetryable(err)) throw err;
      if (signal?.aborted) throw err;

      const delay = computeDelay(attempt, extractRetryAfterMs(err));
      if (onRetry) {
        await onRetry(attempt + 1, maxRetries, Math.round(delay));
      }
      await delayWithAbort(delay, signal);
    }
  }
}
