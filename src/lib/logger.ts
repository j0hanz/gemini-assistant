import type { McpServer } from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  traceId?: string;
  context: string;
  message: string;
  data?: unknown;
}

const logContext = new AsyncLocalStorage<string>();

class Logger {
  private server: McpServer | null = null;
  private logStream: ReturnType<typeof createWriteStream>;

  constructor() {
    const logDir = join(process.cwd(), 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logStream = createWriteStream(join(logDir, 'app.log'), { flags: 'a' });
  }

  attachServer(server: McpServer) {
    this.server = server;
  }

  private log(level: LogLevel, context: string, message: string, data?: unknown) {
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

    // Forward to MCP if server is attached
    if (this.server) {
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

      this.server
        .sendLoggingMessage({
          level: mcpLevel,
          logger: context,
          data: entry,
        })
        .catch(() => {
          // Ignore errors sending to client to prevent infinite loops
        });
    }
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

export const logger = new Logger();

/**
 * Higher Order Function to automatically instrument tools with structured logging,
 * execution timing, and trace IDs.
 */
export function withToolLogging<TArgs, TResult>(
  toolName: string,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    const traceId = randomUUID();
    return logContext.run(traceId, async () => {
      logger.info(toolName, 'Execution started', { args });
      const startTime = performance.now();

      try {
        const result = await handler(args);
        const durationMs = performance.now() - startTime;
        logger.info(toolName, 'Execution completed successfully', { durationMs, result });
        return result;
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error(toolName, 'Execution failed', {
          durationMs,
          error: errorMessage,
          stack: errorStack,
        });
        throw error; // Rethrow to let MCP framework handle the tool error
      }
    });
  };
}
