import { StdioServerTransport } from '@modelcontextprotocol/server';

import { formatError } from './lib/errors.js';
import { logger } from './lib/logger.js';

import { getTransportMode } from './config.js';
import { createEventStore, createServerInstance } from './server.js';
import type {
  HttpTransportResult,
  ServerInstance,
  WebStandardTransportResult,
} from './transport.js';

const transportMode = getTransportMode();
let httpResult: HttpTransportResult | undefined;
let webStandardResult: WebStandardTransportResult | undefined;
let stdioInstance: ServerInstance | undefined;

if (transportMode === 'http') {
  const { startHttpTransport } = await import('./transport.js');
  httpResult = await startHttpTransport(createServerInstance, createEventStore);
} else if (transportMode === 'web-standard') {
  const { startWebStandardTransport } = await import('./transport.js');
  webStandardResult = await startWebStandardTransport(createServerInstance, createEventStore);
} else {
  stdioInstance = createServerInstance();
  const transport = new StdioServerTransport();
  try {
    await stdioInstance.server.connect(transport);
    logger.info('system', 'MCP server running on stdio');
  } catch (err) {
    await stdioInstance.close();
    logger.fatal('system', 'Failed to connect transport', { error: err });
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  try {
    if (stdioInstance) await stdioInstance.close();
    if (httpResult) await httpResult.close();
    if (webStandardResult) await webStandardResult.close();
  } finally {
    clearTimeout(forceExit);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

function logCriticalAndExit(label: string, err: unknown): void {
  logger.fatal('system', `${label}: ${formatError(err)}`);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  logCriticalAndExit('Uncaught Exception', err);
});
process.on('unhandledRejection', (reason) => {
  logCriticalAndExit('Unhandled Rejection', reason);
});
