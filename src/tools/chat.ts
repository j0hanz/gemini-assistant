import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Validator } from '@cfworker/json-schema';
import { FinishReason } from '@google/genai';
import type {
  Chat,
  FunctionCallingConfigMode,
  FunctionResponse,
  GenerateContentConfig,
  PartListUnion,
} from '@google/genai';

import { AppError } from '../lib/errors.js';
import { buildInteractionParams, consumeInteractionStream } from '../lib/interactions.js';
import { logger } from '../lib/logger.js';
import { appendFunctionCallingInstruction } from '../lib/model-prompts.js';
import { resolveOrchestration } from '../lib/orchestration.js';
import {
  buildBaseStructuredOutput,
  buildStructuredResponse,
  createResourceLink,
  extractTextContent,
  mergeStructured,
  pickDefined,
  readStructuredObject,
  tryParseJsonResponse,
  withRelatedTaskMeta,
} from '../lib/response.js';
import {
  extractUsage,
  type FunctionCallEntry,
  type StreamResult,
  type ToolEvent,
} from '../lib/streaming.js';
import { getTaskEmitter, MUTABLE_ANNOTATIONS, registerWorkTool } from '../lib/tasks.js';
import {
  buildContextUsed,
  emptyContextUsed,
  type ToolServices,
  type ToolWorkspaceAccess,
} from '../lib/tool-context.js';
import { createToolContext, executor } from '../lib/tool-executor.js';
import {
  ProfileValidationError,
  type ResolvedProfile,
  resolveProfile,
  validateProfile,
} from '../lib/tool-profiles.js';
import {
  type ChatInput,
  createChatInputSchema,
  parseResponseSchemaJsonValue,
} from '../schemas/inputs.js';
import type { GeminiResponseSchema } from '../schemas/inputs.js';
import { ChatOutputSchema, type ContextUsed, type UsageMetadata } from '../schemas/outputs.js';

import { buildGenerateContentConfig, getAI } from '../client.js';
import {
  getExposeSessionResources,
  getExposeThoughts,
  getGeminiModel,
  getStatelessTransportFlag,
  getWorkspaceCacheEnabled,
} from '../config.js';
import { TOOL_LABELS } from '../public-contract.js';
import { appendResourceLinks } from '../resources/index.js';
import {
  sessionEventsUri,
  sessionResourceUri,
  sessionTranscriptUri,
  turnPartsUri,
} from '../resources/uris.js';
import type {
  SessionAccess,
  SessionEventEntry,
  SessionSummary,
  TranscriptEntry,
} from '../sessions.js';

type InternalAskArgs = Omit<ChatInput, 'goal' | 'responseSchemaJson'> & {
  message: string;
  responseSchema?: GeminiResponseSchema;
};

type AskArgs = InternalAskArgs & {
  cacheName?: string;
};

interface AskStructuredContent extends Record<string, unknown> {
  answer: string;
  data?: unknown;
  schemaWarnings?: string[];
  session?: {
    id: string;
  };
  warnings?: string[];
  diagnostics?: {
    thoughts?: string;
    usage?: UsageMetadata;
    finishMessage?: string | undefined;
    safetyRatings?: unknown;
    citationMetadata?: unknown;
    groundingMetadata?: unknown;
    urlContextMetadata?: unknown;
    functionCalls?: FunctionCallEntry[];
    toolEvents?: ToolEvent[];
  };
}

interface AskDependencies {
  appendSessionEvent: (sessionId: string, item: SessionEventEntry) => boolean;
  appendSessionTranscript: (sessionId: string, item: TranscriptEntry) => boolean;
  getSessionEntry: (sessionId: string) => SessionSummary | undefined;
  getSessionInteractionId: (sessionId: string) => string | undefined;
  isEvicted: (sessionId: string) => boolean;
  listSessionTranscriptEntries: (sessionId: string) => TranscriptEntry[] | undefined;
  now: () => number;
  runWithoutSession: (args: AskArgs, ctx: ServerContext) => Promise<AskExecutionResult>;
}

interface AskExecutionResult {
  result: CallToolResult;
  sentMessage?: string;
  streamResult: StreamResult;
  toolProfile: string;
  urls?: string[];
}

const JSON_REPAIR_MAX_RETRIES = 1;
const JSON_REPAIR_WARNING_TEXT_LIMIT = 2_000;

