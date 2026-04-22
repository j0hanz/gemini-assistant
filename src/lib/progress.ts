import {
  type ProgressNotification,
  RELATED_TASK_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';

// ── Constants ─────────────────────────────────────────────────────────

const MIN_PROGRESS_INTERVAL_MS = 250;
const TASK_STATUS_INTERVAL_MS = 5_000;
const PROGRESS_ENTRY_TTL_MS = 5 * 60 * 1000;
const PROGRESS_SWEEP_INTERVAL_MS = 60 * 1000;

export const PROGRESS_TOTAL = 100;
export const PROGRESS_CAP = 95;

const PROGRESS_STEP_FRACTION = 0.15;
const PRE_STREAM_PROGRESS_CAP = 10;

// ── Throttle State ────────────────────────────────────────────────────

const lastEmitTime = new Map<string, number>();
const lastTaskStatusTime = new Map<string, number>();
let terminalProgressContexts = new WeakSet<ServerContext>();

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
  terminalProgressContexts = new WeakSet<ServerContext>();
}

// ── Internals ─────────────────────────────────────────────────────────

async function bridgeProgressToTask(
  ctx: ServerContext,
  message: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const task = ctx.task;
  if (!task?.id) return;

  const now = Date.now();
  if (!force) {
    const lastUpdate = lastTaskStatusTime.get(task.id) ?? 0;
    if (now - lastUpdate < TASK_STATUS_INTERVAL_MS) return;
  }
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
  taskId?: string,
): ProgressNotification {
  return {
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      ...(total !== undefined ? { total } : {}),
      ...(message ? { message } : {}),
      ...(taskId ? { _meta: { [RELATED_TASK_META_KEY]: { taskId } } } : {}),
    },
  };
}

async function isCancelledTaskContext(ctx: ServerContext): Promise<boolean> {
  const task = ctx.task;
  if (!task?.id) {
    return false;
  }

  try {
    const current = await task.store.getTask(task.id);
    return current.status === 'cancelled';
  } catch {
    return false;
  }
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

function markTerminalProgress(ctx: ServerContext, isTerminal: boolean): void {
  if (isTerminal) {
    terminalProgressContexts.add(ctx);
  }
}

export function hasTerminalProgress(ctx: ServerContext): boolean {
  return terminalProgressContexts.has(ctx);
}

function scaleLogicalStep(current: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  const fraction = Math.max(0, Math.min(current / total, 1));
  return Math.floor(fraction * PRE_STREAM_PROGRESS_CAP);
}

function updateProgressStateAfterNotify(
  progressToken: string | number,
  taskId: string | undefined,
  message: string | undefined,
  now: number,
  isTerminal: boolean,
): void {
  if (isTerminal) {
    clearProgressState(progressToken, taskId);
    return;
  }

  markProgressEmission(progressToken, message, now);
}

async function bridgeProgressMessage(
  ctx: ServerContext,
  message: string | undefined,
  isTerminal: boolean,
): Promise<void> {
  if (!message) {
    return;
  }

  if (isTerminal) {
    // Ensure the final status message reflects terminal state (completion or failure)
    // so clients reading task.statusMessage see the real outcome, not the last step label.
    await bridgeProgressToTask(ctx, message, { force: true });
    return;
  }

  await bridgeProgressToTask(ctx, message);
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
  if (ctx.mcpReq.signal.aborted) return;
  if (await isCancelledTaskContext(ctx)) return;

  const isTerminal = isTerminalProgress(progress, total);
  const progressToken = ctx.mcpReq._meta?.progressToken;

  if (progressToken !== undefined) {
    const now = Date.now();
    if (!shouldThrottleProgress(progressToken, message, now, isTerminal)) {
      try {
        await ctx.mcpReq.notify(
          buildProgressNotification(progressToken, progress, total, message, ctx.task?.id),
        );
        updateProgressStateAfterNotify(progressToken, ctx.task?.id, message, now, isTerminal);
      } catch (err: unknown) {
        await logProgressFailure(ctx, err);
      }
    }
  }

  await bridgeProgressMessage(ctx, message, isTerminal);
  markTerminalProgress(ctx, isTerminal);
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
    await sendProgress(
      this.ctx,
      scaleLogicalStep(current, total),
      PROGRESS_TOTAL,
      `${this.label}: ${message}`,
    );
  }

  /** Report successful completion (progress = 100/100). */
  async complete(detail: string): Promise<void> {
    await reportCompletion(this.ctx, this.label, detail);
  }

  /** Report failure as terminal progress (progress = 100/100). */
  async fail(error: unknown): Promise<void> {
    await reportFailure(this.ctx, this.label, error);
  }
}
