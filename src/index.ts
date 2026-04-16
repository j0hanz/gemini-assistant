import { StdioServerTransport } from '@modelcontextprotocol/server';

import { pathToFileURL } from 'node:url';

import { formatError } from './lib/errors.js';
import { logger } from './lib/logger.js';

import { getTransportMode, type TransportMode } from './config.js';
import { createEventStore, createServerInstance } from './server.js';
import type {
  HttpTransportResult,
  ServerInstance,
  WebStandardTransportResult,
} from './transport.js';

type CreateEventStoreFn = typeof createEventStore;
type CreateServerInstanceFn = typeof createServerInstance;

interface ProcessLike {
  argv: string[];
  exit: (code: number) => never | void;
  off: (
    event: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection',
    listener: (...args: unknown[]) => void,
  ) => ProcessLike;
  on: (
    event: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection',
    listener: (...args: unknown[]) => void,
  ) => ProcessLike;
}

interface LoggerLike {
  fatal: (context: string, message: string, data?: unknown) => void;
  info: (context: string, message: string, data?: unknown) => void;
}

export interface StartedRuntime {
  httpResult?: HttpTransportResult;
  stdioInstance?: ServerInstance;
  webStandardResult?: WebStandardTransportResult;
}

export interface MainDependencies {
  createEventStore: CreateEventStoreFn;
  createServerInstance: CreateServerInstanceFn;
  createStdioTransport: () => StdioServerTransport;
  getTransportMode: () => TransportMode;
  logger: LoggerLike;
  process: ProcessLike;
  startHttpTransport: (
    createServer: CreateServerInstanceFn,
    createEventStore: CreateEventStoreFn,
  ) => Promise<HttpTransportResult>;
  startWebStandardTransport: (
    createServer: CreateServerInstanceFn,
    createEventStore: CreateEventStoreFn,
  ) => Promise<WebStandardTransportResult>;
}

function createMainDependencies(): MainDependencies {
  return {
    createEventStore,
    createServerInstance,
    createStdioTransport: () => new StdioServerTransport(),
    getTransportMode,
    logger,
    process,
    startHttpTransport: async (...args) =>
      (await import('./transport.js')).startHttpTransport(...args),
    startWebStandardTransport: async (...args) =>
      (await import('./transport.js')).startWebStandardTransport(...args),
  };
}

function logCriticalAndExit(
  label: string,
  err: unknown,
  loggerInstance: LoggerLike,
  processLike: ProcessLike,
): void {
  loggerInstance.fatal('system', `${label}: ${formatError(err)}`);
  processLike.exit(1);
}

function createShutdownError(label: string, err: unknown): Error {
  return new Error(`${label} shutdown failed: ${formatError(err)}`);
}

export async function closeStartedRuntime(runtime: StartedRuntime): Promise<void> {
  const errors: Error[] = [];

  const closePart = async (label: string, close?: () => Promise<void>) => {
    if (!close) {
      return;
    }

    try {
      await close();
    } catch (err) {
      errors.push(createShutdownError(label, err));
    }
  };

  await closePart('stdio transport', runtime.stdioInstance?.close.bind(runtime.stdioInstance));
  await closePart('http transport', runtime.httpResult?.close.bind(runtime.httpResult));
  await closePart(
    'web-standard transport',
    runtime.webStandardResult?.close.bind(runtime.webStandardResult),
  );

  if (errors.length === 1) {
    const firstError = errors[0];
    if (firstError) {
      throw firstError;
    }
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, 'Multiple shutdown failures');
  }
}

function createShutdownHandler(
  runtime: StartedRuntime,
  loggerInstance: LoggerLike,
  processLike: ProcessLike,
  disposeProcessHandlers: () => void,
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return async () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const forceExit = setTimeout(() => {
        disposeProcessHandlers();
        processLike.exit(1);
      }, 10_000);
      forceExit.unref();

      try {
        await closeStartedRuntime(runtime);
      } catch (err) {
        disposeProcessHandlers();
        loggerInstance.fatal('system', `Shutdown failed: ${formatError(err)}`);
        processLike.exit(1);
        return;
      } finally {
        clearTimeout(forceExit);
      }

      disposeProcessHandlers();
      processLike.exit(0);
    })();

    return shutdownPromise;
  };
}

function installProcessHandlers(
  processLike: ProcessLike,
  shutdown: () => Promise<void>,
  loggerInstance: LoggerLike,
): () => void {
  const onSigInt = () => {
    void shutdown();
  };
  const onSigTerm = () => {
    void shutdown();
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    processLike.off('SIGINT', onSigInt);
    processLike.off('SIGTERM', onSigTerm);
    processLike.off('uncaughtException', onUncaughtException);
    processLike.off('unhandledRejection', onUnhandledRejection);
  };

  const onUncaughtException = (err: unknown) => {
    dispose();
    logCriticalAndExit('Uncaught Exception', err, loggerInstance, processLike);
  };
  const onUnhandledRejection = (reason: unknown) => {
    dispose();
    logCriticalAndExit('Unhandled Rejection', reason, loggerInstance, processLike);
  };

  processLike.on('SIGINT', onSigInt);
  processLike.on('SIGTERM', onSigTerm);
  processLike.on('uncaughtException', onUncaughtException);
  processLike.on('unhandledRejection', onUnhandledRejection);

  return dispose;
}

async function startTransportForMode(
  transportMode: TransportMode,
  deps: MainDependencies,
): Promise<StartedRuntime> {
  switch (transportMode) {
    case 'http':
      return {
        httpResult: await deps.startHttpTransport(deps.createServerInstance, deps.createEventStore),
      };
    case 'web-standard':
      return {
        webStandardResult: await deps.startWebStandardTransport(
          deps.createServerInstance,
          deps.createEventStore,
        ),
      };
    case 'stdio': {
      const stdioInstance = deps.createServerInstance();
      try {
        await stdioInstance.server.connect(deps.createStdioTransport());
      } catch (err) {
        await stdioInstance.close();
        throw err;
      }

      deps.logger.info('system', 'MCP server running on stdio');
      return { stdioInstance };
    }
  }
}

export async function main(deps: MainDependencies = createMainDependencies()): Promise<void> {
  const transportMode = deps.getTransportMode();
  const runtime = await startTransportForMode(transportMode, deps);
  let disposeProcessHandlers: () => void = () => undefined;
  const shutdown = createShutdownHandler(runtime, deps.logger, deps.process, () => {
    disposeProcessHandlers();
    disposeProcessHandlers = () => undefined;
  });
  disposeProcessHandlers = installProcessHandlers(deps.process, shutdown, deps.logger);
}

export async function startCli(deps: MainDependencies = createMainDependencies()): Promise<void> {
  try {
    await main(deps);
  } catch (err) {
    logCriticalAndExit('Failed to start server', err, deps.logger, deps.process);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void startCli();
}
