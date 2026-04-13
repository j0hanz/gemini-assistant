import type { ServerContext } from '@modelcontextprotocol/server';

export type ReportProgress = (progress: number, total: number, message?: string) => Promise<void>;

interface ToolContext {
  signal: AbortSignal;
  log: ServerContext['mcpReq']['log'];
  reportProgress: ReportProgress;
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
