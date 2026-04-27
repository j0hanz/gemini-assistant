import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createHash } from 'node:crypto';

import { Validator } from '@cfworker/json-schema';
import { FinishReason, FunctionCallingConfigMode } from '@google/genai';
import type {
  Chat,
  FunctionDeclaration,
  FunctionResponse,
  GenerateContentConfig,
  PartListUnion,
} from '@google/genai';

import { AppError, assertNever } from '../lib/errors.js';
import { logger, mcpLog } from '../lib/logger.js';
import {
  appendFunctionCallingInstruction,
  buildFunctionCallingInstructionText,
} from '../lib/model-prompts.js';
import {
  buildOrchestrationConfig,
  buildOrchestrationRequestFromInputs,
  resolveOrchestration,
  resolveServerSideToolInvocations,
} from '../lib/orchestration.js';
import {
  buildBaseStructuredOutput,
  buildStructuredResponse,
  createResourceLink,
  extractTextContent,
  pickDefined,
  tryParseJsonResponse,
  withRelatedTaskMeta,
} from '../lib/response.js';
import {
  deriveComputationsFromToolEvents,
  extractUsage,
  type FunctionCallEntry,
  type StreamResult,
  type ToolEvent,
} from '../lib/streaming.js';
import { READ_ONLY_SESSION_ANNOTATIONS, registerWorkTool } from '../lib/task-utils.js';
import {
  bindToolServices,
  buildContextUsed,
  buildSessionSummary,
  createDefaultToolServices,
  emptyContextUsed,
  type ToolServices,
  type ToolWorkspaceAccess,
  type ToolWorkspaceCacheManager,
  toToolSessionAccess,
  toToolWorkspaceAccess,
} from '../lib/tool-context.js';
import { createToolContext, executor } from '../lib/tool-executor.js';
import {
  type AskInput,
  type ChatInput,
  createChatInputSchema,
  parseResponseSchemaJsonValue,
  type WithChatDefaults,
} from '../schemas/inputs.js';
import type { GeminiResponseSchema } from '../schemas/inputs.js';
import { ChatOutputSchema, type ContextUsed, type UsageMetadata } from '../schemas/outputs.js';

import { buildGenerateContentConfig, DEFAULT_TEMPERATURE, getAI } from '../client.js';
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
import {
  appendToolResponseTurn,
  buildRebuiltChatContents,
  buildReplayHistoryParts,
  capRawParts,
  type ContentEntry,
  getPendingFunctionCalls,
  sanitizeFunctionCalls,
  sanitizeSessionValue,
  sanitizeToolEvents,
  type SessionAccess,
  type SessionEventEntry,
  type SessionGenerationContract,
  type SessionStore,
  type SessionSummary,
  type TranscriptEntry,
} from '../sessions.js';

export { appendToolResponseTurn, buildRebuiltChatContents };

function isToolServices(value: ToolServices | SessionStore | undefined): value is ToolServices {
  return (
    value !== undefined &&
    typeof value === 'object' &&
    'session' in value &&
    'workspace' in value &&
    'rootsFetcher' in value
  );
}

function isSessionAccess(value: SessionAccess | SessionStore): value is SessionAccess {
  return 'appendContent' in value;
}

function isWorkspaceAccess(
  value: ToolWorkspaceAccess | ToolWorkspaceCacheManager | undefined,
): value is ToolWorkspaceAccess {
  return value !== undefined && 'allowedRoots' in value;
}

function resolveChatServices(
  servicesOrSessionStore?: ToolServices | SessionStore,
  workspaceCacheManagerInstance?: ToolWorkspaceCacheManager,
): ToolServices {
  if (isToolServices(servicesOrSessionStore)) {
    return servicesOrSessionStore;
  }

  return {
    rootsFetcher: () => Promise.resolve([]),
    session: toToolSessionAccess(servicesOrSessionStore ?? createDefaultToolServices().session),
    workspace: toToolWorkspaceAccess(workspaceCacheManagerInstance),
  };
}

