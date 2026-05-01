import { ProtocolError } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import type {
  ContentListUnion,
  GenerateContentConfig,
  GenerateContentResponse,
} from '@google/genai';

import { buildGenerateContentConfig, getAI } from '../client.js';
import { getGeminiModel } from '../config.js';
import { TOOL_LABELS } from '../public-contract.js';
import { AppError } from './errors.js';
import { logContext, logger, maybeSummarizePayload, mcpLog, type ScopedLogger } from './logger.js';
import {
  buildOrchestrationRequestFromInputs,
  type BuiltInToolSpec,
  type CommonToolInputs,
  type OrchestrationRequest,
  resolveOrchestrationFromRequest,
} from './orchestration.js';
import { ProgressReporter, reportCompletion, reportFailure } from './progress.js';
import {
  buildSharedStructuredMetadata,
  extractTextContent,
  mergeStructured,
  safeValidateStructuredContent,
} from './response.js';
import { executeToolStream, type StreamResult } from './streaming.js';
import { type GeminiRequestPreflight, validateGeminiRequest, validateUrls } from './validation.js';
import { getWorkSignal } from './work-signal.js';

type ToolLabelKey = keyof typeof TOOL_LABELS;

interface ToolContextValidationOptions {
  urls?: readonly string[] | undefined;
  geminiRequest?: GeminiRequestPreflight | undefined;
}

export function createToolContext(toolKey: ToolLabelKey, ctx: ServerContext) {
  return {
    progress: new ProgressReporter(ctx, TOOL_LABELS[toolKey]),
    validateInputs(options: ToolContextValidationOptions = {}): CallToolResult | undefined {
      const invalidUrlResult = validateUrls(options.urls);
      if (invalidUrlResult) {
        return invalidUrlResult;
      }

      if (options.geminiRequest) {
        return validateGeminiRequest(options.geminiRequest);
      }

      return undefined;
    },
    validateOutput(
      outputSchema: unknown,
      structuredContent: unknown,
      result: CallToolResult,
      toolName = toolKey,
    ): CallToolResult {
      return safeValidateStructuredContent(toolName, outputSchema, structuredContent, result);
    },
  };
}

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

function getStructuredWarnings(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('warnings' in value)) {
    return [];
  }

  const warnings = (value as { warnings?: unknown }).warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function mergeDiagnostics(
  values: readonly (Record<string, unknown> | undefined)[],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const diagnostics = (value as { diagnostics?: unknown }).diagnostics;
    if (!diagnostics || typeof diagnostics !== 'object') continue;
    merged = { ...(merged ?? {}), ...(diagnostics as Record<string, unknown>) };
  }
  return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

function appendWarningsToContent(
  content: CallToolResult['content'],
  warnings: readonly string[],
): CallToolResult['content'] {
  if (warnings.length === 0) {
    return content;
  }

  return [
    ...content,
    {
      type: 'text',
      text: `Warnings:\n${warnings.map((warning) => `- ${warning}`).join('\n')}`,
    },
  ];
}

interface GeminiPipelineRequest<T extends Record<string, unknown>> {
  toolName: string;
  label: string;
  cacheName?: string | undefined;
  commonInputs?: CommonToolInputs | undefined;
  builtInToolSpecs?: readonly BuiltInToolSpec[] | undefined;
  buildContents: (activeCapabilities: Set<string>) => {
    contents: ContentListUnion;
    systemInstruction?: string | undefined;
  };
  config: Omit<GeminiStreamRequest<T>['config'], 'cacheName'>;
  responseBuilder?: StreamResponseBuilder<T>;
}

class ToolExecutor {
  constructor(private readonly scopedLogger: ScopedLogger) {}

