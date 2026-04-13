import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { EventStore, McpServer } from '@modelcontextprotocol/server';
import { localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

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

  const httpServer = createServer((req, res) => {
    const hostCheck = validateHostHeader(req.headers.host, allowedHostnames);
    if (!hostCheck.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Forbidden: ${hostCheck.message}`);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
