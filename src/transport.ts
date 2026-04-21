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

import { logger } from './lib/logger.js';
import { parseAllowedHosts, resolveAllowedHosts, validateHostHeader } from './lib/validation.js';

import { getTransportConfig } from './config.js';

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

interface CleanupEventStore extends EventStore {
  cleanup?: () => void;
}

export interface ServerInstance {
  server: McpServer;
  close: () => Promise<void>;
}

type ServerFactory = () => Promise<ServerInstance> | ServerInstance;
type EventStoreFactory = () => CleanupEventStore;
type ServerTransport = Parameters<McpServer['connect']>[0];

interface ManagedPair<TTransport> {
  eventStore?: CleanupEventStore;
  instance: ServerInstance;
  lastAccessAt: number;
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
  releaseReservation?: () => void;
  shouldClosePair: boolean;
}

interface ManagedRequestOptions<TTransport, TResult> {
  createPair: (isStatelessTransport: boolean) => Promise<ManagedPair<TTransport>>;
  getSessionId: (transport: TTransport) => string | undefined;
  handlePair: (pair: ManagedPair<TTransport>) => Promise<TResult>;
  isStateless: boolean;
  maxSessions: number;
  onError: (err: unknown) => TResult;
  onMissingPair: () => TResult;
  requestMethod: string;
  sessionTtlMs: number;
  sessionId: string | undefined;
  statefulPairs: StatefulPairMap<TTransport>;
  acquireStatefulCreationLock: () => Promise<() => void>;
}

function createAsyncLock(): () => Promise<() => void> {
  let current = Promise.resolve();

  return async (): Promise<() => void> => {
    const previous = current;
    let release!: () => void;
    current = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    return release;
  };
}

export interface HttpTransportResult {
  httpServer: Server;
  close: () => Promise<void>;
}

export interface WebStandardTransportResult {
  handler: (req: Request) => Promise<Response>;
  close: () => Promise<void>;
}

const log = logger.child('transport');

function warnIfUnprotected(host: string, hasProtection: boolean): void {
  if (!hasProtection && (host === '0.0.0.0' || host === '::')) {
    log.warn(
      `SECURITY: bound to ${host} without DNS rebinding protection. ` +
        'Set MCP_ALLOWED_HOSTS=hostname1,hostname2 to restrict accepted Host headers.',
    );
  }
}

function logListening(host: string, port: number, runtime?: string): void {
  const suffix = runtime ? ` (${runtime})` : '';
  log.info(`listening on http://${host}:${port}/mcp${suffix}`);
}

function logSessionEvent(label: 'open' | 'closed', sessionId: string): void {
  log.info(`session ${label}: ${sessionId}`);
}

function logTransportSessionEviction(reason: 'capacity' | 'expired', sessionId: string): void {
  log.info(`transport session ${reason}: ${sessionId}`);
}