  private finalizeStreamExecution<T extends Record<string, unknown>>(
    result: CallToolResult,
    streamResult: StreamResult,
    responseBuilder: StreamResponseBuilder<T>,
  ): { result: CallToolResult; reportMessage?: string | undefined } {
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
    const baseStructuredContent =
      result.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : undefined;
    const sharedStructuredContent = buildSharedStructuredMetadata({
      ...(streamResult.warnings ? { warnings: streamResult.warnings } : {}),
    });
    const mergedWarnings = [
      ...getStructuredWarnings(baseStructuredContent),
      ...getStructuredWarnings(overlayStructuredContent),
      ...getStructuredWarnings(built.structuredContent),
      ...getStructuredWarnings(sharedStructuredContent),
    ];
    const finalResult: CallToolResult = {
      ...result,
      ...resultOverlay,
      content: appendWarningsToContent(
        resultOverlay.content ?? result.content,
        streamResult.warnings ?? [],
      ),
    };

    const mergedDiagnostics = mergeDiagnostics([
      overlayStructuredContent,
      built.structuredContent,
      sharedStructuredContent as Record<string, unknown>,
    ]);
    const mergedResult = mergeStructured(
      {
        ...finalResult,
        ...(baseStructuredContent ? { structuredContent: baseStructuredContent } : {}),
      },
      baseStructuredContent || overlayStructuredContent || built.structuredContent
        ? {
            ...(overlayStructuredContent ?? {}),
            ...(built.structuredContent ?? {}),
            ...sharedStructuredContent,
            ...(mergedDiagnostics ? { diagnostics: mergedDiagnostics } : {}),
          }
        : undefined,
      mergedWarnings.length > 0 ? { warnings: mergedWarnings } : undefined,
    );

    return {
      result: mergedResult,
      reportMessage: built.reportMessage,
    };
  }

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
        return this.finalizeStreamExecution(result, streamResult, responseBuilder);
      },
      true,
    );
  }

  async runGeminiStream<T extends Record<string, unknown>>(
    ctx: ServerContext,
    request: GeminiStreamRequest<T>,
  ): Promise<CallToolResult> {
    return await this.executeWithTracing(
      ctx,
      request.toolName,
      request.label,
      'stream',
      undefined,
      async () => {
        const resolved = await resolveOrchestrationFromRequest(
          request.orchestration,
          ctx,
          request.toolName,
        );
        if (resolved.error) {
          return { result: resolved.error };
        }

        const fileSearchStoreNames = request.orchestration.builtInToolSpecs
          ?.filter(
            (spec): spec is Extract<BuiltInToolSpec, { kind: 'fileSearch' }> =>
              spec.kind === 'fileSearch',
          )
          .flatMap((spec) => spec.fileSearchStoreNames);
        const preflightError = validateGeminiRequest({
          activeCapabilities: resolved.config.activeCapabilities,
          responseSchema: request.config.responseSchema,
          jsonMode: request.config.jsonMode,
          fileSearchStoreNames,
        });
        if (preflightError) {
          return { result: preflightError };
        }

        const { contents, systemInstruction } = request.buildContents(
          resolved.config.activeCapabilities,
        );

        const streamGenerator = () =>
          getAI().models.generateContentStream({
            model: getGeminiModel(),
            contents,
            config: buildGenerateContentConfig(
              {
                systemInstruction,
                ...request.config,
                functionCallingMode: resolved.config.functionCallingMode,
                tools: resolved.config.tools,
                toolConfig: resolved.config.toolConfig,
              },
              getWorkSignal(ctx),
            ),
          });
        const { streamResult, result } = await executeToolStream(
          ctx,
          request.toolName,
          request.label,
          streamGenerator,
          getWorkSignal(ctx),
        );
        return this.finalizeStreamExecution(
          result,
          streamResult,
          request.responseBuilder ?? (() => ({})),
        );
      },
      true,
    );
  }

  async executeGeminiPipeline<T extends Record<string, unknown>>(
    ctx: ServerContext,
    request: GeminiPipelineRequest<T>,
  ): Promise<CallToolResult> {
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
        cacheName: request.cacheName,
      },
      ...(request.responseBuilder ? { responseBuilder: request.responseBuilder } : {}),
    });
  }
}

export const executor = new ToolExecutor(logger.child('executor'));
