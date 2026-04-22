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

export class ToolExecutor {
  constructor(private readonly scopedLogger: ScopedLogger) {}

  private async executeWithTracing(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    mode: 'sync' | 'stream',
    args: unknown,
    work: () => Promise<{ result: CallToolResult; reportMessage?: string | undefined }>,
    reportTerminalProgress: boolean,
  ): Promise<CallToolResult> {
    const traceId = randomUUID();
    return await logContext.run(traceId, async () => {
      const startTime = performance.now();
      const isStream = mode === 'stream';
      const modeField = isStream ? 'stream' : undefined;
      const argsField = isStream
        ? undefined
        : maybeSummarizePayload(args, this.scopedLogger.getVerbosePayloads());

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

        if (reportTerminalProgress) {
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

        if (reportTerminalProgress) {
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
  ): Promise<CallToolResult> {
    return this.runInternalSync(ctx, toolName, toolLabel, args, work, true);
  }

  async runSilent<TArgs>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    args: TArgs,
    work: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    return this.runInternalSync(ctx, toolName, toolLabel, args, work, false);
  }

  private async runInternalSync<TArgs>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    args: TArgs,
    work: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
    reportTerminalProgress: boolean,
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
      reportTerminalProgress,
    );
  }

  async runStream<T extends Record<string, unknown>>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    streamGenerator: () => Promise<AsyncGenerator<import('@google/genai').GenerateContentResponse>>,
    responseBuilder: StreamResponseBuilder<T> = () => ({}),
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
        const resultOverlay = built.resultMod ? built.resultMod(result) : {};
        const overlayStructuredContent =
          resultOverlay.structuredContent && typeof resultOverlay.structuredContent === 'object'
            ? resultOverlay.structuredContent
            : undefined;
        const finalResult: CallToolResult = {
          ...result,
          ...resultOverlay,
        };

        const usage = extractUsage(streamResult.usageMetadata);
        const baseStructuredContent =
          result.structuredContent && typeof result.structuredContent === 'object'
            ? result.structuredContent
            : undefined;

        const mergedStructuredContent =
          baseStructuredContent || overlayStructuredContent || built.structuredContent
            ? {
                ...(baseStructuredContent ?? {}),
                ...(overlayStructuredContent ?? {}),
                ...(built.structuredContent ?? {}),
                ...buildSharedStructuredMetadata({
                  functionCalls: streamResult.functionCalls,
                  includeThoughts: EXPOSE_THOUGHTS,
                  thoughtText: streamResult.thoughtText,
                  toolEvents: streamResult.toolEvents,
                  usage,
                  safetyRatings: streamResult.safetyRatings,
                  finishMessage: streamResult.finishMessage,
                  citationMetadata: streamResult.citationMetadata,
                }),
              }
            : undefined;

        const mergedResult: CallToolResult = {
          ...finalResult,
          ...(mergedStructuredContent ? { structuredContent: mergedStructuredContent } : {}),
        };

        return { result: mergedResult, reportMessage: built.reportMessage };
      },
      true,
    );
  }
}

export const executor = new ToolExecutor(logger.child('executor'));