function now(): number {
  return Date.now();
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

  try {
    await instance.server.connect(transport);
  } catch (error) {
    eventStore?.cleanup?.();
    await instance.close();
    throw error;
  }

  let closed = false;
  return {
    instance,
    lastAccessAt: now(),
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

function logRequestFailure(
  label: string,
  err: unknown,
  meta: { requestMethod: string; sessionId?: string },
): void {
  log.error(label, {
    ...meta,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}

function touchManagedPair<TTransport>(pair: ManagedPair<TTransport>): void {
  pair.lastAccessAt = now();
}

async function evictStatefulPair<TTransport>(
  statefulPairs: StatefulPairMap<TTransport>,
  sessionId: string,
  reason: 'capacity' | 'expired',
): Promise<void> {
  const pair = statefulPairs.get(sessionId);
  if (!pair) return;

  statefulPairs.delete(sessionId);
  logTransportSessionEviction(reason, sessionId);
  await pair.close();
}

async function evictExpiredStatefulPairs<TTransport>(
  statefulPairs: StatefulPairMap<TTransport>,
  sessionTtlMs: number,
): Promise<void> {
  const cutoff = now() - sessionTtlMs;
  const expiredIds = [...statefulPairs.entries()]
    .filter(([, pair]) => pair.lastAccessAt < cutoff)
    .map(([sessionId]) => sessionId);

  for (const sessionId of expiredIds) {
    await evictStatefulPair(statefulPairs, sessionId, 'expired');
  }
}

function oldestStatefulPairId<TTransport>(
  statefulPairs: StatefulPairMap<TTransport>,
): string | undefined {
  let oldestId: string | undefined;
  let oldestAccessAt = Number.POSITIVE_INFINITY;

  for (const [sessionId, pair] of statefulPairs) {
    if (pair.lastAccessAt < oldestAccessAt) {
      oldestAccessAt = pair.lastAccessAt;
      oldestId = sessionId;
    }
  }

  return oldestId;
}

async function ensureStatefulPairCapacity<TTransport>(
  statefulPairs: StatefulPairMap<TTransport>,
  maxSessions: number,
): Promise<void> {
  while (statefulPairs.size >= maxSessions) {
    const oldestId = oldestStatefulPairId(statefulPairs);
    if (!oldestId) return;
    await evictStatefulPair(statefulPairs, oldestId, 'capacity');
  }
}

async function selectManagedPair<TTransport>(
  sessionId: string | undefined,
  statefulPairs: StatefulPairMap<TTransport>,
  isStateless: boolean,
  maxSessions: number,
  sessionTtlMs: number,
  createPair: (isStatelessTransport: boolean) => Promise<ManagedPair<TTransport>>,
  acquireStatefulCreationLock: () => Promise<() => void>,
): Promise<PairSelection<TTransport>> {
  if (isStateless) {
    return { pair: await createPair(true), shouldClosePair: true };
  }

  await evictExpiredStatefulPairs(statefulPairs, sessionTtlMs);

  if (sessionId) {
    const pair = statefulPairs.get(sessionId);
    if (pair) touchManagedPair(pair);
    return { pair, shouldClosePair: false };
  }

  const releaseReservation = await acquireStatefulCreationLock();

  try {
    await evictExpiredStatefulPairs(statefulPairs, sessionTtlMs);
    await ensureStatefulPairCapacity(statefulPairs, maxSessions);
    return {
      pair: await createPair(false),
      releaseReservation,
      shouldClosePair: true,
    };
  } catch (error) {
    releaseReservation();
    throw error;
  }
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
  touchManagedPair(pair);

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

async function handleManagedRequest<TTransport, TResult>({
  createPair,
  getSessionId,
  handlePair,
  isStateless,
  maxSessions,
  onError,
  onMissingPair,
  requestMethod,
  sessionTtlMs,
  sessionId,
  statefulPairs,
  acquireStatefulCreationLock,
}: ManagedRequestOptions<TTransport, TResult>): Promise<TResult> {
  let pair: ManagedPair<TTransport> | undefined;
  let releaseReservation: (() => void) | undefined;
  let shouldClosePair = false;

  try {
    ({ pair, releaseReservation, shouldClosePair } = await selectManagedPair(
      sessionId,
      statefulPairs,
      isStateless,
      maxSessions,
      sessionTtlMs,
      createPair,
      acquireStatefulCreationLock,
    ));

    if (!pair) {
      return onMissingPair();
    }

    const result = await handlePair(pair);
    shouldClosePair = finalizeManagedPair(
      pair,
      sessionId,
      requestMethod,
      isStateless,
      statefulPairs,
      getSessionId,
      shouldClosePair,
    );
    return result;
  } catch (err: unknown) {
    logRequestFailure('request failed', err, {
      requestMethod,
      ...(sessionId ? { sessionId } : {}),
    });
    return onError(err);
  } finally {
    releaseReservation?.();
    if (shouldClosePair) {
      await pair?.close();
    }
  }
}

function applyCors(app: ReturnType<typeof createMcpExpressApp>, corsOrigin: string): void {
  if (!corsOrigin) {
    return;
  }

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

function startDetectedRuntime(
  runtimes: RuntimeGlobals,
  handler: (req: Request) => Promise<Response>,
  host: string,
  port: number,
): (() => Promise<void>) | undefined {
  if (runtimes.Bun) {
    const serverHandle = runtimes.Bun.serve({ fetch: handler, port, hostname: host });
    logListening(host, port, 'Bun');
    return async () => {
      await serverHandle.stop();
    };
  }

  if (runtimes.Deno) {
    const serverHandle = runtimes.Deno.serve(handler, { port, hostname: host });
    logListening(host, port, 'Deno');
    return async () => {
      await serverHandle.shutdown();
    };
  }

  log.warn('no auto-serve runtime detected (Bun/Deno) — wire the exported handler manually.');
  return undefined;
}

export async function startHttpTransport(
  createServer: ServerFactory,
  createEventStore?: EventStoreFactory,
): Promise<HttpTransportResult> {
  const { port, host, corsOrigin, isStateless, maxSessions, sessionTtlMs } = getTransportConfig();
  const allowedHosts = parseAllowedHosts();
  warnIfUnprotected(host, !!allowedHosts);

  const app = createMcpExpressApp({
    host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  applyCors(app, corsOrigin);

  const statefulPairs = new Map<string, ManagedPair<NodeStreamableHTTPServerTransport>>();
  const acquireStatefulCreationLock = createAsyncLock();

  app.all('/mcp', async (req, res) => {
    const sessionId = getNodeSessionId(req);
    await handleManagedRequest({
      createPair: (isStatelessTransport) =>
        createNodePair(createServer, isStatelessTransport, createEventStore),
      getSessionId: (transport) => transport.sessionId,
      handlePair: async (pair) => {
        await pair.transport.handleRequest(req, res, req.body);
      },
      isStateless,
      maxSessions,
      onError: () => {
        nodeErrorResponse(res, 500, 'Internal Server Error');
      },
      onMissingPair: () => {
        nodeErrorResponse(res, 404, 'Session not found');
      },
      requestMethod: req.method,
      sessionTtlMs,
      sessionId,
      statefulPairs,
      acquireStatefulCreationLock,
    });
  });

  const httpServer = await new Promise<Server>((resolve, reject) => {
    let srv: Server;
    const onError = (err: Error) => {
      srv.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.off('error', onError);
      logListening(host, port);
      resolve(srv);
    };

    try {
      srv = app.listen(port, host);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    srv.once('error', onError);
    srv.once('listening', onListening);
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
  const { port, host, isStateless, maxSessions, sessionTtlMs } = getTransportConfig();
  const allowedHosts = resolveAllowedHosts(host);
  warnIfUnprotected(host, !!allowedHosts);

  const statefulPairs = new Map<string, ManagedPair<WebStandardStreamableHTTPServerTransport>>();
  const acquireStatefulCreationLock = createAsyncLock();

  const handler = async (req: Request): Promise<Response> => {
    if (allowedHosts && !validateHostHeader(req.headers.get('host'), allowedHosts)) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(req.url);
    if (url.pathname !== '/mcp') {
      return new Response('Not Found', { status: 404 });
    }

    const sessionId = getRequestSessionId(req);
    return await handleManagedRequest({
      createPair: (isStatelessTransport) =>
        createWebPair(createServer, isStatelessTransport, createEventStore),
      getSessionId: (transport) => transport.sessionId,
      handlePair: (pair) => pair.transport.handleRequest(req),
      isStateless,
      maxSessions,
      onError: () => responseError(500, 'Internal Server Error'),
      onMissingPair: () => responseError(404, 'Session not found'),
      requestMethod: req.method,
      sessionTtlMs,
      sessionId,
      statefulPairs,
      acquireStatefulCreationLock,
    });
  };

  const runtimes = globalThis as unknown as RuntimeGlobals;
  const runtimeClose = startDetectedRuntime(runtimes, handler, host, port);

  const close = async () => {
    await closeStatefulPairs(statefulPairs);
    await runtimeClose?.();
  };

  return Promise.resolve({ handler, close });
}
