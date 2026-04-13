import type { ServerContext } from '@modelcontextprotocol/server';

export async function sendProgress(
  ctx: ServerContext,
  progress: number,
  total: number,
  message?: string,
): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined || ctx.mcpReq.signal.aborted) return;
  try {
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        total,
        ...(message ? { message } : {}),
      },
    });
  } catch {
    // Transport may be closing — swallow notification errors
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
