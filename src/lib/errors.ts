import type {
  CallToolResult,
  ProgressNotification,
  ServerContext,
} from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';

// ── Progress / Context ────────────────────────────────────────────────

const MIN_PROGRESS_INTERVAL_MS = 250;
const TASK_STATUS_INTERVAL_MS = 5_000;
const PROGRESS_ENTRY_TTL_MS = 5 * 60 * 1000;
const PROGRESS_SWEEP_INTERVAL_MS = 60 * 1000;

const lastEmitTime = new Map<string, number>();
const lastTaskStatusTime = new Map<string, number>();

function sweepStaleEntries(): void {
  const cutoff = Date.now() - PROGRESS_ENTRY_TTL_MS;
  for (const [key, ts] of lastEmitTime) {
    if (ts < cutoff) lastEmitTime.delete(key);
  }
  for (const [key, ts] of lastTaskStatusTime) {
    if (ts < cutoff) lastTaskStatusTime.delete(key);
  }
}

const progressSweepTimer = setInterval(sweepStaleEntries, PROGRESS_SWEEP_INTERVAL_MS);
progressSweepTimer.unref();

/** Reset the progress throttle state. Intended for testing. */
export function resetProgressThrottle(): void {
  lastEmitTime.clear();
  lastTaskStatusTime.clear();
}

async function bridgeProgressToTask(ctx: ServerContext, message: string): Promise<void> {
  const task = ctx.task;
  if (!task?.id) return;

  const now = Date.now();
  const lastUpdate = lastTaskStatusTime.get(task.id) ?? 0;
  if (now - lastUpdate < TASK_STATUS_INTERVAL_MS) return;
  lastTaskStatusTime.set(task.id, now);

  try {
    await task.store.updateTaskStatus(task.id, 'working', message);
  } catch {
    // Task may already be in terminal status — ignore
  }
}

function isTerminalProgress(progress: number, total?: number): boolean {
  return total !== undefined && progress >= total;
}

function buildThrottleKey(progressToken: string | number, message?: string): string {
  return `${String(progressToken)}:${message ?? ''}`;
}

function shouldThrottleProgress(
  progressToken: string | number,
  message: string | undefined,
  now: number,
  isTerminal: boolean,
): boolean {
  if (isTerminal) {
    return false;
  }

  const lastEmit = lastEmitTime.get(buildThrottleKey(progressToken, message));
  return lastEmit !== undefined && now - lastEmit < MIN_PROGRESS_INTERVAL_MS;
}

function buildProgressNotification(
  progressToken: string | number,
  progress: number,
  total?: number,
  message?: string,
): ProgressNotification {
  return {
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      ...(total !== undefined ? { total } : {}),
      ...(message ? { message } : {}),
    },
  };
}

function clearProgressState(progressToken: string | number, taskId?: string): void {
  for (const key of lastEmitTime.keys()) {
    if (key.startsWith(`${String(progressToken)}:`)) {
      lastEmitTime.delete(key);
    }
  }

  if (taskId) {
    lastTaskStatusTime.delete(taskId);
  }
}

function markProgressEmission(
  progressToken: string | number,
  message: string | undefined,
  now: number,
): void {
  lastEmitTime.set(buildThrottleKey(progressToken, message), now);
}

async function logProgressFailure(ctx: ServerContext, err: unknown): Promise<void> {
  if (ctx.mcpReq.signal.aborted) {
    return;
  }

  const detail = err instanceof Error ? err.message : String(err);
  try {
    await ctx.mcpReq.log('debug', `Progress notification failed: ${detail}`);
  } catch {
    // Transport fully closed — discard
  }
}

export async function sendProgress(
  ctx: ServerContext,
  progress: number,
  total?: number,
  message?: string,
): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined || ctx.mcpReq.signal.aborted) return;

  const isTerminal = isTerminalProgress(progress, total);
  const now = Date.now();
  if (shouldThrottleProgress(progressToken, message, now, isTerminal)) {
    return;
  }

  try {
    await ctx.mcpReq.notify(buildProgressNotification(progressToken, progress, total, message));
    if (isTerminal) {
      clearProgressState(progressToken, ctx.task?.id);
    } else {
      markProgressEmission(progressToken, message, now);
    }
  } catch (err: unknown) {
    await logProgressFailure(ctx, err);
  }

  if (!isTerminal && message) {
    await bridgeProgressToTask(ctx, message);
  }
}

export async function reportCompletion(
  ctx: ServerContext,
  toolLabel: string,
  detail: string,
): Promise<void> {
  await sendProgress(ctx, 100, 100, `${toolLabel}: ${detail}`);
}

export async function reportFailure(
  ctx: ServerContext,
  toolLabel: string,
  error: unknown,
): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  const short = raw.length > 80 ? raw.substring(0, 77) : raw;
  await sendProgress(ctx, 100, 100, `${toolLabel}: failed — ${short}`);
}

// ── Error Formatting ──────────────────────────────────────────────────

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

function hasHttpStatus(err: unknown): err is Error & { status: number } {
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

export async function handleToolError(
  ctx: ServerContext,
  toolName: string,
  toolLabel: string,
  err: unknown,
): Promise<CallToolResult> {
  await reportFailure(ctx, toolLabel, err);
  await ctx.mcpReq.log('error', `${toolName} failed: ${formatError(err)}`);
  return geminiErrorResult(toolName, err);
}

export function cleanupErrorLogger(ctx: ServerContext): (reason: unknown) => void {
  return (reason) => {
    void ctx.mcpReq.log('warning', `File cleanup failed: ${formatError(reason)}`);
  };
}

function toErrorMessage(toolName: string, err: unknown): string {
  if (isAbortError(err)) {
    return `${toolName}: cancelled by client`;
  }
  if (hasHttpStatus(err)) {
    const hint = STATUS_MESSAGES[err.status] ?? `HTTP ${err.status}`;
    return `${toolName} failed: ${hint} — ${err.message}`;
  }
  return `${toolName} failed: ${formatError(err)}`;
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
      return errorResult(toErrorMessage(toolName, err));
    }
  };
}

// ── Retry ─────────────────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;
const JITTER_MS = 500;

function isRetryableError(err: unknown): boolean {
  return hasHttpStatus(err) && RETRYABLE_STATUS_CODES.has(err.status);
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

      await new Promise<void>((resolve, reject) => {
        const delay = computeDelay(attempt, extractRetryAfterMs(err));

        options?.onRetry?.(attempt + 1, maxRetries, Math.round(delay));

        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };

        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delay);

        if (options?.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
}
