import type { EventStore } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

export interface TransportConfig {
  port: number;
  host: string;
  corsOrigin: string;
  isStateless: boolean;
}

export function resolveTransportConfig(): TransportConfig {
  return {
    port: parseInt(process.env.MCP_HTTP_PORT ?? '', 10) || DEFAULT_PORT,
    host: process.env.MCP_HTTP_HOST ?? DEFAULT_HOST,
    corsOrigin: process.env.MCP_CORS_ORIGIN ?? '',
    isStateless: process.env.MCP_STATELESS === 'true',
  };
}

export function warnIfUnprotected(host: string, hasProtection: boolean): void {
  if (!hasProtection && (host === '0.0.0.0' || host === '::')) {
    console.error(
      `SECURITY: bound to ${host} without DNS rebinding protection. ` +
        'Set MCP_ALLOWED_HOSTS=hostname1,hostname2 to restrict accepted Host headers.',
    );
  }
}

export function logListening(host: string, port: number, runtime?: string): void {
  const suffix = runtime ? ` (${runtime})` : '';
  console.error(`listening on http://${host}:${port}/mcp${suffix}`);
}

export function buildBaseTransportOptions(isStateless: boolean, eventStore?: EventStore) {
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
