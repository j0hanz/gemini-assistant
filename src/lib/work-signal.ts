import type { ServerContext } from '@modelcontextprotocol/server';

type ExtendedTaskContext = NonNullable<ServerContext['task']> & {
  cancellationSignal?: AbortSignal;
};

export function getWorkSignal(ctx: ServerContext): AbortSignal {
  const task = ctx.task as ExtendedTaskContext | undefined;
  return task?.cancellationSignal ?? ctx.mcpReq.signal;
}
