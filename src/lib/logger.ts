import type { McpServer } from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { getVerbosePayloadLogging } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
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

export class Logger {
  private readonly attachedServers = new Set<McpServer>();
  private readonly logStream: Pick<Writable, 'write'>;
  private readonly verbosePayloads: boolean;

  constructor(options: LoggerOptions = {}) {
    this.verbosePayloads = options.verbosePayloads ?? getVerbosePayloadLogging();

    if (options.logStream) {
      this.logStream = options.logStream;
    } else {
      const logDir = join(process.cwd(), 'logs');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      this.logStream = createWriteStream(join(logDir, 'app.log'), { flags: 'a' });
    }
  }

  attachServer(server: McpServer): () => void {
    this.attachedServers.add(server);
    return () => {
      this.attachedServers.delete(server);
    };
  }

  protected log(level: LogLevel, context: string, message: string, data?: unknown) {
    const traceId = logContext.getStore();
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      ...(traceId ? { traceId } : {}),
      context,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    const logString = JSON.stringify(entry);

    // Write to disk
    this.logStream.write(logString + '\n');

    if (this.attachedServers.size > 0) {
      const connectedServers = [...this.attachedServers].filter((server) => {
        const connected = server.isConnected();
        if (!connected) {
          this.attachedServers.delete(server);
        }
        return connected;
      });

      if (connectedServers.length === 0) {
        return;
      }

      let mcpLevel:
        | 'debug'
        | 'info'
        | 'warning'
        | 'error'
        | 'critical'
        | 'alert'
        | 'emergency'
        | 'notice' = 'info';
      switch (level) {
        case 'debug':
          mcpLevel = 'debug';
          break;
        case 'info':
          mcpLevel = 'info';
          break;
        case 'warn':
          mcpLevel = 'warning';
          break;
        case 'error':
          mcpLevel = 'error';
          break;
        case 'fatal':
          mcpLevel = 'critical';
          break;
      }

      void Promise.allSettled(
        connectedServers.map((server) =>
          server.sendLoggingMessage({
            level: mcpLevel,
            logger: context,
            data: entry,
          }),
        ),
      );
    }
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
