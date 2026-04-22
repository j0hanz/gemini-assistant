import { ProtocolError } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import { EXPOSE_THOUGHTS } from '../client.js';
import { AppError } from './errors.js';
import { logContext, logger, maybeSummarizePayload, type ScopedLogger } from './logger.js';
import { reportCompletion, reportFailure } from './progress.js';
import { buildSharedStructuredMetadata, extractTextContent } from './response.js';
import { executeToolStream, extractUsage, type StreamResult } from './streaming.js';

type StreamResponseBuilder<T extends Record<string, unknown>> = (
  streamResult: StreamResult,
  text: string,
) => {
  resultMod?: (result: CallToolResult) => Partial<CallToolResult>;
  structuredContent?: T;
  reportMessage?: string;
};

interface ExecutionOptions {
  reportTerminalProgress?: boolean;
}

export class ToolExecutor {
  constructor(private readonly scopedLogger: ScopedLogger) {}

  private async executeWithTracing(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    mode: 'sync' | 'stream',
    args: unknown,
    work: () => Promise<{ result: CallToolResult; reportMessage?: string | undefined }>,
    options: ExecutionOptions = {},
  ): Promise<CallToolResult> {
    const traceId = randomUUID();
    return await logContext.run(traceId, async () => {
      const startTime = performance.now();
      const isStream = mode === 'stream';
      const modeField = isStream ? 'stream' : undefined;
      const argsField = isStream
        ? undefined
        : maybeSummarizePayload(args, this.scopedLogger.getVerbosePayloads());
      const reportProgress = options.reportTerminalProgress !== false;

      this.scopedLogger.info('Execution started', {
        toolName,
        mode: modeField,
        args: argsField,
      });

      try {
        const { result, reportMessage } = await work();
        const durationMs = performance.now() - startTime;

        this.scopedLogger.info('Execution completed', {
          toolName,
          mode: modeField,
          durationMs,
          result: maybeSummarizePayload(result, this.scopedLogger.getVerbosePayloads()),
        });

        if (reportProgress) {
          if (result.isError) {
            await reportFailure(ctx, toolLabel, extractTextContent(result.content));
          } else {
            await reportCompletion(ctx, toolLabel, reportMessage ?? 'completed');
          }
        }

        return result;
      } catch (err) {
        if (err instanceof ProtocolError) {
          throw err;
        }

        const durationMs = performance.now() - startTime;
        const appError = AppError.from(err, toolName);

        this.scopedLogger.error('Execution failed', {
          toolName,
          mode: modeField,
          durationMs,
          error: appError.message,
          stack: err instanceof Error ? err.stack : undefined,
          args: argsField,
        });

        if (reportProgress) {
          await reportFailure(ctx, toolLabel, appError.message);
        }
        return appError.toToolResult();
      }
    });
  }

  async run<TArgs>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    args: TArgs,
    work: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
    options?: ExecutionOptions,
  ): Promise<CallToolResult> {
    return this.executeWithTracing(
      ctx,
      toolName,
      toolLabel,
      'sync',
      args,
      async () => {
        const result = await work(args, ctx);
        return { result };
      },
      options,
    );
  }

  async runStream<T extends Record<string, unknown>>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    streamGenerator: () => Promise<AsyncGenerator<import('@google/genai').GenerateContentResponse>>,
    responseBuilder: StreamResponseBuilder<T> = () => ({}),
    options?: ExecutionOptions,
  ): Promise<CallToolResult> {
    return this.executeWithTracing(
      ctx,
      toolName,
      toolLabel,
      'stream',
      undefined,
      async () => {
        const { streamResult, result } = await executeToolStream(
          ctx,
          toolName,
          toolLabel,
          streamGenerator,
        );
        if (result.isError) {
          return { result };
        }

        const text = extractTextContent(result.content);
        const built = responseBuilder(streamResult, text);
        const finalResult: CallToolResult = {
          ...result,
          ...(built.resultMod ? built.resultMod(result) : {}),
        };

        const usage = extractUsage(streamResult.usageMetadata);
        const existingStructuredContent =
          finalResult.structuredContent && typeof finalResult.structuredContent === 'object'
            ? finalResult.structuredContent
            : undefined;

        const mergedStructuredContent =
          existingStructuredContent || built.structuredContent
            ? {
                ...(existingStructuredContent ?? {}),
                ...(built.structuredContent ?? {}),
                ...buildSharedStructuredMetadata({
                  functionCalls: streamResult.functionCalls,
                  includeThoughts: EXPOSE_THOUGHTS,
                  thoughtText: streamResult.thoughtText,
                  toolEvents: streamResult.toolEvents,
                  usage,
                }),
              }
            : undefined;

        const mergedResult: CallToolResult = {
          ...finalResult,
          ...(mergedStructuredContent ? { structuredContent: mergedStructuredContent } : {}),
        };

        return { result: mergedResult, reportMessage: built.reportMessage };
      },
      options,
    );
  }
}

export const executor = new ToolExecutor(logger.child('executor'));
