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
  ): Promise<CallToolResult> {
    const traceId = randomUUID();
    return await logContext.run(traceId, async () => {
      const startTime = performance.now();
      const isStream = mode === 'stream';
      this.scopedLogger.info('Execution started', {
        toolName,
        mode: isStream ? 'stream' : undefined,
        args: isStream
          ? undefined
          : maybeSummarizePayload(args, this.scopedLogger.getVerbosePayloads()),
      });

      try {
        const { result, reportMessage } = await work();
        const durationMs = performance.now() - startTime;

        this.scopedLogger.info('Execution completed', {
          toolName,
          mode: isStream ? 'stream' : undefined,
          durationMs,
          result: maybeSummarizePayload(result, this.scopedLogger.getVerbosePayloads()),
        });

        if (result.isError) {
          await reportFailure(ctx, toolLabel, extractTextContent(result.content));
        } else {
          await reportCompletion(ctx, toolLabel, reportMessage ?? 'completed');
        }

        return result;
      } catch (err) {
        const durationMs = performance.now() - startTime;
        const appError = AppError.from(err, toolName);
        this.scopedLogger.error('Execution failed', {
          toolName,
          mode: isStream ? 'stream' : undefined,
          durationMs,
          error: appError.message,
          stack: err instanceof Error ? err.stack : undefined,
          args: isStream
            ? undefined
            : maybeSummarizePayload(args, this.scopedLogger.getVerbosePayloads()),
        });
        await reportFailure(ctx, toolLabel, appError.message);
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
    return this.executeWithTracing(ctx, toolName, toolLabel, 'sync', args, async () => {
      const result = await work(args, ctx);
      return { result };
    });
  }

  async runStream<T extends Record<string, unknown>>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    streamGenerator: () => Promise<AsyncGenerator<import('@google/genai').GenerateContentResponse>>,
    responseBuilder: StreamResponseBuilder<T> = (_streamResult, text) => ({
      structuredContent: { answer: text } as unknown as T,
    }),
  ): Promise<CallToolResult> {
    return this.executeWithTracing(ctx, toolName, toolLabel, 'stream', undefined, async () => {
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
      const mergedResult: CallToolResult = {
        ...finalResult,
        structuredContent: {
          ...(finalResult.structuredContent && typeof finalResult.structuredContent === 'object'
            ? finalResult.structuredContent
            : {}),
          ...(built.structuredContent ?? {}),
          ...buildSharedStructuredMetadata({
            functionCalls: streamResult.functionCalls,
            includeThoughts: EXPOSE_THOUGHTS,
            thoughtText: streamResult.thoughtText,
            toolEvents: streamResult.toolEvents,
            usage,
          }),
        },
      };

      return { result: mergedResult, reportMessage: built.reportMessage };
    });
  }
}

export const executor = new ToolExecutor(logger.child('executor'));
