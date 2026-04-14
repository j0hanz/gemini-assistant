import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { EventStore, McpServer } from '@modelcontextprotocol/server';

import type { Server } from 'node:http';

import { parseAllowedHosts } from '../lib/host-validation.js';

import {
  buildBaseTransportOptions,
  logListening,
  resolveTransportConfig,
  warnIfUnprotected,
} from './shared.js';

export interface HttpTransportResult {
  httpServer: Server;
  transport: NodeStreamableHTTPServerTransport;
  close: () => Promise<void>;
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
