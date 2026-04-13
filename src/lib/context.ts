import type { ProgressNotification, ServerContext } from '@modelcontextprotocol/server';

export async function sendProgress(
  ctx: ServerContext,
  progress: number,
  total: number,
  message?: string,
): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined || ctx.mcpReq.signal.aborted) return;
  try {
    const notification: ProgressNotification = {
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        total,
        ...(message ? { message } : {}),
      },
    };
    await ctx.mcpReq.notify(notification);
  } catch (err: unknown) {
    const aborted = ctx.mcpReq.signal.aborted as boolean;
    if (!aborted) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        await ctx.mcpReq.log('debug', `Progress notification failed: ${detail}`);
      } catch {
        // Transport fully closed — discard
      }
    }
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
  const short = raw.length > 80 ? `${raw.substring(0, 77)}...` : raw;
  await sendProgress(ctx, 100, 100, `${toolLabel}: failed — ${short}`);
}