type ChatWorkInput = WithChatDefaults<ChatInput>;
export type AskArgs = WithChatDefaults<AskInput> & {
  cacheName?: string;
};

interface AskStructuredContent extends Record<string, unknown> {
  answer: string;
  contextUsed?: ContextUsed;
  data?: unknown;
  computations?: ReturnType<typeof deriveComputationsFromToolEvents>;
  functionCalls?: FunctionCallEntry[];
  citationMetadata?: unknown;
  finishMessage?: string | undefined;
  schemaWarnings?: string[];
  safetyRatings?: unknown;
  session?: {
    id: string;
    rebuiltAt?: number;
  };
  thoughts?: string;
  toolEvents?: ToolEvent[];
  usage?: UsageMetadata;
  warnings?: string[];
}

export interface AskDependencies {
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

export interface AskExecutionResult {
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
    'Repair the invalid JSON response from the previous turn.',
    'Return ONLY valid JSON that conforms exactly to the provided schema.',
    `Original user request:\n${originalPrompt}`,
    `Validation errors:\n${warningText}`,
    `Previous invalid output:\n${invalidOutputText}`,
  ].join('\n\n');
}

function appendAskWarnings(result: CallToolResult, warnings: readonly string[]): CallToolResult {
  if (result.isError || warnings.length === 0) {
    return result;
  }

  const structured = getAskStructuredContent(result) ?? {
    answer: extractTextContent(result.content),
  };
  const existingWarnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    ...result,
    structuredContent: {
      ...structured,
      warnings: [...existingWarnings, ...warnings],
    },
  };
}

function hashInstructionText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  return createHash('sha256').update(text).digest('hex');
}

export function buildAskStructuredContent(
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
  >,
  jsonMode?: boolean,
  responseSchema?: GeminiResponseSchema,
  contextUsed?: ContextUsed,
): AskStructuredContent {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : '';
  const usage = extractUsage(streamResult.usageMetadata);
  const warnings = buildAskWarnings(parsedData, jsonMode, responseSchema);
  const computations = deriveComputationsFromToolEvents(streamResult.toolEvents);

  return buildStructuredResponse(
    {
      answer,
      ...(parsedData !== undefined ? { data: parsedData } : {}),
      ...(computations.length > 0 ? { computations } : {}),
      ...(warnings.length > 0 ? { schemaWarnings: warnings } : {}),
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
    },
  );
}

export function formatStructuredResult(
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
    ],
    structuredContent: structured,
  };
}

function getAskStructuredContent(result: CallToolResult): AskStructuredContent | undefined {
  if (!result.structuredContent || typeof result.structuredContent !== 'object') {
    return undefined;
  }

  return result.structuredContent as AskStructuredContent;
}

function attachContextUsed(result: CallToolResult, contextUsed?: ContextUsed): CallToolResult {
  if (!contextUsed || result.isError) {
    return result;
  }

  const structured = getAskStructuredContent(result) ?? {
    answer: extractTextContent(result.content),
  };

  return {
    ...result,
    structuredContent: {
      ...structured,
      contextUsed,
    },
  };
}

function validateAskConflict(condition: boolean, message: string): CallToolResult | undefined {
  return condition ? new AppError('chat', message).toToolResult() : undefined;
}

function validateFunctionResponsesAgainstPending(
  pending: FunctionCallEntry[],
  responses: NonNullable<AskArgs['functionResponses']>,
): string | undefined {
  const seenIds = new Set<string>();
  const pendingById = new Map(
    pending.flatMap((call) =>
      typeof call.id === 'string' && call.id.length > 0 ? [[call.id, call] as const] : [],
    ),
  );

  for (const response of responses) {
    if (seenIds.has(response.id)) {
      return `chat: duplicate functionResponse id '${response.id}'.`;
    }
    seenIds.add(response.id);

    const pendingCall = pendingById.get(response.id);
    if (!pendingCall) {
      return `chat: functionResponse id '${response.id}' does not match a pending functionCall.`;
    }

    if (pendingCall.name !== response.name) {
      return `chat: functionResponse id '${response.id}' has name '${response.name}', expected '${pendingCall.name ?? ''}'.`;
    }
  }

  return undefined;
}

