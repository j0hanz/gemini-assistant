import { createMcpExpressApp } from '@modelcontextprotocol/express';
import type { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { NodeStreamableHTTPServerTransport as NodeHttpTransport } from '@modelcontextprotocol/node';
import type {
  EventStore,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport as WebHttpTransport } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { parseAllowedHosts, resolveAllowedHosts, validateHostHeader } from './lib/validation.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

interface BunServerHandle {
  stop: () => void | Promise<void>;
}

interface BunRuntime {
  serve: (opts: {
    fetch: (req: Request) => Promise<Response>;
    port: number;
    hostname: string;
  }) => BunServerHandle;
}

interface DenoServerHandle {
  shutdown: () => void | Promise<void>;
}

interface DenoRuntime {
  serve: (
    handler: (req: Request) => Promise<Response>,
    opts: { port: number; hostname: string },
  ) => DenoServerHandle;
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

interface CleanupEventStore extends EventStore {
  cleanup?: () => void;
}

export interface ServerInstance {
  server: McpServer;
  close: () => Promise<void>;
}

export type ServerFactory = () => Promise<ServerInstance> | ServerInstance;
export type EventStoreFactory = () => CleanupEventStore;
type ServerTransport = Parameters<McpServer['connect']>[0];

interface ManagedPair<TTransport> {
  eventStore?: CleanupEventStore;
  instance: ServerInstance;
  transport: TTransport;
  close: () => Promise<void>;
}

type TransportOptions = ConstructorParameters<typeof WebHttpTransport>[0];
type TransportConstructor<TTransport extends ServerTransport> = new (
  options?: TransportOptions,
) => TTransport;

type StatefulPairMap<TTransport> = Map<string, ManagedPair<TTransport>>;

interface PairSelection<TTransport> {
  pair: ManagedPair<TTransport> | undefined;
  shouldClosePair: boolean;
}

export interface HttpTransportResult {
  httpServer: Server;
  close: () => Promise<void>;
}

export interface WebStandardTransportResult {
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

function logSessionEvent(label: 'open' | 'closed', sessionId: string): void {
  console.error(`session ${label}: ${sessionId}`);
}

function buildBaseTransportOptions(
  isStateless: boolean,
  eventStore?: EventStore,
): TransportOptions {
  return {
    enableJsonResponse: isStateless,
    onsessioninitialized: (sessionId: string) => {
      logSessionEvent('open', sessionId);
    },
    onsessionclosed: (sessionId: string) => {
      logSessionEvent('closed', sessionId);
    },
    ...(eventStore ? { eventStore } : {}),
    ...(!isStateless ? { sessionIdGenerator: () => randomUUID() } : {}),
  };
}

function rpcErrorPayload(message: string) {
  return {
    jsonrpc: '2.0',
    error: { code: -32_603, message },
    id: null,
  };
}

function nodeErrorResponse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(rpcErrorPayload(message)));
}

function responseError(status: number, message: string): Response {
  return new Response(JSON.stringify(rpcErrorPayload(message)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function getNodeSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  return typeof header === 'string' && header.trim() ? header : undefined;
}

function getRequestSessionId(req: Request): string | undefined {
  const header = req.headers.get('mcp-session-id');
  return header?.trim() ? header : undefined;
}

async function createManagedPair<TTransport extends ServerTransport>(
  createServer: ServerFactory,
  Transport: TransportConstructor<TTransport>,
  isStateless: boolean,
  createEventStore?: EventStoreFactory,
): Promise<ManagedPair<TTransport>> {
  const instance = await createServer();
  const eventStore = isStateless ? undefined : createEventStore?.();
  const transport = new Transport(buildBaseTransportOptions(isStateless, eventStore));
  await instance.server.connect(transport);

  let closed = false;
  return {
    instance,
    transport,
    ...(eventStore ? { eventStore } : {}),
    close: async () => {
      if (closed) return;
      closed = true;
      eventStore?.cleanup?.();
      await instance.close();
    },
  };
}

function createNodePair(
  createServer: ServerFactory,
  isStateless: boolean,
  createEventStore?: EventStoreFactory,
): Promise<ManagedPair<NodeStreamableHTTPServerTransport>> {
  return createManagedPair(createServer, NodeHttpTransport, isStateless, createEventStore);
}

async function createWebPair(
  createServer: ServerFactory,
  isStateless: boolean,
  createEventStore?: EventStoreFactory,
): Promise<ManagedPair<WebStandardStreamableHTTPServerTransport>> {
  return createManagedPair(createServer, WebHttpTransport, isStateless, createEventStore);
}

function logRequestFailure(label: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`${label}: ${detail}`);
}

async function selectManagedPair<TTransport>(
  sessionId: string | undefined,
  statefulPairs: StatefulPairMap<TTransport>,
  isStateless: boolean,
  createPair: (isStatelessTransport: boolean) => Promise<ManagedPair<TTransport>>,
): Promise<PairSelection<TTransport>> {
  if (isStateless) {
    return { pair: await createPair(true), shouldClosePair: true };
  }

  if (sessionId) {
    return { pair: statefulPairs.get(sessionId), shouldClosePair: false };
  }

  return { pair: await createPair(false), shouldClosePair: true };
}

function finalizeManagedPair<TTransport>(
  pair: ManagedPair<TTransport>,
  sessionId: string | undefined,
  requestMethod: string,
  isStateless: boolean,
  statefulPairs: StatefulPairMap<TTransport>,
  getSessionId: (transport: TTransport) => string | undefined,
  shouldClosePair: boolean,
): boolean {
  if (isStateless) {
    return true;
  }

  if (requestMethod === 'DELETE') {
    if (sessionId) {
      statefulPairs.delete(sessionId);
    }
    return true;
  }

  const createdSessionId = getSessionId(pair.transport);
  if (!sessionId && createdSessionId) {
    statefulPairs.set(createdSessionId, pair);
    return false;
  }

  return shouldClosePair;
}

async function closeStatefulPairs<TTransport>(
  statefulPairs: StatefulPairMap<TTransport>,
): Promise<void> {
  await Promise.allSettled([...statefulPairs.values()].map((pair) => pair.close()));
  statefulPairs.clear();
}

export async function startHttpTransport(
  createServer: ServerFactory,
  createEventStore?: EventStoreFactory,
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

  const statefulPairs = new Map<string, ManagedPair<NodeStreamableHTTPServerTransport>>();

  app.all('/mcp', async (req, res) => {
    const sessionId = getNodeSessionId(req);
    let pair: ManagedPair<NodeStreamableHTTPServerTransport> | undefined;
    let shouldClosePair = false;

    try {
      ({ pair, shouldClosePair } = await selectManagedPair(
        sessionId,
        statefulPairs,
        isStateless,
        (isStatelessTransport) =>
          createNodePair(createServer, isStatelessTransport, createEventStore),
      ));

      if (!pair) {
        nodeErrorResponse(res, 404, 'Session not found');
        return;
      }

      await pair.transport.handleRequest(req, res, req.body);
      shouldClosePair = finalizeManagedPair(
        pair,
        sessionId,
        req.method,
        isStateless,
        statefulPairs,
        (transport) => transport.sessionId,
        shouldClosePair,
      );
    } catch (err: unknown) {
      logRequestFailure('request failed', err);
      nodeErrorResponse(res, 500, 'Internal Server Error');
    } finally {
      if (shouldClosePair) await pair?.close();
    }
  });

  const httpServer = await new Promise<Server>((resolve) => {
    const srv = app.listen(port, host, () => {
      logListening(host, port);
      resolve(srv);
    });
  });

  const close = async () => {
    await closeStatefulPairs(statefulPairs);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { httpServer, close };
}

/**
 * Creates a WebStandard-based MCP transport for Bun / Deno / Cloudflare Workers.
 *
 * Starts a server using `Bun.serve` or `Deno.serve` when the respective
 * runtime is detected. In other runtimes the caller must wire up `handler`
 * manually.
 */
export function startWebStandardTransport(
  createServer: ServerFactory,
  createEventStore?: EventStoreFactory,
): Promise<WebStandardTransportResult> {
  const { port, host, isStateless } = resolveTransportConfig();
  const allowedHosts = resolveAllowedHosts(host);
  warnIfUnprotected(host, !!allowedHosts);

  const statefulPairs = new Map<string, ManagedPair<WebStandardStreamableHTTPServerTransport>>();

  const handler = async (req: Request): Promise<Response> => {
    if (allowedHosts && !validateHostHeader(req.headers.get('host'), allowedHosts)) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(req.url);
    if (url.pathname !== '/mcp') {
      return new Response('Not Found', { status: 404 });
    }

    const sessionId = getRequestSessionId(req);
    let pair: ManagedPair<WebStandardStreamableHTTPServerTransport> | undefined;
    let shouldClosePair = false;

    try {
      ({ pair, shouldClosePair } = await selectManagedPair(
        sessionId,
        statefulPairs,
        isStateless,
        (isStatelessTransport) =>
          createWebPair(createServer, isStatelessTransport, createEventStore),
      ));

      if (!pair) {
        return responseError(404, 'Session not found');
      }

      const response = await pair.transport.handleRequest(req);
      shouldClosePair = finalizeManagedPair(
        pair,
        sessionId,
        req.method,
        isStateless,
        statefulPairs,
        (transport) => transport.sessionId,
        shouldClosePair,
      );

      return response;
    } catch (err: unknown) {
      logRequestFailure('request failed', err);
      return responseError(500, 'Internal Server Error');
    } finally {
      if (shouldClosePair) await pair?.close();
    }
  };

  const runtimes = globalThis as unknown as RuntimeGlobals;
  let runtimeClose: (() => Promise<void>) | undefined;

  if (runtimes.Bun) {
    const serverHandle = runtimes.Bun.serve({ fetch: handler, port, hostname: host });
    runtimeClose = async () => {
      await serverHandle.stop();
    };
    logListening(host, port, 'Bun');
  } else if (runtimes.Deno) {
    const serverHandle = runtimes.Deno.serve(handler, { port, hostname: host });
    runtimeClose = async () => {
      await serverHandle.shutdown();
    };
    logListening(host, port, 'Deno');
  } else {
    console.error(
      'no auto-serve runtime detected (Bun/Deno) — wire the exported handler manually.',
    );
  }

  const close = async () => {
    await closeStatefulPairs(statefulPairs);
    await runtimeClose?.();
  };

  return Promise.resolve({ handler, close });
}
