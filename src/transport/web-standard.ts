import type { EventStore, McpServer } from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

interface BunRuntime {
  serve: (opts: {
    fetch: (req: Request) => Promise<Response>;
    port: number;
    hostname: string;
  }) => void;
}

interface DenoRuntime {
  serve: (
    handler: (req: Request) => Promise<Response>,
    opts: { port: number; hostname: string },
  ) => void;
}

interface RuntimeGlobals {
  Bun?: BunRuntime;
  Deno?: DenoRuntime;
}

export interface WebStandardTransportResult {
  transport: WebStandardStreamableHTTPServerTransport;
  handler: (req: Request) => Promise<Response>;
  close: () => Promise<void>;
}

/**
 * Creates a WebStandard-based MCP transport for Bun / Deno / Cloudflare Workers.
 *
 * Starts a server using `Bun.serve` or `Deno.serve` when the respective
 * runtime is detected. In other runtimes the caller must wire up `handler`
 * manually.
 */
export async function startWebStandardTransport(
  server: McpServer,
  eventStore?: EventStore,
): Promise<WebStandardTransportResult> {
  const port = parseInt(process.env.MCP_HTTP_PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.MCP_HTTP_HOST ?? DEFAULT_HOST;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      console.error(`Session initialized: ${sessionId}`);
    },
    onsessionclosed: (sessionId) => {
      console.error(`Session closed: ${sessionId}`);
    },
    ...(eventStore ? { eventStore } : {}),
  });

  await server.connect(transport);

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') {
      return transport.handleRequest(req);
    }
    return new Response('Not Found', { status: 404 });
  };

  // Auto-start server when a compatible runtime is detected
  const runtimes = globalThis as unknown as RuntimeGlobals;
  if (runtimes.Bun) {
    runtimes.Bun.serve({ fetch: handler, port, hostname: host });
    console.error(`MCP server listening on http://${host}:${port}/mcp (Bun)`);
  } else if (runtimes.Deno) {
    runtimes.Deno.serve(handler, { port, hostname: host });
    console.error(`MCP server listening on http://${host}:${port}/mcp (Deno)`);
  } else {
    console.error(
      'No compatible runtime detected (Bun/Deno). ' +
        'Use the exported handler with your serving layer.',
    );
  }

  const close = async () => {
    await transport.close();
  };

  return { transport, handler, close };
}
