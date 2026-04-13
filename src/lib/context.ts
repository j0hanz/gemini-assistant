import type { ServerContext } from '@modelcontextprotocol/server';

export type ReportProgress = (progress: number, total: number, message?: string) => Promise<void>;

interface ToolContext {
  signal: AbortSignal;
  log: ServerContext['mcpReq']['log'];
  reportProgress: ReportProgress;
}

export async function reportCompletion(
  reportProgress: ReportProgress,
  toolLabel: string,
  detail: string,
): Promise<void> {
  await reportProgress(100, 100, `${toolLabel}: ${detail}`);
}

export async function reportFailure(
  reportProgress: ReportProgress,
  toolLabel: string,
  error: unknown,
): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  const short = raw.length > 80 ? `${raw.substring(0, 77)}...` : raw;
  await reportProgress(100, 100, `${toolLabel}: failed — ${short}`);
}

export function extractToolContext(ctx: ServerContext): ToolContext {
  const progressToken = ctx.mcpReq._meta?.progressToken;

  return {
    signal: ctx.mcpReq.signal,
    log: ctx.mcpReq.log,
    reportProgress: async (progress, total, message) => {
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
    },
  };
}
