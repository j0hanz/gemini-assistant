import type { EventStore, McpServer } from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { resolveAllowedHosts, validateHostHeader } from '../lib/host-validation.js';

import {
  buildBaseTransportOptions,
  logListening,
  resolveTransportConfig,
  warnIfUnprotected,
} from './shared.js';

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
  const { port, host, isStateless } = resolveTransportConfig();

  const transport = new WebStandardStreamableHTTPServerTransport(
    buildBaseTransportOptions(isStateless, eventStore),
  );

  await server.connect(transport);

  const allowedHosts = resolveAllowedHosts(host);
  warnIfUnprotected(host, !!allowedHosts);

  const handler = async (req: Request): Promise<Response> => {
    if (allowedHosts && !validateHostHeader(req.headers.get('host'), allowedHosts)) {
      return new Response('Forbidden', { status: 403 });
    }

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
    logListening(host, port, 'Bun');
  } else if (runtimes.Deno) {
    runtimes.Deno.serve(handler, { port, hostname: host });
    logListening(host, port, 'Deno');
  } else {
    console.error(
      'no auto-serve runtime detected (Bun/Deno) — wire the exported handler manually.',
    );
  }

  const close = async () => {
    await transport.close();
  };

  return { transport, handler, close };
}
