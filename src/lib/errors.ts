import type {
  CallToolResult,
  ProgressNotification,
  ServerContext,
} from '@modelcontextprotocol/server';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';

export type AppErrorCategory = 'client' | 'server' | 'safety' | 'cancelled' | 'internal';

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
      return new GeminiError(toolName, err);
    }

    return new AppError(toolName, `${toolName} failed: ${AppError.formatMessage(err)}`);
  }
}

export class GeminiError extends AppError {
  private static readonly STATUS_MESSAGES: Record<number, string> = {
    400: 'Bad request',
    403: 'Permission denied / invalid API key',
    404: 'Resource or model not found',
    429: 'Rate limited — try again later',
    500: 'Gemini server error',
    503: 'Gemini service unavailable',
    504: 'Gemini request timed out',
  };

  constructor(toolName: string, cause: Error & { status?: number }) {
    const statusCode = typeof cause.status === 'number' ? cause.status : undefined;
    const retryable = statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode);
    const category: AppErrorCategory = retryable ? 'server' : 'client';
    const hint =
      statusCode !== undefined
        ? (GeminiError.STATUS_MESSAGES[statusCode] ?? `HTTP ${statusCode}`)
        : 'Gemini error';
    super(
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

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation', message, 'client', false);
    throw new ProtocolError(INVALID_PARAMS, message);
  }
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
