import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { EventStore, McpServer } from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import {
  parseAllowedHosts,
  resolveAllowedHosts,
  validateHostHeader,
} from './lib/host-validation.js';

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

interface TransportConfig {
  port: number;
  host: string;
  corsOrigin: string;
  isStateless: boolean;
}

export interface HttpTransportResult {
  httpServer: Server;
  transport: NodeStreamableHTTPServerTransport;
  close: () => Promise<void>;
}

export interface WebStandardTransportResult {
  transport: WebStandardStreamableHTTPServerTransport;
  handler: (req: Request) => Promise<Response>;
  close: () => Promise<void>;
}

function resolveTransportConfig(): TransportConfig {
  return {
    port: parseInt(process.env.MCP_HTTP_PORT ?? '', 10) || DEFAULT_PORT,
    host: process.env.MCP_HTTP_HOST ?? DEFAULT_HOST,
    corsOrigin: process.env.MCP_CORS_ORIGIN ?? '',
    isStateless: process.env.MCP_STATELESS === 'true',
  };
}

function warnIfUnprotected(host: string, hasProtection: boolean): void {
  if (!hasProtection && (host === '0.0.0.0' || host === '::')) {
    console.error(
      `SECURITY: bound to ${host} without DNS rebinding protection. ` +
        'Set MCP_ALLOWED_HOSTS=hostname1,hostname2 to restrict accepted Host headers.',
    );
  }
}

function logListening(host: string, port: number, runtime?: string): void {
  const suffix = runtime ? ` (${runtime})` : '';
  console.error(`listening on http://${host}:${port}/mcp${suffix}`);
}

function buildBaseTransportOptions(isStateless: boolean, eventStore?: EventStore) {
  return {
    enableJsonResponse: isStateless,
    onsessioninitialized: (sessionId: string) => {
      console.error(`session open: ${sessionId}`);
    },
    onsessionclosed: (sessionId: string) => {
      console.error(`session closed: ${sessionId}`);
    },
    ...(eventStore ? { eventStore } : {}),
    ...(isStateless ? {} : { sessionIdGenerator: () => randomUUID() }),
  };
}

export async function startHttpTransport(
  server: McpServer,
  eventStore?: EventStore,
): Promise<HttpTransportResult> {
  const { port, host, corsOrigin, isStateless } = resolveTransportConfig();
  const allowedHosts = parseAllowedHosts();
  warnIfUnprotected(host, !!allowedHosts);

  const app = createMcpExpressApp({
    host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });

  if (corsOrigin) {
    app.use((_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, mcp-session-id, Last-Event-Id, mcp-protocol-version',
      );
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
      next();
    });
    app.options('/mcp', (_req, res) => {
      res.sendStatus(204);
    });
  }

  const transport = new NodeStreamableHTTPServerTransport(
    buildBaseTransportOptions(isStateless, eventStore),
  );

  app.all('/mcp', async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`request failed: ${detail}`);
      if (server.isConnected()) {
        void server.sendLoggingMessage({
          level: 'error',
          logger: 'http',
          data: detail,
        });
      }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal Server Error' },
          id: null,
        });
      }
    }
  });

  await server.connect(transport);

  const httpServer = await new Promise<Server>((resolve) => {
    const srv = app.listen(port, host, () => {
      logListening(host, port);
      resolve(srv);
    });
  });

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await transport.close();
  };

  return { httpServer, transport, close };
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
