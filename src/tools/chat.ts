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
import { consumeInteractionStream } from '../lib/interaction-stream.js';
import { buildInteractionParams } from '../lib/interactions.js';
import { logger, mcpLog } from '../lib/logger.js';
import {
  appendFunctionCallingInstruction,
  buildFunctionCallingInstructionText,
} from '../lib/model-prompts.js';
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
  buildSessionSummary,
  emptyContextUsed,
  type ToolServices,
  type ToolWorkspaceAccess,
} from '../lib/tool-context.js';
import { createToolContext, executor } from '../lib/tool-executor.js';
import {
  buildProfileToolConfig,
  buildToolsArray,
  ProfileValidationError,
  type ResolvedProfile,
  resolveProfile,
  resolveProfileFunctionCallingMode,
  type ToolsSpecInput,
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
  getSessionLimits,
  getStatelessTransportFlag,
  getWorkspaceCacheEnabled,
} from '../config.js';
import { TOOL_LABELS } from '../public-contract.js';
import {
  sessionDetailUri,
  sessionEventsUri,
  sessionTranscriptUri,
  sessionTurnPartsUri,
} from '../resources.js';
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
  appendSessionContent: (sessionId: string, item: ContentEntry) => boolean;
  appendSessionEvent: (sessionId: string, item: SessionEventEntry) => boolean;
  appendSessionTranscript: (sessionId: string, item: TranscriptEntry) => boolean;
  createChat: (args: AskArgs) => { chat: Chat; contract?: SessionGenerationContract };
  getSession: (sessionId: string) => Chat | undefined;
  getSessionEntry: (sessionId: string) => SessionSummary | undefined;
  isEvicted: (sessionId: string) => boolean;
  listSessionContentEntries: (sessionId: string) => ContentEntry[] | undefined;
  now: () => number;
  listSessionTranscriptEntries: (sessionId: string) => TranscriptEntry[] | undefined;
  rebuildChat: (sessionId: string, args: AskArgs) => Chat | undefined;
  runWithoutSession: (
    args: AskArgs,
    ctx: ServerContext,
    chat?: Chat,
  ) => Promise<AskExecutionResult>;
  setSession: (
    sessionId: string,
    chat: Chat,
    rebuiltAt?: number,
    cacheName?: string,
    contract?: SessionGenerationContract,
  ) => void;
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
    {
      answer,
      ...(parsedData !== undefined ? { data: parsedData } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    {
      ...(contextUsed ? { contextUsed } : {}),
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
    },
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
  return resolveProfile(args.tools as ToolsSpecInput | undefined, { toolKey: 'chat' });
}

function validateAskRequest(
  args: AskArgs,
  deps: Pick<AskDependencies, 'getSessionEntry' | 'isEvicted' | 'listSessionContentEntries'>,
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
    [hasFunctionResponses && !sessionId, 'chat: functionResponses requires sessionId.'],
    [
      hasFunctionResponses && !hasExistingSession,
      'chat: functionResponses requires an existing sessionId.',
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

  // Pending call validation no longer needed; server-side state management via ai.interactions handles this

  if (
    hasExistingSession &&
    sessionEntry.contract &&
    !isCompatibleSessionContract(sessionEntry.contract, buildRequestedSessionContract(args))
  ) {
    return new AppError(
      'chat',
      'chat: session contract mismatch: this sessionId was created with different model, tools, system instruction, or response schema settings. Start a new session.',
    ).toToolResult();
  }

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
  const resolved = await resolveOrchestration(args.tools as ToolsSpecInput | undefined, ctx, {
    toolKey: 'chat',
  });
  if (resolved.error) {
    return { error: resolved.error } as const;
  }
  const { functionCallingMode, toolProfile, tools, toolConfig } = resolved.config;
  const usesUrlContext = resolved.config.activeCapabilities.has('urlContext');
  const urls = resolved.config.resolvedProfile?.overrides.urls;

  // URL Context discovers target URLs from prompt text; keep URLs visible
  // whenever a URL-capable profile is active.
  const promptUrls = usesUrlContext || !tools || tools.length === 0 ? urls : undefined;

  return {
    prompt: buildAskPrompt(args.message, promptUrls),
    toolProfile,
    urls: usesUrlContext ? [...(urls ?? [])] : undefined,
    tools,
    toolConfig,
    functionCallingMode,
    serverSideToolInvocations: toolConfig?.includeServerSideToolInvocations === true,
    resolvedProfile: resolved.config.resolvedProfile,
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
      createResourceLink(sessionDetailUri(sessionId), `Chat Session ${sessionId}`),
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
          sessionTurnPartsUri(sessionId, turnIndex),
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

function buildAskToolingConfig(args: AskArgs) {
  const resolved = buildChatResolvedProfile(args);
  const tools = buildToolsArray(resolved);
  const toolConfig = buildProfileToolConfig(resolved);
  const functionCallingMode = resolveProfileFunctionCallingMode(resolved);
  return {
    tools: tools.length > 0 ? tools : undefined,
    toolConfig,
    functionCallingMode,
    serverSideToolInvocations: toolConfig?.includeServerSideToolInvocations === true,
    resolvedProfile: resolved,
  };
}

function buildRequestedSessionContract(args: AskArgs): SessionGenerationContract {
  const { toolConfig, tools, functionCallingMode, serverSideToolInvocations, resolvedProfile } =
    buildAskToolingConfig(args);
  const declaredNames = resolvedProfile.overrides.functions?.map((f) => f.name) ?? [];
  const functionCallingInstructionHash = hashInstructionText(
    buildFunctionCallingInstructionText({
      ...(functionCallingMode !== undefined ? { mode: functionCallingMode } : {}),
      declaredNames,
      serverSideToolInvocations,
    }),
  );
  const config = buildGenerateContentConfig({
    ...buildAskGenerationOptions(
      args,
      toolConfig,
      tools,
      functionCallingMode,
      serverSideToolInvocations,
      resolvedProfile,
    ),
    costProfile: 'chat',
    cacheName: args.cacheName,
  });

  return buildSessionGenerationContract(
    getGeminiModel(),
    config,
    functionCallingMode,
    functionCallingInstructionHash,
  );
}

function createDefaultAskDependencies(
  sessionAccess: SessionAccess,
  workspace: ToolWorkspaceAccess,
): AskDependencies {
  return {
    appendSessionContent: (sessionId, item) => sessionAccess.appendContent(sessionId, item),
    appendSessionEvent: (sessionId, item) => sessionAccess.appendEvent(sessionId, item),
    appendSessionTranscript: (sessionId, item) => sessionAccess.appendTranscript(sessionId, item),
    createChat: (args) => {
      const { toolConfig, tools, functionCallingMode, serverSideToolInvocations, resolvedProfile } =
        buildAskToolingConfig(args);
      const config = buildGenerateContentConfig({
        ...buildAskGenerationOptions(
          args,
          toolConfig,
          tools,
          functionCallingMode,
          serverSideToolInvocations,
          resolvedProfile,
        ),
        costProfile: 'chat',
        cacheName: args.cacheName,
      });
      const chat = getAI().chats.create({
        model: getGeminiModel(),
        config,
      });
      return {
        chat,
        contract: buildRequestedSessionContract(args),
      };
    },
    getSession: (sessionId) => sessionAccess.getSession(sessionId),
    getSessionEntry: (sessionId) => sessionAccess.getSessionEntry(sessionId),
    isEvicted: (sessionId) => sessionAccess.isEvicted(sessionId),
    listSessionContentEntries: (sessionId) => sessionAccess.listContentEntries(sessionId),
    listSessionTranscriptEntries: (sessionId) => sessionAccess.listTranscriptEntries(sessionId),
    rebuildChat: (sessionId, args) => {
      const contents = sessionAccess.listContentEntries(sessionId) ?? [];
      if (contents.length === 0) {
        return undefined;
      }

      const sessionEntry = sessionAccess.getSessionEntry(sessionId);
      const contract = sessionEntry?.contract;
      const cacheName = sessionEntry?.cacheName;
      const activeCacheName = workspace.getCacheStatus().cacheName;
      const rebuildArgs =
        cacheName && cacheName === activeCacheName ? { ...args, cacheName } : args;
      if (cacheName && cacheName !== activeCacheName) {
        logger.child('chat').info('Rebuilding session without stale workspace cache', {
          sessionId,
          cacheName,
        });
      }
      // Replay reconstruction reads only the raw ContentEntry substrate. The
      // normalized SessionEventEntry audit projection is intentionally ignored.
      const config = contract
        ? buildConfigFromSessionContract(
            contract,
            cacheName && cacheName === activeCacheName ? cacheName : undefined,
          )
        : (() => {
            const {
              toolConfig,
              tools,
              functionCallingMode,
              serverSideToolInvocations,
              resolvedProfile,
            } = buildAskToolingConfig(args);
            return buildGenerateContentConfig({
              ...buildAskGenerationOptions(
                rebuildArgs,
                toolConfig,
                tools,
                functionCallingMode,
                serverSideToolInvocations,
                resolvedProfile,
              ),
              costProfile: 'chat',
            });
          })();
      const chat = getAI().chats.create({
        model: contract?.model ?? getGeminiModel(),
        config,
        history: buildRebuiltChatContents(contents, getSessionLimits().replayMaxBytes),
      });
      sessionAccess.replaceSession(sessionId, chat);
      return chat;
    },
    now: () => Date.now(),
    runWithoutSession: askWithoutSession,
    setSession: (sessionId, chat, rebuiltAt, cacheName, contract) => {
      sessionAccess.setSession(sessionId, chat, rebuiltAt, cacheName, contract);
    },
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
  resumedArgs?: AskArgs,
): void {
  const sentMessage = resumedArgs?.message ?? args.message;
  const structured = getAskStructuredContent(askResult.result);
  const usage = extractUsage(askResult.streamResult.usageMetadata);

  const response: SessionEventEntry['response'] = {
    text: extractTextContent(askResult.result.content),
  };

  if (structured?.data !== undefined) {
    response.data = structured.data;
  }
  if (structured?.warnings !== undefined && structured.warnings.length > 0) {
    response.schemaWarnings = structured.warnings;
  }
  if (askResult.streamResult.finishReason !== undefined) {
    response.finishReason = String(askResult.streamResult.finishReason);
  }
  if (askResult.streamResult.functionCalls && askResult.streamResult.functionCalls.length > 0) {
    response.functionCalls = askResult.streamResult.functionCalls;
  }
  if (askResult.streamResult.toolEvents && askResult.streamResult.toolEvents.length > 0) {
    response.toolEvents = askResult.streamResult.toolEvents;
  }
  if (usage !== undefined) {
    response.usage = usage;
  }
  if (askResult.streamResult.thoughtText) {
    response.thoughts = askResult.streamResult.thoughtText;
  }
  if (askResult.streamResult.safetyRatings !== undefined) {
    response.safetyRatings = askResult.streamResult.safetyRatings;
  }
  if (askResult.streamResult.finishMessage !== undefined) {
    response.finishMessage = askResult.streamResult.finishMessage;
  }
  if (askResult.streamResult.citationMetadata !== undefined) {
    response.citationMetadata = askResult.streamResult.citationMetadata;
  }
  if (askResult.streamResult.groundingMetadata !== undefined) {
    response.groundingMetadata = askResult.streamResult.groundingMetadata;
  }
  if (askResult.streamResult.urlContextMetadata !== undefined) {
    response.urlContextMetadata = askResult.streamResult.urlContextMetadata;
  }
  if (askResult.streamResult.anomalies !== undefined) {
    response.anomalies = askResult.streamResult.anomalies;
  }

  const request: SessionEventEntry['request'] = {
    message: args.message,
  };

  if (sentMessage !== undefined) {
    request.sentMessage = sentMessage;
  }
  if (askResult.toolProfile) {
    request.toolProfile = askResult.toolProfile;
  }
  if (askResult.urls !== undefined) {
    request.urls = askResult.urls;
  }

  const event: SessionEventEntry = {
    request,
    response,
    timestamp: deps.now(),
  };

  if (taskId !== undefined) {
    event.taskId = taskId;
  }

  deps.appendSessionEvent(sessionId, event);
  deps.appendSessionTranscript(sessionId, {
    role: 'user',
    text: args.message,
    timestamp: deps.now(),
    ...(taskId !== undefined ? { taskId } : {}),
  });
  deps.appendSessionTranscript(sessionId, {
    role: 'assistant',
    text: extractTextContent(askResult.result.content),
    timestamp: deps.now(),
    ...(taskId !== undefined ? { taskId } : {}),
  });
}

async function askExistingSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
  chat: Chat,
  sessionSummary?: string,
): Promise<CallToolResult | undefined> {
  // Tool response tracking removed; server-side state management via ai.interactions handles this

  const resumedArgs = sessionSummary
    ? { ...args, message: `${sessionSummary}\n\n${args.message}` }
    : args;

  await mcpLog(ctx, 'debug', `Resuming session ${args.sessionId}`);
  const { progress } = createToolContext('chat', ctx);
  await progress.send(0, undefined, 'Resuming session');
  const askResult = await deps.runWithoutSession(resumedArgs, ctx, chat);
  askResult.result = attachSessionMetadata(
    askResult.result,
    args.sessionId,
    deps.getSessionEntry(args.sessionId)?.rebuiltAt,
  );
  appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id, resumedArgs);
  const turnIndex = (deps.listSessionContentEntries(args.sessionId)?.length ?? 0) - 1;
  appendSessionResource(askResult.result, args.sessionId, turnIndex, ctx.task?.id);
  return askResult.result;
}

async function askNewSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
): Promise<CallToolResult> {
  await mcpLog(ctx, 'debug', `Creating session ${args.sessionId}`);
  const { chat, contract } = deps.createChat(args);

  const askResult = await deps.runWithoutSession(args, ctx, chat);

  if (!askResult.result.isError) {
    deps.setSession(args.sessionId, chat, undefined, args.cacheName, contract);
    askResult.result = attachSessionMetadata(askResult.result, args.sessionId);
    appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
    const turnIndex = (deps.listSessionContentEntries(args.sessionId)?.length ?? 0) - 1;
    appendSessionResource(askResult.result, args.sessionId, turnIndex, ctx.task?.id);
  } else {
    await mcpLog(ctx, 'debug', `Session ${args.sessionId} not stored due to stream error`);
  }

  return askResult.result;
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

  const persistedCacheName = args.sessionId
    ? deps.getSessionEntry(args.sessionId)?.cacheName
    : undefined;
  const canUseWorkspaceCache =
    !persistedCacheName && (!args.sessionId || deps.getSessionEntry(args.sessionId) === undefined);
  const workspaceCacheName = canUseWorkspaceCache
    ? await resolveWorkspaceCacheName(args, workspace, signal)
    : persistedCacheName;
  const contextUsed = workspaceCacheName
    ? buildContextUsed(
        [{ kind: 'workspace-cache', name: workspaceCacheName, tokens: 0, relevanceScore: 1 }],
        0,
        true,
      )
    : emptyContextUsed();
  const effectiveArgs = workspaceCacheName ? { ...args, cacheName: workspaceCacheName } : args;
  const warnings =
    workspaceCacheName || persistedCacheName || !canUseWorkspaceCache
      ? []
      : buildWorkspaceCacheSkipWarnings(args);

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
    const liveChat = deps.getSession(sessionId);
    if (liveChat) {
      const resumed = await askExistingSession(
        effectiveArgs as AskArgs & { sessionId: string },
        ctx,
        deps,
        liveChat,
      );
      if (resumed) return appendAskWarnings(resumed, warnings);
    } else if (deps.getSessionEntry(sessionId)) {
      const rebuiltChat = deps.rebuildChat(sessionId, effectiveArgs);
      if (rebuiltChat) {
        const transcript = deps.listSessionTranscriptEntries(sessionId) ?? [];
        const sessionSummary = transcript.length > 0 ? buildSessionSummary(transcript) : undefined;
        const resumed = await askExistingSession(
          effectiveArgs as AskArgs & { sessionId: string },
          ctx,
          deps,
          rebuiltChat,
          sessionSummary,
        );
        if (resumed) return appendAskWarnings(resumed, warnings);
      } else {
        const transcript = deps.listSessionTranscriptEntries(sessionId) ?? [];
        if (transcript.length > 0) {
          return new AppError(
            'chat',
            `session ${sessionId} cannot be resumed: no turn parts persisted`,
          ).toToolResult();
        }
      }
    }

    return appendAskWarnings(
      await askNewSession(effectiveArgs as AskArgs & { sessionId: string }, ctx, deps),
      warnings,
    );
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

function attachSessionMetadata(
  result: CallToolResult,
  sessionId: string,
  rebuiltAt?: number,
): CallToolResult {
  if (result.isError) {
    return result;
  }

  return mergeStructured(result, {
    session: {
      id: sessionId,
      ...(rebuiltAt !== undefined ? { rebuiltAt } : {}),
    },
  });
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
  const session =
    sessionId && typeof structured.session === 'object' && structured.session !== null
      ? {
          id: sessionId,
        }
      : sessionId
        ? {
            id: sessionId,
          }
        : undefined;
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
  return assembleChatOutput(result, args.sessionId, ctx.task?.id, ctx);
}

export function registerChatTool(server: McpServer, services: ToolServices): void {
  const askWork = createAskWork(
    createDefaultAskDependencies(services.session, services.workspace),
    services.workspace,
  );

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