function hasExpiredSession(
  sessionId: string | undefined,
  deps: Pick<AskDependencies, 'isEvicted'>,
): boolean {
  return sessionId !== undefined && deps.isEvicted(sessionId);
}

function getAskUrls(args: AskArgs): readonly string[] | undefined {
  return 'urls' in args ? args.urls : undefined;
}

function buildFunctionDeclarations(args: AskArgs): FunctionDeclaration[] | undefined {
  if (!args.functions?.declarations.length) return undefined;
  return args.functions.declarations.map((declaration) => ({
    name: declaration.name,
    description: declaration.description,
    ...(declaration.parametersJsonSchema !== undefined
      ? { parameters: declaration.parametersJsonSchema }
      : {}),
  }));
}

type FunctionModeInput = NonNullable<NonNullable<AskArgs['functions']>['mode']>;

function toFunctionCallingConfigMode(
  mode: FunctionModeInput | undefined,
): FunctionCallingConfigMode | undefined {
  if (mode === undefined) return undefined;
  switch (mode) {
    case 'AUTO':
      return FunctionCallingConfigMode.AUTO;
    case 'ANY':
      return FunctionCallingConfigMode.ANY;
    case 'NONE':
      return FunctionCallingConfigMode.NONE;
    case 'VALIDATED':
      return FunctionCallingConfigMode.VALIDATED;
    default:
      return assertNever(mode, 'FunctionModeInput');
  }
}

function buildChatOrchestrationRequest(args: AskArgs) {
  const urls = getAskUrls(args);
  const functionDeclarations = buildFunctionDeclarations(args);
  return buildOrchestrationRequestFromInputs({
    googleSearch: args.googleSearch,
    urls,
    codeExecution: args.codeExecution,
    ...(args.fileSearch ? { fileSearch: args.fileSearch } : {}),
    ...(functionDeclarations ? { functionDeclarations } : {}),
    ...(args.functions?.mode !== undefined
      ? { functionCallingMode: toFunctionCallingConfigMode(args.functions.mode) }
      : {}),
    ...(args.responseSchema !== undefined ? { responseSchemaRequested: true } : {}),
    ...(args.serverSideToolInvocations !== undefined
      ? { serverSideToolInvocations: args.serverSideToolInvocations }
      : {}),
  });
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
  const urls = getAskUrls(args);

  const sessionEntry = sessionId ? deps.getSessionEntry(sessionId) : undefined;
  const hasExistingSession = sessionEntry !== undefined;
  const hasFunctionResponses = (args.functionResponses?.length ?? 0) > 0;
  const orchestration = buildOrchestrationConfig(buildChatOrchestrationRequest(args));
  const inputValidation = createToolContext('chat', ctx).validateInputs({
    urls,
    geminiRequest: {
      allowExistingSessionSchema: sessionEntry?.contract !== undefined,
      hasExistingSession,
      jsonMode: responseSchema !== undefined,
      responseSchema,
      sessionId,
      activeCapabilities: orchestration.activeCapabilities,
      fileSearchStoreNames: args.fileSearch?.fileSearchStoreNames,
    },
  });
  if (inputValidation) {
    return inputValidation;
  }

  const conflicts: [boolean, string][] = [
    [hasExpiredSession(sessionId, deps), `chat: Session '${sessionId}' has expired.`],
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

  if (hasFunctionResponses && sessionId && sessionEntry) {
    const pending = getPendingFunctionCalls({
      contents: deps.listSessionContentEntries(sessionId) ?? [],
    });
    const validationMessage = validateFunctionResponsesAgainstPending(
      pending,
      args.functionResponses ?? [],
    );
    if (validationMessage) {
      return new AppError('chat', validationMessage).toToolResult();
    }
  }

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
  const urls = getAskUrls(args);
  const resolved = await resolveOrchestration(buildChatOrchestrationRequest(args), ctx, 'chat');
  if (resolved.error) {
    return { error: resolved.error } as const;
  }
  const { functionCallingMode, toolProfile, tools, toolConfig } = resolved.config;
  const usesUrlContext = resolved.config.activeCapabilities.has('urlContext');

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
    serverSideToolInvocations:
      resolveServerSideToolInvocations(
        args.serverSideToolInvocations,
        resolved.config.activeCapabilities,
      ) === true,
  } as const;
}