function validateJsonAgainstSchema(data: unknown, schema: GeminiResponseSchema): string[] {
  try {
    const validator = new Validator(schema, '2020-12', false);
    const result = validator.validate(data);
    if (result.valid) return [];
    return result.errors.map((error) => `${error.instanceLocation}: ${error.error}`);
  } catch {
    return ['Schema validation could not be performed'];
  }
}

function buildAskWarnings(
  parsedData: unknown,
  jsonMode: boolean | undefined,
  responseSchema: GeminiResponseSchema | undefined,
): string[] {
  const warnings: string[] = [];

  if (jsonMode && parsedData === undefined) {
    warnings.push('Failed to parse JSON from model response');
  }

  if (parsedData !== undefined && responseSchema) {
    warnings.push(...validateJsonAgainstSchema(parsedData, responseSchema));
  }

  return warnings;
}

function isRetryableSchemaFailure(
  warnings: string[],
  parsedData: unknown,
  jsonMode: boolean | undefined,
): boolean {
  return jsonMode === true && (parsedData === undefined || warnings.length > 0);
}

function buildReducedRepairPrompt(
  originalPrompt: string,
  invalidOutput: string,
  warnings: readonly string[],
): string {
  const warningText = warnings
    .map((warning) => `- ${warning}`)
    .join('\n')
    .slice(0, JSON_REPAIR_WARNING_TEXT_LIMIT);
  const invalidOutputText = invalidOutput.slice(0, 4_000);

  return [
    'Fix the invalid JSON from the previous turn.',
    'Return only valid JSON that matches the provided schema.',
    `User request:\n${originalPrompt}`,
    `Validation errors:\n${warningText}`,
    `Previous output:\n${invalidOutputText}`,
  ].join('\n\n');
}

function appendAskWarnings(result: CallToolResult, warnings: readonly string[]): CallToolResult {
  if (result.isError || warnings.length === 0) {
    return result;
  }

  return mergeStructured(
    result,
    getAskStructuredContent(result)
      ? undefined
      : {
          answer: extractTextContent(result.content),
        },
    { warnings },
  );
}

