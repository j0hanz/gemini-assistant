import type { McpServer } from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { getVerbosePayloadLogging } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type McpLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

const MCP_LEVEL_MAP: Record<LogLevel, McpLogLevel> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'critical',
};

const MAX_SUMMARY_DEPTH = 2;
const MAX_SUMMARY_KEYS = 20;

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  traceId?: string;
  context: string;
  message: string;
  data?: unknown;
}

export const logContext = new AsyncLocalStorage<string>();

interface LoggerOptions {
  logStream?: Pick<Writable, 'write'>;
  verbosePayloads?: boolean;
}

function formatLogLine(entry: LogEntry): string {
  return JSON.stringify(entry) + '\n';
}

export function summarizeLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return { type: 'string', length: value.length };
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }

  if (typeof value === 'object') {
    if (depth >= MAX_SUMMARY_DEPTH) {
      return { type: 'truncated' };
    }

    return {
      type: 'object',
      keys: Object.keys(value).sort().slice(0, MAX_SUMMARY_KEYS),
    };
  }

  return { type: typeof value };
}

export function maybeSummarizePayload(value: unknown, verbosePayloads: boolean): unknown {
  return verbosePayloads ? value : summarizeLogValue(value);
}

function isNodeTestProcess(): boolean {
  return process.execArgv.includes('--test');
}

function defaultLogFileName(): string {
  return isNodeTestProcess() ? 'test-app.log' : 'app.log';
}

export class Logger {
  private readonly attachedServers = new Set<McpServer>();
  private readonly verbosePayloads: boolean;
  private logStream: Pick<Writable, 'write'> | undefined;
  private logStreamInitialized = false;
  private fileSinkErrorHandled = false;

  constructor(options: LoggerOptions = {}) {
    this.verbosePayloads = options.verbosePayloads ?? getVerbosePayloadLogging();

    if (options.logStream) {
      this.logStream = options.logStream;
      this.logStreamInitialized = true;
    }
  }

  attachServer(server: McpServer): () => void {
    this.attachedServers.add(server);
    return () => {
      this.attachedServers.delete(server);
    };
  }

  protected log(level: LogLevel, context: string, message: string, data?: unknown) {
    const entry = this.buildEntry(level, context, message, data);
    this.writeEntry(entry);
    this.broadcastToServers(level, context, entry);
  }

  private buildEntry(level: LogLevel, context: string, message: string, data?: unknown): LogEntry {
    const traceId = logContext.getStore();
    return {
      timestamp: new Date().toISOString(),
      level,
      ...(traceId ? { traceId } : {}),
      context,
      message,
      ...(data !== undefined ? { data } : {}),
    };
  }

  private writeEntry(entry: LogEntry): void {
    this.ensureLogStream().write(formatLogLine(entry));
  }

  private ensureLogStream(): Pick<Writable, 'write'> {
    if (this.logStreamInitialized && this.logStream) {
      return this.logStream;
    }

    this.logStreamInitialized = true;

    try {
      const logDir = join(process.cwd(), 'logs');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      const stream = createWriteStream(join(logDir, defaultLogFileName()), { flags: 'a' });
      stream.once('error', (error) => {
        if (this.fileSinkErrorHandled) {
          return;
        }

        this.fileSinkErrorHandled = true;
        this.logStream = process.stderr;
        this.writeLocalOnly(
          'warn',
          'logger',
          'log file sink failed; falling back to stderr',
          {
            error: error instanceof Error ? error.message : String(error),
          },
          process.stderr,
        );
      });
      this.logStream = stream;
      return stream;
    } catch (error) {
      this.logStream = process.stderr;
      this.fileSinkErrorHandled = true;
      this.writeLocalOnly(
        'warn',
        'logger',
        'log file sink unavailable; falling back to stderr',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        process.stderr,
      );
      return process.stderr;
    }
  }

  private writeLocalOnly(
    level: LogLevel,
    context: string,
    message: string,
    data?: unknown,
    stream: Pick<Writable, 'write'> = this.ensureLogStream(),
  ): void {
    const entry = this.buildEntry(level, context, message, data);
    stream.write(formatLogLine(entry));
  }

  private broadcastToServers(level: LogLevel, context: string, entry: LogEntry): void {
    if (this.attachedServers.size === 0) return;

    const connectedServers: McpServer[] = [];
    for (const server of this.attachedServers) {
      if (server.isConnected()) {
        connectedServers.push(server);
      } else {
        this.attachedServers.delete(server);
      }
    }

    if (connectedServers.length === 0) return;

    const mcpLevel = MCP_LEVEL_MAP[level];
    void Promise.allSettled(
      connectedServers.map((server) =>
        server.sendLoggingMessage({
          level: mcpLevel,
          logger: context,
          data: entry,
        }),
      ),
    ).then((results) => {
      const count = results.filter((result) => result.status === 'rejected').length;
      if (count > 0) {
        this.writeLocalOnly('warn', 'logger', `broadcast to ${count} server(s) failed`, { count });
      }
    });
  }

  getVerbosePayloads(): boolean {
    return this.verbosePayloads;
  }

  write(level: LogLevel, context: string, message: string, data?: unknown) {
    this.log(level, context, message, data);
  }

  child(context: string): ScopedLogger {
    return new ScopedLogger(this, context);
  }

  debug(context: string, message: string, data?: unknown) {
    this.log('debug', context, message, data);
  }
  info(context: string, message: string, data?: unknown) {
    this.log('info', context, message, data);
  }
  warn(context: string, message: string, data?: unknown) {
    this.log('warn', context, message, data);
  }
  error(context: string, message: string, data?: unknown) {
    this.log('error', context, message, data);
  }
  fatal(context: string, message: string, data?: unknown) {
    this.log('fatal', context, message, data);
  }
}

export class ScopedLogger {
  constructor(
    private readonly parent: Logger,
    private readonly context: string,
  ) {}

  getVerbosePayloads(): boolean {
    return this.parent.getVerbosePayloads();
  }

  debug(message: string, data?: unknown) {
    this.parent.write('debug', this.context, message, data);
  }

  info(message: string, data?: unknown) {
    this.parent.write('info', this.context, message, data);
  }

  warn(message: string, data?: unknown) {
    this.parent.write('warn', this.context, message, data);
  }

  error(message: string, data?: unknown) {
    this.parent.write('error', this.context, message, data);
  }

  fatal(message: string, data?: unknown) {
    this.parent.write('fatal', this.context, message, data);
  }
}

export const logger = new Logger();