function buildPerTurnConfig(config: ReturnType<typeof buildGenerateContentConfig>) {
  return pickDefined({
    abortSignal: config.abortSignal,
    thinkingConfig: config.thinkingConfig,
  });
}

function buildSessionGenerationContract(
  model: string,
  config: GenerateContentConfig,
  functionCallingMode?: FunctionCallingConfigMode,
  functionCallingInstructionHash?: string,
): SessionGenerationContract {
  return pickDefined({
    model,
    systemInstruction: config.systemInstruction,
    tools: config.tools,
    toolConfig: config.toolConfig,
    functionCallingMode,
    functionCallingInstructionHash,
    thinkingConfig: config.thinkingConfig,
    responseMimeType: config.responseMimeType,
    responseJsonSchema: config.responseJsonSchema,
  });
}

function buildConfigFromSessionContract(
  contract: SessionGenerationContract,
  cacheName?: string,
): GenerateContentConfig {
  return pickDefined({
    ...(cacheName ? { cachedContent: cacheName } : {}),
    systemInstruction: contract.systemInstruction,
    tools: contract.tools,
    toolConfig: contract.toolConfig,
    thinkingConfig: contract.thinkingConfig,
    responseMimeType: contract.responseMimeType,
    responseJsonSchema: contract.responseJsonSchema,
  });
}

