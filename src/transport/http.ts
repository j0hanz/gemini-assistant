import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { EventStore, McpServer } from '@modelcontextprotocol/server';
import { localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

const MCP_CORS_HEADERS = [
  'Content-Type',
  'mcp-session-id',
  'Last-Event-Id',
  'mcp-protocol-version',
] as const;

const MCP_EXPOSE_HEADERS = ['mcp-session-id', 'mcp-protocol-version'] as const;

const MCP_CORS_METHODS = 'GET, POST, DELETE, OPTIONS';

function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', MCP_CORS_METHODS);
  res.setHeader('Access-Control-Allow-Headers', MCP_CORS_HEADERS.join(', '));
  res.setHeader('Access-Control-Expose-Headers', MCP_EXPOSE_HEADERS.join(', '));
}

function handlePreflight(res: ServerResponse, origin: string): void {
  setCorsHeaders(res, origin);
  res.writeHead(204);
  res.end();
}

export interface HttpTransportResult {
  httpServer: Server;
  transport: NodeStreamableHTTPServerTransport;
  close: () => Promise<void>;
}

export async function startHttpTransport(
  server: McpServer,
  eventStore?: EventStore,
): Promise<HttpTransportResult> {
  const port = parseInt(process.env.MCP_HTTP_PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.MCP_HTTP_HOST ?? DEFAULT_HOST;
  const corsOrigin = process.env.MCP_CORS_ORIGIN ?? '';

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      console.error(`[http] Session initialized: ${sessionId}`);
    },
    onsessionclosed: (sessionId) => {
      console.error(`[http] Session closed: ${sessionId}`);
    },
    ...(eventStore ? { eventStore } : {}),
  });

  const allowedHostnames = localhostAllowedHostnames();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (corsOrigin) setCorsHeaders(res, corsOrigin);

    const hostCheck = validateHostHeader(req.headers.host, allowedHostnames);
    if (!hostCheck.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Forbidden: ${hostCheck.message}`);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (corsOrigin && req.method === 'OPTIONS') {
      handlePreflight(res, corsOrigin);
      return;
    }

    if (url.pathname === '/mcp') {
      transport.handleRequest(req, res).catch((err: unknown) => {
        console.error('[http] Request error:', err);
        if (server.isConnected()) {
          void server.sendLoggingMessage({
            level: 'error',
            logger: 'http',
            data: `Request error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  await server.connect(transport);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(`[http] MCP server listening on http://${host}:${port}/mcp`);
      resolve();
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