function buildAskStructuredContent(
  text: string,
  streamResult: Pick<
    StreamResult,
    | 'functionCalls'
    | 'thoughtText'
    | 'toolEvents'
    | 'usageMetadata'
    | 'safetyRatings'
    | 'finishMessage'
    | 'citationMetadata'
    | 'groundingMetadata'
    | 'urlContextMetadata'
    | 'warnings'
  >,
  jsonMode?: boolean,
  responseSchema?: GeminiResponseSchema,
  contextUsed?: ContextUsed,
): AskStructuredContent {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : '';
  const usage = extractUsage(streamResult.usageMetadata);
  const warnings: string[] = [];

  // Fold schema validation warnings into warnings array
  const schemaWarnings = buildAskWarnings(parsedData, jsonMode, responseSchema);
  if (schemaWarnings.length > 0) {
    warnings.push(...schemaWarnings);
  }
  if (streamResult.warnings && streamResult.warnings.length > 0) {
    warnings.push(...streamResult.warnings);
  }

  return buildStructuredResponse(
    pickDefined({
      answer,
      data: parsedData,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    pickDefined({
      contextUsed,
      functionCalls: streamResult.functionCalls,
      includeThoughts: getExposeThoughts(),
      thoughtText: streamResult.thoughtText,
      toolEvents: streamResult.toolEvents,
      usage,
      safetyRatings: streamResult.safetyRatings,
      finishMessage: streamResult.finishMessage,
      citationMetadata: streamResult.citationMetadata,
      groundingMetadata: streamResult.groundingMetadata,
      urlContextMetadata: streamResult.urlContextMetadata,
    }),
  );
}

function formatStructuredResult(
  result: CallToolResult,
  streamResult: Pick<
    StreamResult,
    | 'functionCalls'
    | 'thoughtText'
    | 'toolEvents'
    | 'usageMetadata'
    | 'safetyRatings'
    | 'finishMessage'
    | 'citationMetadata'
  >,
  jsonMode?: boolean,
  responseSchema?: GeminiResponseSchema,
  contextUsed?: ContextUsed,
): CallToolResult {
  if (result.isError) return result;
  const structured = buildAskStructuredContent(
    extractTextContent(result.content),
    streamResult,
    jsonMode,
    responseSchema,
    contextUsed,
  );

  return {
    ...result,
    content: [
      { type: 'text', text: structured.answer },
      ...result.content.filter((content) => content.type !== 'text'),
      ...(Array.isArray(structured.warnings) && structured.warnings.length > 0
        ? [
            {
              type: 'text' as const,
              text: `Warnings:\n${structured.warnings.map((warning) => `- ${warning}`).join('\n')}`,
            },
          ]
        : []),
    ],
    structuredContent: structured,
  };
}

function getAskStructuredContent(result: CallToolResult): AskStructuredContent | undefined {
  return readStructuredObject(result) as AskStructuredContent | undefined;
}

function validateAskConflict(condition: boolean, message: string): CallToolResult | undefined {
  return condition ? new AppError('chat', message).toToolResult() : undefined;
}

function hasExpiredSession(
  sessionId: string | undefined,
  deps: Pick<AskDependencies, 'isEvicted'>,
): boolean {
  return sessionId !== undefined && deps.isEvicted(sessionId);
}

function buildChatResolvedProfile(args: AskArgs): ResolvedProfile {
  return resolveProfile(args.tools, { toolKey: 'chat' });
}

function validateAskRequest(
  args: AskArgs,
  deps: Pick<AskDependencies, 'getSessionEntry' | 'isEvicted'>,
  ctx: ServerContext,
): CallToolResult | undefined {
  const { responseSchema, sessionId } = args;
  if (sessionId !== undefined && getStatelessTransportFlag()) {
    return new AppError(
      'chat',
      'sessionId is unsupported under stateless transport. Omit sessionId or run with TRANSPORT=stdio or STATELESS=false.',
    ).toToolResult();
  }

  const sessionEntry = sessionId ? deps.getSessionEntry(sessionId) : undefined;
  const hasExistingSession = sessionEntry !== undefined;
  const hasFunctionResponses = (args.functionResponses?.length ?? 0) > 0;
  const resolved = buildChatResolvedProfile(args);

  try {
    validateProfile(resolved);
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      return new AppError('chat', error.message).toToolResult();
    }
    throw error;
  }

  const activeCapabilities = new Set([
    ...resolved.builtIns,
    ...((resolved.overrides.functions?.length ?? 0) > 0 ? (['functions'] as const) : []),
  ]);
  const urls = resolved.overrides.urls;
  const inputValidation = createToolContext('chat', ctx).validateInputs({
    urls,
    geminiRequest: {
      hasExistingSession,
      jsonMode: responseSchema !== undefined,
      responseSchema,
      sessionId,
      activeCapabilities,
      fileSearchStoreNames: resolved.overrides.fileSearchStores,
    },
  });
  if (inputValidation) {
    return inputValidation;
  }

  const conflicts: [boolean, string][] = [
    [hasExpiredSession(sessionId, deps), `chat: Session '${sessionId}' has expired.`],
    [
      hasExistingSession && responseSchema !== undefined,
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    ],
    [
      hasFunctionResponses && sessionId !== undefined,
      'chat: functionResponses is not supported with sessionId. Sessions use server-side Interactions API state; function calls are handled server-side.',
    ],
    [
      hasFunctionResponses && responseSchema !== undefined,
      'chat: functionResponses cannot be combined with responseSchemaJson.',
    ],
  ];

  for (const [condition, message] of conflicts) {
    const conflict = validateAskConflict(condition, message);
    if (conflict) {
      return conflict;
    }
  }

  // Contract validation no longer needed; server-side state management via ai.interactions handles compatibility
  return undefined;
}

function buildAskPrompt(message: string, urls?: readonly string[]): string {
  if (!urls || urls.length === 0) {
    return message;
  }

  return `${message}\n\nUse these URLs too:\n${urls.join('\n')}`;
}

function buildChatMessage(prompt: string, functionResponses?: FunctionResponse[]): PartListUnion {
  if (!functionResponses || functionResponses.length === 0) {
    return prompt;
  }

  return [...functionResponses.map((functionResponse) => ({ functionResponse })), { text: prompt }];
}

function normalizeFunctionResponses(
  responses: AskArgs['functionResponses'],
): FunctionResponse[] | undefined {
  if (!responses || responses.length === 0) {
    return undefined;
  }

  return responses.map((response) => ({
    id: response.id,
    name: response.name,
    response: response.response,
  }));
}

async function resolveAskTooling(args: AskArgs, ctx: ServerContext) {
  const resolved = await resolveOrchestration(args.tools, ctx, {
    toolKey: 'chat',
  });
  if (resolved.error) {
    return { error: resolved.error } as const;
  }
  const { functionCallingMode, tools, toolConfig } = resolved.orchestration.geminiParams;
  const usesUrlContext = resolved.orchestration.activeCapabilities.has('urlContext');
  const resolved_profile = buildChatResolvedProfile(args);
  const urls = resolved_profile.overrides.urls;

  // URL Context discovers target URLs from prompt text; keep URLs visible
  // whenever a URL-capable profile is active.
  const promptUrls = usesUrlContext || !tools || tools.length === 0 ? urls : undefined;

  return {
    prompt: buildAskPrompt(args.message, promptUrls),
    toolProfile: buildChatResolvedProfile(args).profile,
    urls: usesUrlContext ? [...(urls ?? [])] : undefined,
    tools,
    toolConfig,
    functionCallingMode,
    serverSideToolInvocations: toolConfig?.includeServerSideToolInvocations === true,
    resolvedProfile: resolved_profile,
  } as const;
}

function buildAskGenerationOptions(
  args: AskArgs,
  toolConfig: GenerateContentConfig['toolConfig'],
  tools: GenerateContentConfig['tools'],
  functionCallingMode: FunctionCallingConfigMode | undefined,
  serverSideToolInvocations: boolean,
  resolvedProfile?: ResolvedProfile,
) {
  const declaredNames =
    resolvedProfile?.overrides.functions?.map((declaration) => declaration.name) ?? [];
  return {
    ...args,
    systemInstruction: appendFunctionCallingInstruction(args.systemInstruction, {
      ...(functionCallingMode !== undefined ? { mode: functionCallingMode } : {}),
      declaredNames,
      serverSideToolInvocations,
    }),
    toolConfig,
    tools,
    ...(functionCallingMode !== undefined ? { functionCallingMode } : {}),
  };
}

async function runAskStream(
  ctx: ServerContext,
  streamGenerator: () => ReturnType<ReturnType<typeof getAI>['models']['generateContentStream']>,
  toolProfile: string,
  urls: string[] | undefined,
  jsonMode = false,
  responseSchema?: GeminiResponseSchema,
): Promise<AskExecutionResult> {
  let capturedStreamResult: StreamResult | undefined;
  const result = await executor.runWithProgress(ctx, {
    toolKey: 'chat',
    label: TOOL_LABELS.chat,
    initialMsg: 'Preparing',
    generator: streamGenerator,
    responseBuilder: (streamResult) => {
      capturedStreamResult = streamResult;
      const hasThoughts = streamResult.thoughtText.length > 0;

      return {
        resultMod: (baseResult) => {
          const formatted = formatStructuredResult(
            baseResult,
            streamResult,
            jsonMode,
            responseSchema,
          );
          return {
            content: formatted.content,
            structuredContent: formatted.structuredContent,
          };
        },
        reportMessage: hasThoughts ? 'completed with reasoning' : 'completed',
      };
    },
  });

  const streamResult =
    capturedStreamResult ??
    ({
      text: '',
      textByWave: [''],
      thoughtText: '',
      parts: [],
      toolsUsed: [],
      toolsUsedOccurrences: [],
      functionCalls: [],
      toolEvents: [],
      hadCandidate: false,
    } satisfies StreamResult);

  return {
    result,
    streamResult,
    toolProfile,
    ...(urls && urls.length > 0 ? { urls } : {}),
  };
}

function appendSessionResource(
  result: CallToolResult,
  sessionId: string,
  turnIndex?: number,
  taskId?: string,
): void {
  if (result.isError) return;
  result.content.push(
    withRelatedTaskMeta(
      createResourceLink(sessionResourceUri(sessionId), `Chat Session ${sessionId}`),
      taskId,
    ),
  );
  if (!getExposeSessionResources()) {
    return;
  }
  result.content.push(
    withRelatedTaskMeta(
      createResourceLink(sessionTranscriptUri(sessionId), `Chat Session ${sessionId} Transcript`),
      taskId,
    ),
  );
  result.content.push(
    withRelatedTaskMeta(
      createResourceLink(sessionEventsUri(sessionId), `Chat Session ${sessionId} Events`),
      taskId,
    ),
  );
  if (turnIndex !== undefined && turnIndex >= 0) {
    result.content.push(
      withRelatedTaskMeta(
        createResourceLink(
          turnPartsUri(sessionId, turnIndex),
          `Chat Session ${sessionId} Turn ${String(turnIndex)} Parts`,
        ),
        taskId,
      ),
    );
  }
}

async function askWithoutSession(
  args: AskArgs,
  ctx: ServerContext,
  chat?: Chat,
): Promise<AskExecutionResult> {
  const resolved = await resolveAskTooling(args, ctx);
  if ('error' in resolved) {
    return {
      result: resolved.error,
      streamResult: {
        text: '',
        textByWave: [''],
        thoughtText: '',
        parts: [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
        functionCalls: [],
        toolEvents: [],
        hadCandidate: false,
      } satisfies StreamResult,
      toolProfile: 'none',
    };
  }
  const { prompt, toolConfig, toolProfile, tools, urls, functionCallingMode, resolvedProfile } =
    resolved;
  const jsonMode = Boolean(args.responseSchema);
  const config = buildGenerateContentConfig(
    {
      ...buildAskGenerationOptions(
        args,
        toolConfig,
        tools,
        functionCallingMode,
        resolved.serverSideToolInvocations,
        resolvedProfile,
      ),
      costProfile: 'chat',
    },
    ctx.mcpReq.signal,
  );
  const maxRetries = jsonMode && !ctx.mcpReq.signal.aborted ? JSON_REPAIR_MAX_RETRIES : 0;
  let currentPrompt = prompt;
  let attempt = 0;
  let askResult!: AskExecutionResult;
  let usedJsonRepair = false;

  for (;;) {
    const attemptConfig =
      attempt === 0
        ? config
        : buildGenerateContentConfig(
            {
              ...(typeof config.systemInstruction === 'string'
                ? { systemInstruction: config.systemInstruction }
                : {}),
              responseSchema: args.responseSchema,
              jsonMode,
              costProfile: 'chat.jsonRepair',
              thinkingLevel: 'MINIMAL',
              maxOutputTokens:
                askResult.streamResult.finishReason === FinishReason.MAX_TOKENS
                  ? (config.maxOutputTokens ?? 2_048) * 2
                  : 2_048,
            },
            ctx.mcpReq.signal,
          );
    askResult = await runAskStream(
      ctx,
      () =>
        chat
          ? chat.sendMessageStream({
              message: buildChatMessage(
                currentPrompt,
                attempt === 0 ? normalizeFunctionResponses(args.functionResponses) : undefined,
              ),
              config: attemptConfig,
            })
          : getAI().models.generateContentStream({
              model: getGeminiModel(),
              contents: currentPrompt,
              config: attemptConfig,
            }),
      toolProfile,
      urls,
      jsonMode,
      args.responseSchema,
    );

    const structured = getAskStructuredContent(askResult.result);
    const warnings = structured?.warnings ?? [];
    const parsedData = structured && 'data' in structured ? structured.data : undefined;
    const shouldRetry =
      attempt < maxRetries &&
      !ctx.mcpReq.signal.aborted &&
      !askResult.result.isError &&
      (askResult.streamResult.finishReason === FinishReason.STOP ||
        askResult.streamResult.finishReason === FinishReason.MAX_TOKENS) &&
      isRetryableSchemaFailure(warnings, parsedData, jsonMode);

    if (!shouldRetry) {
      break;
    }

    logger.child('chat').debug('Retrying JSON response with repair suffix', {
      attempt: attempt + 1,
      warningCount: warnings.length,
      hadParsedData: parsedData !== undefined,
    });
    currentPrompt = buildReducedRepairPrompt(
      prompt,
      extractTextContent(askResult.result.content),
      warnings,
    );
    usedJsonRepair = true;
    attempt++;
  }

  if (usedJsonRepair) {
    askResult.result = appendAskWarnings(askResult.result, [
      'JSON repair turn used after the initial response failed parsing or schema validation.',
    ]);
  }

  return { ...askResult, sentMessage: prompt };
}

async function resolveWorkspaceCacheName(
  args: AskArgs,
  workspace: ToolWorkspaceAccess,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (args.systemInstruction || args.seed !== undefined || !getWorkspaceCacheEnabled()) {
    return undefined;
  }

  try {
    const allowedRoots = await workspace.allowedRoots();
    if (allowedRoots.length === 0) {
      return undefined;
    }
    return await workspace.getOrCreateCache(allowedRoots, signal);
  } catch (err) {
    logger.child('workspace').warn(`Failed to resolve workspace cache: ${String(err)}`);
    return undefined;
  }
}

function buildWorkspaceCacheSkipWarnings(args: AskArgs): string[] {
  if (!getWorkspaceCacheEnabled()) {
    return [];
  }

  const reasons: string[] = [];
  if (args.systemInstruction) {
    reasons.push('custom systemInstruction');
  }
  if (args.seed !== undefined) {
    reasons.push('custom seed');
  }

  if (reasons.length === 0) {
    return [];
  }

  return [`Automatic workspace cache skipped because this request uses ${reasons.join(', ')}.`];
}

function createDefaultAskDependencies(sessionAccess: SessionAccess): AskDependencies {
  return {
    appendSessionEvent: (sessionId, item) => sessionAccess.appendEvent(sessionId, item),
    appendSessionTranscript: (sessionId, item) => sessionAccess.appendTranscript(sessionId, item),
    getSessionEntry: (sessionId) => sessionAccess.getSessionEntry(sessionId),
    getSessionInteractionId: (sessionId) => sessionAccess.getSessionInteractionId(sessionId),
    isEvicted: (sessionId) => sessionAccess.isEvicted(sessionId),
    listSessionTranscriptEntries: (sessionId) => sessionAccess.listTranscriptEntries(sessionId),
    now: () => Date.now(),
    runWithoutSession: askWithoutSession,
  };
}

async function askWithInteractions(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  resolvedProfile: ResolvedProfile,
  lastInteractionId: string | undefined,
): Promise<AskExecutionResult> {
  const { prompt, urls } = await resolveAskTooling(args, ctx);
  if (!prompt) {
    return {
      result: new AppError('chat', 'Failed to resolve tooling').toToolResult(),
      streamResult: {
        text: '',
        textByWave: [''],
        thoughtText: '',
        parts: [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
        functionCalls: [],
        toolEvents: [],
        hadCandidate: false,
      } satisfies StreamResult,
      toolProfile: 'none',
    };
  }

  const { progress } = createToolContext('chat', ctx);
  await progress.send(0, undefined, 'Creating interaction');

  try {
    const params = buildInteractionParams({
      profile: resolvedProfile,
      model: getGeminiModel(),
      prompt,
      thinkingLevel: args.thinkingLevel,
      maxOutputTokens: args.maxOutputTokens,
      systemInstruction: args.systemInstruction,
      previousInteractionId: lastInteractionId,
    });

    // interactions.create() returns Stream<InteractionSSEEvent> directly (not wrapped in .stream)

    const createResult = await getAI().interactions.create(params);

    const notifications: { type: string; data: unknown }[] = [];
    const emitter = {
      emit: (type: string, data: unknown) => {
        notifications.push({ type, data });
      },
    };

    // The create method returns Stream<InteractionSSEEvent> when streaming (default)

    const interactionResult = await consumeInteractionStream(
      createResult as AsyncIterable<unknown>,
      emitter,
    );

    const result: CallToolResult =
      interactionResult.status === 'completed'
        ? {
            isError: false,
            content: [{ type: 'text', text: interactionResult.text ?? '' }],
          }
        : {
            isError: true,
            content: [
              {
                type: 'text',
                text: interactionResult.error?.message ?? 'Interaction stream failed',
              },
            ],
          };

    return {
      result,
      streamResult: {
        text: interactionResult.text ?? '',
        textByWave: [interactionResult.text ?? ''],
        thoughtText: '',
        parts: interactionResult.text ? [{ text: interactionResult.text }] : [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
        functionCalls: [],
        toolEvents: [],
        hadCandidate: true,
        finishReason: FinishReason.STOP,
      },
      toolProfile: 'interactions',
      ...(urls && urls.length > 0 ? { urls } : {}),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      result: new AppError('chat', `Interaction failed: ${errorMsg}`).toToolResult(),
      streamResult: {
        text: '',
        textByWave: [''],
        thoughtText: '',
        parts: [],
        toolsUsed: [],
        toolsUsedOccurrences: [],
        functionCalls: [],
        toolEvents: [],
        hadCandidate: false,
      } satisfies StreamResult,
      toolProfile: 'interactions',
    };
  }
}

function appendSessionTurn(
  sessionId: string,
  askResult: AskExecutionResult,
  args: AskArgs,
  deps: AskDependencies,
  taskId: string | undefined,
): void {
  const structured = getAskStructuredContent(askResult.result);
  const usage = extractUsage(askResult.streamResult.usageMetadata);
  const streamResult = askResult.streamResult;

  const response: SessionEventEntry['response'] = pickDefined({
    text: extractTextContent(askResult.result.content),
    data: structured?.data,
    schemaWarnings: structured?.warnings?.length ? structured.warnings : undefined,
    finishReason: streamResult.finishReason,
    functionCalls: streamResult.functionCalls.length > 0 ? streamResult.functionCalls : undefined,
    toolEvents: streamResult.toolEvents.length > 0 ? streamResult.toolEvents : undefined,
    usage,
    thoughts: streamResult.thoughtText || undefined,
    safetyRatings: streamResult.safetyRatings,
    finishMessage: streamResult.finishMessage,
    citationMetadata: streamResult.citationMetadata,
    groundingMetadata: streamResult.groundingMetadata,
    urlContextMetadata: streamResult.urlContextMetadata,
    anomalies: streamResult.anomalies,
  });

  const request: SessionEventEntry['request'] = pickDefined({
    message: args.message,
    toolProfile: askResult.toolProfile || undefined,
    urls: askResult.urls,
  });

  const event: SessionEventEntry = pickDefined({
    request,
    response,
    timestamp: deps.now(),
    taskId,
  });

  deps.appendSessionEvent(sessionId, event);
  deps.appendSessionTranscript(
    sessionId,
    pickDefined({
      role: 'user' as const,
      text: args.message,
      timestamp: deps.now(),
      taskId,
    }),
  );
  deps.appendSessionTranscript(
    sessionId,
    pickDefined({
      role: 'assistant' as const,
      text: extractTextContent(askResult.result.content),
      timestamp: deps.now(),
      taskId,
    }),
  );
}

interface PreparedAskRequest {
  effectiveArgs: AskArgs;
  contextUsed: ContextUsed;
  warnings: string[];
}

async function prepareAskRequest(
  args: AskArgs,
  deps: AskDependencies,
  ctx: ServerContext,
  signal: AbortSignal,
  workspace: ToolWorkspaceAccess,
): Promise<PreparedAskRequest | CallToolResult> {
  const validationError = validateAskRequest(args, deps, ctx);
  if (validationError) return validationError;

  // For sessions, workspace caching is not used; server-side state via ai.interactions handles persistence
  const canUseWorkspaceCache = !args.sessionId;
  const workspaceCacheName = canUseWorkspaceCache
    ? await resolveWorkspaceCacheName(args, workspace, signal)
    : undefined;
  const contextUsed = workspaceCacheName
    ? buildContextUsed(
        [{ kind: 'workspace-cache', name: workspaceCacheName, tokens: 0, relevanceScore: 1 }],
        0,
        true,
      )
    : emptyContextUsed();
  const effectiveArgs = workspaceCacheName ? { ...args, cacheName: workspaceCacheName } : args;
  const warnings = buildWorkspaceCacheSkipWarnings(args);

  return { effectiveArgs, contextUsed, warnings };
}

function isPreparedRequest(
  value: PreparedAskRequest | CallToolResult,
): value is PreparedAskRequest {
  return 'effectiveArgs' in value;
}

function createAskWork(deps: AskDependencies, workspace: ToolWorkspaceAccess) {
  return async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
    const prepared = await prepareAskRequest(args, deps, ctx, ctx.mcpReq.signal, workspace);
    if (!isPreparedRequest(prepared)) return prepared;

    const { effectiveArgs, warnings } = prepared;

    if (!effectiveArgs.sessionId) {
      const askResult = await deps.runWithoutSession(effectiveArgs, ctx);
      return appendAskWarnings(askResult.result, warnings);
    }

    const sessionId = effectiveArgs.sessionId;
    const session = deps.getSessionEntry(sessionId);
    if (!session) {
      return new AppError('chat', `Session ${sessionId} not found`).toToolResult();
    }

    const toolingResolved = await resolveAskTooling(effectiveArgs, ctx);
    if ('error' in toolingResolved) {
      return toolingResolved.error;
    }

    const lastInteractionId = deps.getSessionInteractionId(sessionId);
    const askResult = await askWithInteractions(
      effectiveArgs as AskArgs & { sessionId: string },
      ctx,
      toolingResolved.resolvedProfile,
      lastInteractionId,
    );

    if (!askResult.result.isError) {
      appendSessionTurn(sessionId, askResult, effectiveArgs, deps, ctx.task?.id);
      appendSessionResource(askResult.result, sessionId, undefined, ctx.task?.id);
    }

    return appendAskWarnings(askResult.result, warnings);
  };
}

function extractSessionId(
  result: CallToolResult,
  requestedSessionId: string | undefined,
): string | undefined {
  if (requestedSessionId) {
    return requestedSessionId;
  }

  for (const item of result.content) {
    if (item.type !== 'resource_link' || typeof item.uri !== 'string') continue;
    const match = /^memory:\/\/sessions\/([^/]+)$/.exec(item.uri);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  return undefined;
}

function assembleChatOutput(
  result: CallToolResult,
  sessionIdHint: string | undefined,
  _taskId: string | undefined,
  ctx: ServerContext,
): CallToolResult {
  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent ?? {};
  const answer =
    typeof structured.answer === 'string' ? structured.answer : extractTextContent(result.content);
  const warnings = Array.isArray(structured.schemaWarnings)
    ? structured.schemaWarnings.filter((value): value is string => typeof value === 'string')
    : undefined;
  const extraWarnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((value): value is string => typeof value === 'string')
    : undefined;
  const sessionId = extractSessionId(result, sessionIdHint);
  const session = sessionId ? { id: sessionId } : undefined;
  return createToolContext('chat', ctx).validateOutput(
    ChatOutputSchema,
    pickDefined({
      ...buildBaseStructuredOutput([...(warnings ?? []), ...(extraWarnings ?? [])]),
      answer,
      data: structured.data,
      session,
    }),
    result,
  );
}

async function chatWork(
  askWork: ReturnType<typeof createAskWork>,
  args: ChatInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const tasks = getTaskEmitter(ctx);

  let responseSchema: GeminiResponseSchema | undefined;
  if (args.responseSchemaJson !== undefined) {
    try {
      responseSchema = parseResponseSchemaJsonValue(args.responseSchemaJson);
    } catch (error) {
      return error instanceof AppError
        ? error.toToolResult()
        : new AppError('chat', 'responseSchemaJson must be valid JSON.').toToolResult();
    }
  }

  await tasks.phase('streaming');
  const result = await askWork(
    {
      message: args.goal,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(responseSchema !== undefined ? { responseSchema } : {}),
      maxOutputTokens: args.maxOutputTokens,
      seed: args.seed,
      safetySettings: args.safetySettings,
      tools: args.tools,
      functionResponses: args.functionResponses,
      systemInstruction: args.systemInstruction,
      thinkingLevel: args.thinkingLevel,
    },
    ctx,
  );

  await tasks.phase('finalizing');
  const output = assembleChatOutput(result, args.sessionId, ctx.task?.id, ctx);
  const resourceLinks = appendResourceLinks('chat', {
    sessionId: args.sessionId,
  });
  return {
    ...output,
    resourceLink: resourceLinks,
  };
}

export function registerChatTool(server: McpServer, services: ToolServices): void {
  const askWork = createAskWork(createDefaultAskDependencies(services.session), services.workspace);

  registerWorkTool<ChatInput>({
    server,
    tool: {
      name: 'chat',
      title: 'Chat',
      description:
        'Direct Gemini chat with optional server-managed in-memory sessions and automatic workspace cache reuse when eligible.',
      inputSchema: createChatInputSchema((prefix) => services.session.completeSessionIds(prefix)),
      outputSchema: ChatOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    work: (args, ctx) => chatWork(askWork, args, ctx),
  });
}
