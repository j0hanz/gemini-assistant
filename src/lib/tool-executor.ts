import { ProtocolError } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import type {
  ContentListUnion,
  GenerateContentConfig,
  GenerateContentResponse,
} from '@google/genai';

import { buildGenerateContentConfig, getAI } from '../client.js';
import { getExposeThoughts, getGeminiModel } from '../config.js';
import { AppError } from './errors.js';
import { logContext, logger, maybeSummarizePayload, mcpLog, type ScopedLogger } from './logger.js';
import {
  buildOrchestrationRequestFromInputs,
  type BuiltInToolSpec,
  type CommonToolInputs,
  type OrchestrationRequest,
  resolveOrchestration,
} from './orchestration.js';
import { ProgressReporter, reportCompletion, reportFailure } from './progress.js';
import { buildSharedStructuredMetadata, extractTextContent } from './response.js';
import { executeToolStream, extractUsage, type StreamResult } from './streaming.js';
import { getWorkSignal } from './work-signal.js';
import { getWorkspaceCacheName, type WorkspaceCacheManagerImpl } from './workspace-context.js';

type StreamResponseBuilder<T extends Record<string, unknown>> = (
  streamResult: StreamResult,
  text: string,
) => {
  resultMod?: (result: CallToolResult) => Partial<CallToolResult>;
  structuredContent?: T;
  reportMessage?: string;
};

type GeminiGenerationConfigFields = Omit<
  Parameters<typeof buildGenerateContentConfig>[0],
  'functionCallingMode' | 'systemInstruction' | 'toolConfig' | 'tools'
>;

interface GeminiStreamRequest<T extends Record<string, unknown>> {
  buildContents: (activeCapabilities: Set<string>) => {
    contents: ContentListUnion;
    systemInstruction?: string | undefined;
  };
  config: GeminiGenerationConfigFields & {
    mediaResolution?: GenerateContentConfig['mediaResolution'] | undefined;
  };
  label: string;
  orchestration: OrchestrationRequest;
  responseBuilder?: StreamResponseBuilder<T>;
  toolName: string;
}

export interface GeminiPipelineRequest<T extends Record<string, unknown>> {
  toolName: string;
  label: string;
  commonInputs?: CommonToolInputs | undefined;
  builtInToolSpecs?: readonly BuiltInToolSpec[] | undefined;
  workspaceCacheManager: WorkspaceCacheManagerImpl;
  buildContents: (activeCapabilities: Set<string>) => {
    contents: ContentListUnion;
    systemInstruction?: string | undefined;
  };
  config: Omit<GeminiStreamRequest<T>['config'], 'cacheName'>;
  responseBuilder?: StreamResponseBuilder<T>;
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

  async runWithProgress<T extends Record<string, unknown>>(
    ctx: ServerContext,
    options: {
      toolKey: string;
      label: string;
      initialMsg: string;
      logMessage?: string;
      logData?: unknown;
      generator: () => Promise<AsyncGenerator<GenerateContentResponse>>;
      responseBuilder?: StreamResponseBuilder<T>;
    },
  ): Promise<CallToolResult> {
    const progress = new ProgressReporter(ctx, options.label);
    await progress.send(0, undefined, options.initialMsg);
    if (options.logMessage !== undefined) {
      await mcpLog(ctx, 'info', options.logMessage);
      this.scopedLogger.info(
        options.logMessage,
        maybeSummarizePayload(options.logData, this.scopedLogger.getVerbosePayloads()),
      );
    }
    return this.runStream(
      ctx,
      options.toolKey,
      options.label,
      options.generator,
      options.responseBuilder,
    );
  }

  async runStream<T extends Record<string, unknown>>(
    ctx: ServerContext,
    toolName: string,
    toolLabel: string,
    streamGenerator: () => Promise<AsyncGenerator<GenerateContentResponse>>,
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
          getWorkSignal(ctx),
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
                  includeThoughts: getExposeThoughts(),
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

  async runGeminiStream<T extends Record<string, unknown>>(
    ctx: ServerContext,
    request: GeminiStreamRequest<T>,
  ): Promise<CallToolResult> {
    const resolved = await resolveOrchestration(request.orchestration, ctx, request.toolName);
    if (resolved.error) return resolved.error;

    const { contents, systemInstruction } = request.buildContents(
      resolved.config.activeCapabilities,
    );

    return await this.runStream(
      ctx,
      request.toolName,
      request.label,
      () =>
        getAI().models.generateContentStream({
          model: getGeminiModel(),
          contents,
          config: buildGenerateContentConfig(
            {
              systemInstruction,
              ...request.config,
              tools: resolved.config.tools,
              toolConfig: resolved.config.toolConfig,
            },
            getWorkSignal(ctx),
          ),
        }),
      request.responseBuilder,
    );
  }

  async executeGeminiPipeline<T extends Record<string, unknown>>(
    ctx: ServerContext,
    request: GeminiPipelineRequest<T>,
  ): Promise<CallToolResult> {
    const cacheName = await getWorkspaceCacheName(ctx, request.workspaceCacheManager);

    const baseOrchestration = buildOrchestrationRequestFromInputs(request.commonInputs ?? {});
    const mergedSpecs: BuiltInToolSpec[] = [
      ...(baseOrchestration.builtInToolSpecs ?? []),
      ...(request.builtInToolSpecs ?? []),
    ];

    const orchestration: OrchestrationRequest = {
      ...baseOrchestration,
      builtInToolSpecs: mergedSpecs,
    };

    return await this.runGeminiStream(ctx, {
      toolName: request.toolName,
      label: request.label,
      orchestration,
      buildContents: request.buildContents,
      config: {
        ...request.config,
        cacheName,
      },
      ...(request.responseBuilder ? { responseBuilder: request.responseBuilder } : {}),
    });
  }
}

export const executor = new ToolExecutor(logger.child('executor'));