function buildAskGenerationOptions(
  args: AskArgs,
  toolConfig: GenerateContentConfig['toolConfig'],
  tools: GenerateContentConfig['tools'],
  functionCallingMode: FunctionCallingConfigMode | undefined,
  serverSideToolInvocations: boolean,
) {
  return {
    ...args,
    systemInstruction: appendFunctionCallingInstruction(args.systemInstruction, {
      ...(functionCallingMode !== undefined ? { mode: functionCallingMode } : {}),
      declaredNames: args.functions?.declarations.map((declaration) => declaration.name) ?? [],
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

export async function askWithoutSession(
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
  const { prompt, toolConfig, toolProfile, tools, urls, functionCallingMode } = resolved;
  const jsonMode = Boolean(args.responseSchema);
  const config = buildGenerateContentConfig(
    {
      ...buildAskGenerationOptions(
        args,
        toolConfig,
        tools,
        functionCallingMode,
        resolved.serverSideToolInvocations,
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
              maxOutputTokens: 2_048,
            },
            ctx.mcpReq.signal,
          );
    const perTurnConfig = buildPerTurnConfig(attemptConfig);
    askResult = await runAskStream(
      ctx,
      () =>
        chat
          ? chat.sendMessageStream({
              message: buildChatMessage(
                currentPrompt,
                attempt === 0 ? normalizeFunctionResponses(args.functionResponses) : undefined,
              ),
              config: perTurnConfig,
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
    const warnings = structured?.schemaWarnings ?? [];
    const parsedData = structured && 'data' in structured ? structured.data : undefined;
    const shouldRetry =
      attempt < maxRetries &&
      !ctx.mcpReq.signal.aborted &&
      !askResult.result.isError &&
      askResult.streamResult.finishReason === FinishReason.STOP &&
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

function appendTranscriptPair(
  sessionId: string,
  message: string,
  result: CallToolResult,
  deps: Pick<AskDependencies, 'appendSessionTranscript' | 'now'>,
  taskId?: string,
): void {
  if (result.isError) return;
  const timestamp = deps.now();

  deps.appendSessionTranscript(sessionId, {
    role: 'user',
    text: message,
    timestamp,
    ...(taskId ? { taskId } : {}),
  });
  deps.appendSessionTranscript(sessionId, {
    role: 'assistant',
    text: extractTextContent(result.content),
    timestamp,
    ...(taskId ? { taskId } : {}),
  });
}

function appendSessionTurn(
  sessionId: string,
  askResult: AskExecutionResult,
  args: AskArgs,
  deps: Pick<
    AskDependencies,
    'appendSessionContent' | 'appendSessionEvent' | 'appendSessionTranscript' | 'now'
  >,
  taskId?: string,
  sentArgs: AskArgs = args,
): void {
  appendTranscriptPair(sessionId, args.message, askResult.result, deps, taskId);
  if (askResult.result.isError) return;
  const structured = getAskStructuredContent(askResult.result);
  const timestamp = deps.now();
  const sentMessage = askResult.sentMessage ?? sentArgs.message;

  deps.appendSessionContent(sessionId, {
    role: 'user',
    parts: [{ text: sentMessage }],
    timestamp,
    ...(taskId ? { taskId } : {}),
  });
  deps.appendSessionContent(sessionId, {
    role: 'model',
    parts: buildReplayHistoryParts(askResult.streamResult.parts),
    rawParts: capRawParts(structuredClone(askResult.streamResult.parts)),
    timestamp,
    ...(taskId ? { taskId } : {}),
    ...(askResult.streamResult.finishReason !== undefined
      ? { finishReason: askResult.streamResult.finishReason }
      : {}),
    ...(askResult.streamResult.finishMessage !== undefined
      ? { finishMessage: askResult.streamResult.finishMessage }
      : {}),
    ...(askResult.streamResult.promptBlockReason !== undefined
      ? { promptBlockReason: askResult.streamResult.promptBlockReason }
      : {}),
  });

  deps.appendSessionEvent(sessionId, {
    request: buildSessionEventRequest(args.message, sentMessage, askResult),
    response: buildSessionEventResponse(askResult, structured),
    timestamp,
    ...(taskId ? { taskId } : {}),
  });
}

function buildSessionEventRequest(
  message: string,
  sentMessage: string,
  askResult: AskExecutionResult,
): SessionEventEntry['request'] {
  return {
    message,
    ...(sentMessage !== message ? { sentMessage } : {}),
    ...(askResult.toolProfile !== 'none' ? { toolProfile: askResult.toolProfile } : {}),
    ...(askResult.urls ? { urls: askResult.urls } : {}),
  };
}

function buildSessionEventResponse(
  askResult: AskExecutionResult,
  structured: AskStructuredContent | undefined,
): SessionEventEntry['response'] {
  const { streamResult } = askResult;
  return pickDefined({
    text: extractTextContent(askResult.result.content),
    finishReason: streamResult.finishReason,
    finishMessage: streamResult.finishMessage,
    promptBlockReason: streamResult.promptBlockReason,
    data: structured?.data !== undefined ? sanitizeSessionValue(structured.data) : undefined,
    functionCalls: structured?.functionCalls
      ? sanitizeFunctionCalls(structured.functionCalls)
      : undefined,
    schemaWarnings: structured?.schemaWarnings,
    safetyRatings:
      structured?.safetyRatings !== undefined
        ? sanitizeSessionValue(structured.safetyRatings, 'safetyRatings')
        : undefined,
    citationMetadata:
      structured?.citationMetadata !== undefined
        ? sanitizeSessionValue(structured.citationMetadata, 'citationMetadata')
        : undefined,
    thoughts: structured?.thoughts,
    toolEvents: structured?.toolEvents ? sanitizeToolEvents(structured.toolEvents) : undefined,
    usage: structured?.usage,
    groundingMetadata:
      streamResult.groundingMetadata !== undefined
        ? (sanitizeSessionValue(streamResult.groundingMetadata, 'groundingMetadata') as NonNullable<
            SessionEventEntry['response']['groundingMetadata']
          >)
        : undefined,
    urlContextMetadata:
      streamResult.urlContextMetadata !== undefined
        ? (sanitizeSessionValue(
            streamResult.urlContextMetadata,
            'urlContextMetadata',
          ) as NonNullable<SessionEventEntry['response']['urlContextMetadata']>)
        : undefined,
    promptFeedback:
      streamResult.promptFeedback !== undefined
        ? sanitizeSessionValue(streamResult.promptFeedback, 'promptFeedback')
        : undefined,
    anomalies: streamResult.anomalies !== undefined ? { ...streamResult.anomalies } : undefined,
  });
}

async function resolveWorkspaceCacheName(
  args: AskArgs,
  workspace: ToolWorkspaceAccess,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (
    args.systemInstruction ||
    (args.temperature !== undefined && args.temperature !== DEFAULT_TEMPERATURE) ||
    args.seed !== undefined ||
    !getWorkspaceCacheEnabled()
  ) {
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
  if (args.temperature !== undefined && args.temperature !== DEFAULT_TEMPERATURE) {
    reasons.push('custom temperature');
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
  const orchestration = buildOrchestrationConfig(buildChatOrchestrationRequest(args));
  return {
    tools: orchestration.tools,
    toolConfig: orchestration.toolConfig,
    functionCallingMode: orchestration.functionCallingMode,
    serverSideToolInvocations:
      resolveServerSideToolInvocations(
        args.serverSideToolInvocations,
        orchestration.activeCapabilities,
      ) === true,
  };
}

function canonicalizeSessionContractValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeSessionContractValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeSessionContractValue(nested)]),
    );
  }
  return value;
}

function sameSessionContractValue(left: unknown, right: unknown): boolean {
  // SessionGenerationContract is persisted as plain JSON-shaped data.
  return (
    JSON.stringify(canonicalizeSessionContractValue(left)) ===
    JSON.stringify(canonicalizeSessionContractValue(right))
  );
}

function isCompatibleSessionContract(
  stored: SessionGenerationContract,
  requested: SessionGenerationContract,
): boolean {
  return (
    sameSessionContractValue(stored.model, requested.model) &&
    sameSessionContractValue(stored.systemInstruction, requested.systemInstruction) &&
    sameSessionContractValue(stored.tools, requested.tools) &&
    sameSessionContractValue(stored.toolConfig, requested.toolConfig) &&
    sameSessionContractValue(stored.functionCallingMode, requested.functionCallingMode) &&
    sameSessionContractValue(
      stored.functionCallingInstructionHash,
      requested.functionCallingInstructionHash,
    ) &&
    sameSessionContractValue(stored.responseMimeType, requested.responseMimeType) &&
    sameSessionContractValue(stored.responseJsonSchema, requested.responseJsonSchema)
  );
}

function buildRequestedSessionContract(args: AskArgs): SessionGenerationContract {
  const { toolConfig, tools, functionCallingMode, serverSideToolInvocations } =
    buildAskToolingConfig(args);
  const functionCallingInstructionHash = hashInstructionText(
    buildFunctionCallingInstructionText({
      ...(functionCallingMode !== undefined ? { mode: functionCallingMode } : {}),
      declaredNames: args.functions?.declarations.map((declaration) => declaration.name) ?? [],
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
    ),
    costProfile: 'chat',
  });

  return buildSessionGenerationContract(
    getGeminiModel(),
    config,
    functionCallingMode,
    functionCallingInstructionHash,
  );
}

export function createDefaultAskDependencies(
  sessionAccessOrStore: SessionAccess | SessionStore,
  workspaceOrManager: ToolWorkspaceAccess | ToolWorkspaceCacheManager,
): AskDependencies {
  const sessionAccess = isSessionAccess(sessionAccessOrStore)
    ? sessionAccessOrStore
    : toToolSessionAccess(sessionAccessOrStore);
  const workspace = isWorkspaceAccess(workspaceOrManager)
    ? workspaceOrManager
    : toToolWorkspaceAccess(workspaceOrManager);
  return {
    appendSessionContent: (sessionId, item) => sessionAccess.appendContent(sessionId, item),
    appendSessionEvent: (sessionId, item) => sessionAccess.appendEvent(sessionId, item),
    appendSessionTranscript: (sessionId, item) => sessionAccess.appendTranscript(sessionId, item),
    createChat: (args) => {
      const { toolConfig, tools, functionCallingMode, serverSideToolInvocations } =
        buildAskToolingConfig(args);
      const config = buildGenerateContentConfig({
        ...buildAskGenerationOptions(
          args,
          toolConfig,
          tools,
          functionCallingMode,
          serverSideToolInvocations,
        ),
        costProfile: 'chat',
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
            const { toolConfig, tools, functionCallingMode, serverSideToolInvocations } =
              buildAskToolingConfig(args);
            return buildGenerateContentConfig({
              ...buildAskGenerationOptions(
                rebuildArgs,
                toolConfig,
                tools,
                functionCallingMode,
                serverSideToolInvocations,
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

function addContextSource(
  contextUsed: ContextUsed,
  source: { kind: 'session-summary'; name: string; tokens: number },
): ContextUsed {
  return {
    ...contextUsed,
    sources: [...contextUsed.sources, source],
    totalTokens: contextUsed.totalTokens + source.tokens,
  };
}

async function askExistingSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
  chat: Chat,
  contextUsed?: ContextUsed,
  sessionSummary?: string,
): Promise<CallToolResult | undefined> {
  const functionResponses = normalizeFunctionResponses(args.functionResponses);
  if (functionResponses) {
    appendToolResponseTurn(args.sessionId, functionResponses, deps, ctx.task?.id);
  }

  const resumedArgs = sessionSummary
    ? { ...args, message: `${sessionSummary}\n\n${args.message}` }
    : args;
  const effectiveContextUsed =
    sessionSummary && contextUsed
      ? addContextSource(contextUsed, {
          kind: 'session-summary',
          name: args.sessionId,
          tokens: Math.ceil(sessionSummary.length / 4),
        })
      : contextUsed;

  await mcpLog(ctx, 'debug', `Resuming session ${args.sessionId}`);
  const { progress } = createToolContext('chat', ctx);
  await progress.send(0, undefined, 'Resuming session');
  const askResult = await deps.runWithoutSession(resumedArgs, ctx, chat);
  askResult.result = attachContextUsed(askResult.result, effectiveContextUsed);
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
  contextUsed?: ContextUsed,
): Promise<CallToolResult> {
  await mcpLog(ctx, 'debug', `Creating session ${args.sessionId}`);
  const { chat, contract } = deps.createChat(args);

  const askResult = await deps.runWithoutSession(args, ctx, chat);
  askResult.result = attachContextUsed(askResult.result, contextUsed);

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

export function createAskWork(
  deps: AskDependencies,
  workspaceOrManager?: ToolWorkspaceAccess | ToolWorkspaceCacheManager,
) {
  const workspace = isWorkspaceAccess(workspaceOrManager)
    ? workspaceOrManager
    : toToolWorkspaceAccess(workspaceOrManager);
  return async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
    const prepared = await prepareAskRequest(args, deps, ctx, ctx.mcpReq.signal, workspace);
    if (!isPreparedRequest(prepared)) return prepared;

    const { effectiveArgs, contextUsed, warnings } = prepared;

    if (!effectiveArgs.sessionId) {
      const askResult = await deps.runWithoutSession(effectiveArgs, ctx);
      return appendAskWarnings(attachContextUsed(askResult.result, contextUsed), warnings);
    }

    const sessionId = effectiveArgs.sessionId;
    const liveChat = deps.getSession(sessionId);
    if (liveChat) {
      const resumed = await askExistingSession(
        effectiveArgs as AskArgs & { sessionId: string },
        ctx,
        deps,
        liveChat,
        contextUsed,
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
          contextUsed,
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
      await askNewSession(effectiveArgs as AskArgs & { sessionId: string }, ctx, deps, contextUsed),
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

function sessionResources(sessionId: string) {
  const detail = sessionDetailUri(sessionId);
  if (!getExposeSessionResources()) {
    return { detail };
  }

  return {
    detail,
    events: sessionEventsUri(sessionId),
    transcript: sessionTranscriptUri(sessionId),
    turnParts: sessionTurnPartsUri(sessionId, 0).replace(
      '/turns/0/parts',
      '/turns/{turnIndex}/parts',
    ),
  };
}

function attachSessionMetadata(
  result: CallToolResult,
  sessionId: string,
  rebuiltAt?: number,
): CallToolResult {
  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent;
  return {
    ...result,
    structuredContent:
      structured && typeof structured === 'object'
        ? {
            ...structured,
            session: {
              id: sessionId,
              ...(rebuiltAt !== undefined ? { rebuiltAt } : {}),
            },
          }
        : {
            session: {
              id: sessionId,
              ...(rebuiltAt !== undefined ? { rebuiltAt } : {}),
            },
          },
  };
}

function assembleChatOutput(
  result: CallToolResult,
  sessionIdHint: string | undefined,
  taskId: string | undefined,
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
          resources: sessionResources(sessionId),
          ...(typeof (structured.session as Record<string, unknown>).rebuiltAt === 'number'
            ? {
                rebuiltAt: (structured.session as Record<string, unknown>).rebuiltAt as number,
              }
            : {}),
        }
      : sessionId
        ? {
            id: sessionId,
            resources: sessionResources(sessionId),
          }
        : undefined;
  return createToolContext('chat', ctx).validateOutput(
    ChatOutputSchema,
    pickDefined({
      ...buildBaseStructuredOutput(taskId, [...(warnings ?? []), ...(extraWarnings ?? [])]),
      answer,
      data: structured.data,
      session,
      functionCalls: structured.functionCalls,
      thoughts: structured.thoughts,
      toolEvents: structured.toolEvents,
      usage: structured.usage,
      safetyRatings: structured.safetyRatings,
      finishMessage: structured.finishMessage,
      citationMetadata: structured.citationMetadata,
      contextUsed: structured.contextUsed,
      computations: structured.computations,
      workspaceCacheApplied:
        (structured.contextUsed as ContextUsed | undefined)?.workspaceCacheApplied ?? false,
    }),
    result,
  );
}

export async function chatWork(
  askWork: ReturnType<typeof createAskWork>,
  args: ChatWorkInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
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

  const result = await askWork(
    {
      message: args.goal,
      sessionId: args.sessionId,
      responseSchema,
      maxOutputTokens: args.maxOutputTokens,
      seed: args.seed,
      safetySettings: args.safetySettings,
      codeExecution: args.codeExecution,
      googleSearch: args.googleSearch,
      urls: args.urls,
      fileSearch: args.fileSearch,
      functions: args.functions,
      functionResponses: args.functionResponses,
      serverSideToolInvocations: args.serverSideToolInvocations,
      systemInstruction: args.systemInstruction,
      temperature: args.temperature,
      thinkingLevel: args.thinkingLevel,
      thinkingBudget: args.thinkingBudget,
    },
    ctx,
  );

  return assembleChatOutput(result, args.sessionId, ctx.task?.id, ctx);
}

export function registerChatTool(
  server: McpServer,
  servicesOrSessionStore?: ToolServices | SessionStore,
  workspaceCacheManagerInstance?: ToolWorkspaceCacheManager,
): void {
  const resolvedServices = resolveChatServices(
    servicesOrSessionStore,
    workspaceCacheManagerInstance,
  );
  const askWork = createAskWork(
    createDefaultAskDependencies(resolvedServices.session, resolvedServices.workspace),
    resolvedServices.workspace,
  );

  registerWorkTool<ChatInput>({
    server,
    tool: {
      name: 'chat',
      title: 'Chat',
      description:
        'Direct Gemini chat with optional server-managed sessions and reusable cache memory.',
      inputSchema: createChatInputSchema((prefix) =>
        resolvedServices.session.completeSessionIds(prefix),
      ),
      outputSchema: ChatOutputSchema,
      annotations: READ_ONLY_SESSION_ANNOTATIONS,
    },
    work: (args, ctx) => chatWork(askWork, args, bindToolServices(ctx, resolvedServices)),
  });
}
