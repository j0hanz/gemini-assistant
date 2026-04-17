import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import { EXPOSE_THOUGHTS } from '../client.js';
import { AppError, reportCompletion, reportFailure } from './errors.js';
import { logContext, logger, maybeSummarizePayload, type ScopedLogger } from './logger.js';
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

  async run<TArgs>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    args: TArgs,
    work: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const traceId = randomUUID();
    return await logContext.run(traceId, async () => {
      const startTime = performance.now();
      this.scopedLogger.info('Execution started', {
        toolName,
        args: maybeSummarizePayload(args, this.scopedLogger.getVerbosePayloads()),
      });

      try {
        const result = await work(args, ctx);
        const durationMs = performance.now() - startTime;

        this.scopedLogger.info('Execution completed', {
          toolName,
          durationMs,
          result: maybeSummarizePayload(result, this.scopedLogger.getVerbosePayloads()),
        });

        if (result.isError) {
          await reportFailure(ctx, toolLabel, extractTextContent(result.content));
        } else {
          await reportCompletion(ctx, toolLabel, 'completed');
        }

        return result;
      } catch (err) {
        const durationMs = performance.now() - startTime;
        const appError = AppError.from(err, toolName);
        this.scopedLogger.error('Execution failed', {
          toolName,
          durationMs,
          error: appError.message,
          stack: err instanceof Error ? err.stack : undefined,
          args: maybeSummarizePayload(args, this.scopedLogger.getVerbosePayloads()),
        });
        await reportFailure(ctx, toolLabel, appError.message);
        return appError.toToolResult();
      }
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
    const traceId = randomUUID();
    return await logContext.run(traceId, async () => {
      const startTime = performance.now();
      this.scopedLogger.info('Execution started', { toolName, mode: 'stream' });

      try {
        const { streamResult, result } = await executeToolStream(
          ctx,
          toolName,
          toolLabel,
          streamGenerator,
        );
        if (result.isError) {
          await reportFailure(ctx, toolLabel, extractTextContent(result.content));
          return result;
        }

        const text = extractTextContent(result.content);
        const built = responseBuilder(streamResult, text);
        const finalResult: CallToolResult = {
          ...result,
          ...(built.resultMod ? built.resultMod(result) : {}),
        };

        if (finalResult.isError) {
          await reportFailure(ctx, toolLabel, extractTextContent(finalResult.content));
        } else {
          await reportCompletion(ctx, toolLabel, built.reportMessage ?? 'completed');
        }

        const usage = extractUsage(streamResult.usageMetadata);
        const mergedResult: CallToolResult = {
          ...finalResult,
          structuredContent: {
            ...(finalResult.structuredContent && typeof finalResult.structuredContent === 'object'
              ? (finalResult.structuredContent as Record<string, unknown>)
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

        this.scopedLogger.info('Execution completed', {
          toolName,
          mode: 'stream',
          durationMs: performance.now() - startTime,
          result: maybeSummarizePayload(mergedResult, this.scopedLogger.getVerbosePayloads()),
        });

        return mergedResult;
      } catch (err) {
        const durationMs = performance.now() - startTime;
        const appError = AppError.from(err, toolName);
        this.scopedLogger.error('Execution failed', {
          toolName,
          mode: 'stream',
          durationMs,
          error: appError.message,
          stack: err instanceof Error ? err.stack : undefined,
        });
        await reportFailure(ctx, toolLabel, appError.message);
        return appError.toToolResult();
      }
    });
  }
}

export const executor = new ToolExecutor(logger.child('executor'));
