import type { ProgressNotification, ServerContext } from '@modelcontextprotocol/server';

// ── Constants ─────────────────────────────────────────────────────────

const MIN_PROGRESS_INTERVAL_MS = 250;
const TASK_STATUS_INTERVAL_MS = 5_000;
const PROGRESS_ENTRY_TTL_MS = 5 * 60 * 1000;
const PROGRESS_SWEEP_INTERVAL_MS = 60 * 1000;

export const PROGRESS_TOTAL = 100;
export const PROGRESS_CAP = 95;

const PROGRESS_STEP_FRACTION = 0.15;

// ── Throttle State ────────────────────────────────────────────────────

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

// ── Internals ─────────────────────────────────────────────────────────

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

// ── Core API ──────────────────────────────────────────────────────────

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

export function advanceProgress(current: number): number {
  return Math.min(current + (PROGRESS_TOTAL - current) * PROGRESS_STEP_FRACTION, PROGRESS_CAP);
}

// ── Standalone Helpers ────────────────────────────────────────────────

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

// ── ProgressReporter ──────────────────────────────────────────────────

/**
 * Stateful, label-bound progress reporter.
 *
 * Eliminates the need to pass `ctx` and repeat the tool label on every call.
 * Construct one per tool invocation via `new ProgressReporter(ctx, label)`.
 */
export class ProgressReporter {
  private readonly ctx: ServerContext;
  private readonly label: string;

  constructor(ctx: ServerContext, label: string) {
    this.ctx = ctx;
    this.label = label;
  }

  /** Send a raw progress notification with an auto-prefixed message. */
  async send(progress: number, total?: number, message?: string): Promise<void> {
    await sendProgress(
      this.ctx,
      progress,
      total,
      message ? `${this.label}: ${message}` : undefined,
    );
  }

  /** Report a discrete step in a known-total sequence. */
  async step(current: number, total: number, message: string): Promise<void> {
    await sendProgress(this.ctx, current, total, `${this.label}: ${message}`);
  }

  /** Report successful completion (progress = 100/100). */
  async complete(detail: string): Promise<void> {
    await sendProgress(this.ctx, 100, 100, `${this.label}: ${detail}`);
  }

  /** Report failure as terminal progress (progress = 100/100). */
  async fail(error: unknown): Promise<void> {
    const raw = error instanceof Error ? error.message : String(error);
    const short = raw.length > 80 ? raw.substring(0, 77) : raw;
    await sendProgress(this.ctx, 100, 100, `${this.label}: failed — ${short}`);
  }
}
