import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { EventStore, McpServer } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

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
  const corsOrigin = process.env.MCP_CORS_ORIGIN ?? '';
  const isStateless = process.env.MCP_STATELESS === 'true';

  const app = createMcpExpressApp({ host });

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

  const baseTransportOptions = {
    enableJsonResponse: isStateless,
    onsessioninitialized: (sessionId: string) => {
      console.error(`[http] Session initialized: ${sessionId}`);
    },
    onsessionclosed: (sessionId: string) => {
      console.error(`[http] Session closed: ${sessionId}`);
    },
    ...(eventStore ? { eventStore } : {}),
  } as const;

  const transport = new NodeStreamableHTTPServerTransport({
    ...baseTransportOptions,
    ...(isStateless ? {} : { sessionIdGenerator: () => randomUUID() }),
  });

  app.all('/mcp', async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      console.error('[http] Request error:', err);
      if (server.isConnected()) {
        void server.sendLoggingMessage({
          level: 'error',
          logger: 'http',
          data: `Request error: ${err instanceof Error ? err.message : String(err)}`,
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
      console.error(`[http] MCP server listening on http://${host}:${port}/mcp`);
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
