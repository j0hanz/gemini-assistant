import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { Validator } from '@cfworker/json-schema';
import { FinishReason, FunctionCallingConfigMode } from '@google/genai';
import type {
  Chat,
  Content,
  FunctionDeclaration,
  FunctionResponse,
  GenerateContentConfig,
  PartListUnion,
} from '@google/genai';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { appendFunctionCallingInstruction } from '../lib/model-prompts.js';
import { pickDefined } from '../lib/object.js';
import {
  buildOrchestrationConfig,
  type BuiltInToolSpec,
  resolveOrchestration,
} from '../lib/orchestration.js';
import { validateGeminiRequest } from '../lib/preflight.js';
import { ProgressReporter } from '../lib/progress.js';
import { selectReplayWindow } from '../lib/replay-window.js';
import {
  sessionDetailUri,
  sessionEventsUri,
  sessionTranscriptUri,
  sessionTurnPartsUri,
} from '../lib/resource-uris.js';
import {
  buildBaseStructuredOutput,
  buildSharedStructuredMetadata,
  createResourceLink,
  extractTextContent,
  safeValidateStructuredContent,
  withRelatedTaskMeta,
} from '../lib/response.js';
import {
  deriveComputationsFromToolEvents,
  extractUsage,
  type FunctionCallEntry,
  type StreamResult,
  type ToolEvent,
} from '../lib/streaming.js';
import { MUTABLE_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { getAllowedRoots, validateUrls } from '../lib/validation.js';
import {
  buildContextUsed,
  buildSessionSummary,
  emptyContextUsed,
} from '../lib/workspace-context.js';
import { workspaceCacheManager, type WorkspaceCacheManagerImpl } from '../lib/workspace-context.js';
import {
  type AskInput,
  type ChatInput,
  createChatInputSchema,
  parseResponseSchemaJsonValue,
} from '../schemas/inputs.js';
import { type GeminiResponseSchema } from '../schemas/json-schema.js';
import { ChatOutputSchema, type ContextUsed, type UsageMetadata } from '../schemas/outputs.js';

import {
  buildGenerateContentConfig,
  DEFAULT_TEMPERATURE,
  EXPOSE_THOUGHTS,
  getAI,
  MODEL,
} from '../client.js';
import {
  getSessionLimits,
  getSessionRedactionPatterns,
  getWorkspaceCacheEnabled,
} from '../config.js';
import {
  buildReplayHistoryParts,
  capRawParts,
  type ContentEntry,
  createSessionStore,
  type SessionEventEntry,
  type SessionGenerationContract,
  type SessionStore,
  type SessionSummary,
  type TranscriptEntry,
} from '../sessions.js';

type WithOptionalTemperature<T> = T extends { temperature: infer Temperature }
  ? Omit<T, 'temperature'> & { temperature?: Temperature }
  : T;
export type AskArgs = WithOptionalTemperature<AskInput> & { cacheName?: string };

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

const ASK_TOOL_LABEL = 'Chat';
const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;
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

function tryParseJsonResponse(text: string): unknown {
  const candidates = [text.trim()];
  const fencedMatch = JSON_CODE_BLOCK_PATTERN.exec(text)?.[1]?.trim();
  if (fencedMatch && fencedMatch !== candidates[0]) {
    candidates.push(fencedMatch);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Ignore invalid JSON candidates and fall back to raw text output.
    }
  }

  return undefined;
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

function buildRepairPromptSuffix(warnings: string[]): string {
  const warningText = warnings
    .map((warning) => `- ${warning}`)
    .join('\n')
    .slice(0, JSON_REPAIR_WARNING_TEXT_LIMIT);

  return `\n\nCRITICAL: The previous response was invalid JSON or failed schema validation. Error(s):\n${warningText}\nReturn ONLY valid JSON that conforms exactly to the provided schema.`;
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
  const sharedMetadata = buildSharedStructuredMetadata({
    ...(contextUsed ? { contextUsed } : {}),
    functionCalls: streamResult.functionCalls,
    includeThoughts: EXPOSE_THOUGHTS,
    thoughtText: streamResult.thoughtText,
    toolEvents: streamResult.toolEvents,
    usage,
    safetyRatings: streamResult.safetyRatings,
    finishMessage: streamResult.finishMessage,
    citationMetadata: streamResult.citationMetadata,
  });

  return {
    answer,
    ...(parsedData !== undefined ? { data: parsedData } : {}),
    ...(computations.length > 0 ? { computations } : {}),
    ...(warnings.length > 0 ? { schemaWarnings: warnings } : {}),
    ...sharedMetadata,
  };
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

function hasExpiredSession(
  sessionId: string | undefined,
  deps: Pick<AskDependencies, 'isEvicted'>,
): boolean {
  return !!sessionId && deps.isEvicted(sessionId);
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
  }
}

function buildChatOrchestrationRequest(args: AskArgs) {
  const urls = getAskUrls(args);
  const builtInToolSpecs: BuiltInToolSpec[] = [];
  if (args.googleSearch) builtInToolSpecs.push({ kind: 'googleSearch' });
  if ((urls?.length ?? 0) > 0) builtInToolSpecs.push({ kind: 'urlContext' });
  if (args.codeExecution) builtInToolSpecs.push({ kind: 'codeExecution' });
  if (args.fileSearch) {
    builtInToolSpecs.push({
      kind: 'fileSearch',
      fileSearchStoreNames: args.fileSearch.fileSearchStoreNames,
      ...(args.fileSearch.metadataFilter !== undefined
        ? { metadataFilter: args.fileSearch.metadataFilter }
        : {}),
    });
  }
  return {
    builtInToolSpecs,
    functionDeclarations: buildFunctionDeclarations(args),
    functionCallingMode: toFunctionCallingConfigMode(args.functions?.mode),
    serverSideToolInvocations: args.serverSideToolInvocations,
    ...(urls ? { urls } : {}),
  } as const;
}

function validateAskRequest(
  args: AskArgs,
  deps: Pick<AskDependencies, 'getSessionEntry' | 'isEvicted'>,
): CallToolResult | undefined {
  const { responseSchema, sessionId } = args;
  const urls = getAskUrls(args);
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  const hasExistingSession = sessionId ? deps.getSessionEntry(sessionId) !== undefined : false;
  const hasFunctionResponses = (args.functionResponses?.length ?? 0) > 0;
  const orchestration = buildOrchestrationConfig(buildChatOrchestrationRequest(args));
  const preflightResult = validateGeminiRequest({
    hasExistingSession,
    jsonMode: responseSchema !== undefined,
    responseSchema,
    sessionId,
    activeCapabilities: orchestration.activeCapabilities,
    fileSearchStoreNames: args.fileSearch?.fileSearchStoreNames,
  });
  if (preflightResult) {
    return preflightResult;
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
    ...(response.id !== undefined ? { id: response.id } : {}),
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
  } as const;
}

export function buildRebuiltChatContents(contents: ContentEntry[], maxBytes: number): Content[] {
  return selectReplayWindow(contents, maxBytes)
    .kept.map((entry) => ({
      role: entry.role,
      parts: buildReplayHistoryParts(structuredClone(entry.parts)),
    }))
    .filter((content) => content.parts.length > 0);
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
): SessionGenerationContract {
  return pickDefined({
    model,
    systemInstruction: config.systemInstruction,
    tools: config.tools,
    toolConfig: config.toolConfig,
    functionCallingMode,
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
    systemInstruction: cacheName ? undefined : contract.systemInstruction,
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
) {
  return {
    ...args,
    systemInstruction: appendFunctionCallingInstruction(
      args.systemInstruction,
      args.functions?.declarations.length ? true : false,
    ),
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
  const progress = new ProgressReporter(ctx, ASK_TOOL_LABEL);
  await progress.send(0, undefined, 'Preparing');

  let capturedStreamResult: StreamResult | undefined;
  const result = await executor.runStream(
    ctx,
    'chat',
    ASK_TOOL_LABEL,
    streamGenerator,
    (streamResult) => {
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
  );

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
  const jsonMode = !!args.responseSchema;
  const config = buildGenerateContentConfig(
    {
      ...buildAskGenerationOptions(args, toolConfig, tools, functionCallingMode),
      costProfile: 'chat',
    },
    ctx.mcpReq.signal,
  );
  const maxRetries = jsonMode && !ctx.mcpReq.signal.aborted ? JSON_REPAIR_MAX_RETRIES : 0;
  let currentPrompt = prompt;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptConfig =
      attempt === 0
        ? config
        : buildGenerateContentConfig(
            {
              ...buildAskGenerationOptions(args, toolConfig, tools, functionCallingMode),
              costProfile: 'chat.jsonRepair',
              thinkingLevel: 'MINIMAL',
              maxOutputTokens: 2_048,
            },
            ctx.mcpReq.signal,
          );
    const perTurnConfig = buildPerTurnConfig(attemptConfig);
    const askResult = await runAskStream(
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
              model: MODEL,
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
      return { ...askResult, sentMessage: currentPrompt };
    }

    logger.child('chat').debug('Retrying JSON response with repair suffix', {
      attempt: attempt + 1,
      warningCount: warnings.length,
      hadParsedData: parsedData !== undefined,
    });
    currentPrompt = `${prompt}${buildRepairPromptSuffix(warnings)}`;
  }

  throw new Error('chat: unreachable JSON repair retry state');
}

const SESSION_VALUE_MAX_STRING_LENGTH = 2000;
const SESSION_VALUE_MAX_ARRAY_ITEMS = 20;
const SESSION_VALUE_MAX_OBJECT_KEYS = 50;
const SESSION_VALUE_TRUNCATION_SUFFIX = '... [truncated]';
const SESSION_REDACTION_PATTERNS = getSessionRedactionPatterns();

function shouldRedactSessionValue(keyContext?: string): boolean {
  if (!keyContext) return false;
  return SESSION_REDACTION_PATTERNS.some((pattern) => pattern.test(keyContext));
}

function sanitizeSessionValue(value: unknown, keyContext?: string): unknown {
  if (shouldRedactSessionValue(keyContext)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    if (value.length <= SESSION_VALUE_MAX_STRING_LENGTH) {
      return value;
    }

    const maxPrefixLength = Math.max(
      SESSION_VALUE_MAX_STRING_LENGTH - SESSION_VALUE_TRUNCATION_SUFFIX.length,
      0,
    );
    return `${value.slice(0, maxPrefixLength)}${SESSION_VALUE_TRUNCATION_SUFFIX}`;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, SESSION_VALUE_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeSessionValue(item, keyContext));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, SESSION_VALUE_MAX_OBJECT_KEYS)
        .map(([key, nestedValue]) => [key, sanitizeSessionValue(nestedValue, key)]),
    );
  }

  return value;
}

function sanitizeFunctionCalls(functionCalls: FunctionCallEntry[]): FunctionCallEntry[] {
  return functionCalls.map((functionCall) => ({
    ...functionCall,
    ...(functionCall.args
      ? { args: sanitizeSessionValue(functionCall.args, 'args') as Record<string, unknown> }
      : {}),
  }));
}

function sanitizeToolEvents(toolEvents: ToolEvent[]): ToolEvent[] {
  return toolEvents.map((toolEvent) => ({
    ...toolEvent,
    ...(toolEvent.args
      ? { args: sanitizeSessionValue(toolEvent.args, 'args') as Record<string, unknown> }
      : {}),
    ...(toolEvent.code !== undefined
      ? { code: sanitizeSessionValue(toolEvent.code, 'code') as string }
      : {}),
    ...(toolEvent.output !== undefined
      ? { output: sanitizeSessionValue(toolEvent.output, 'output') as string }
      : {}),
    ...(toolEvent.response
      ? {
          response: sanitizeSessionValue(toolEvent.response, 'response') as Record<string, unknown>,
        }
      : {}),
    ...(toolEvent.text !== undefined
      ? { text: sanitizeSessionValue(toolEvent.text, 'text') as string }
      : {}),
  }));
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

export function appendToolResponseTurn(
  sessionId: string,
  responses: FunctionResponse[],
  deps: Pick<AskDependencies, 'appendSessionContent' | 'now'>,
  taskId?: string,
): boolean {
  if (responses.length === 0) return true;
  return deps.appendSessionContent(sessionId, {
    role: 'user',
    parts: responses.map((functionResponse) => ({ functionResponse })),
    timestamp: deps.now(),
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
  signal?: AbortSignal,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
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
    const allowedRoots = await getAllowedRoots();
    if (allowedRoots.length === 0) {
      return undefined;
    }
    return await workspaceCacheManagerInstance.getOrCreateCache(allowedRoots, signal);
  } catch (err) {
    logger.child('workspace').warn(`Failed to resolve workspace cache: ${String(err)}`);
    return undefined;
  }
}

function buildAskToolingConfig(args: AskArgs) {
  const orchestration = buildOrchestrationConfig(buildChatOrchestrationRequest(args));
  return {
    tools: orchestration.tools,
    toolConfig: orchestration.toolConfig,
    functionCallingMode: orchestration.functionCallingMode,
  };
}

export function createDefaultAskDependencies(sessionStore: SessionStore): AskDependencies {
  return {
    appendSessionContent: sessionStore.appendSessionContent.bind(sessionStore),
    appendSessionEvent: sessionStore.appendSessionEvent.bind(sessionStore),
    appendSessionTranscript: sessionStore.appendSessionTranscript.bind(sessionStore),
    createChat: (args) => {
      const { toolConfig, tools, functionCallingMode } = buildAskToolingConfig(args);
      const config = buildGenerateContentConfig({
        ...buildAskGenerationOptions(args, toolConfig, tools, functionCallingMode),
        costProfile: 'chat',
      });
      const chat = getAI().chats.create({
        model: MODEL,
        config,
      });
      return {
        chat,
        contract: buildSessionGenerationContract(MODEL, config, functionCallingMode),
      };
    },
    getSession: sessionStore.getSession.bind(sessionStore),
    getSessionEntry: sessionStore.getSessionEntry.bind(sessionStore),
    isEvicted: sessionStore.isEvicted.bind(sessionStore),
    listSessionContentEntries: sessionStore.listSessionContentEntries.bind(sessionStore),
    listSessionTranscriptEntries: sessionStore.listSessionTranscriptEntries.bind(sessionStore),
    rebuildChat: (sessionId, args) => {
      const contents = sessionStore.listSessionContentEntries(sessionId) ?? [];
      if (contents.length === 0) {
        return undefined;
      }

      const sessionEntry = sessionStore.getSessionEntry(sessionId);
      const contract = sessionEntry?.contract;
      const cacheName = sessionEntry?.cacheName;
      const activeCacheName = workspaceCacheManager.getCacheStatus().cacheName;
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
            const { toolConfig, tools, functionCallingMode } = buildAskToolingConfig(args);
            return buildGenerateContentConfig({
              ...buildAskGenerationOptions(rebuildArgs, toolConfig, tools, functionCallingMode),
              costProfile: 'chat',
            });
          })();
      const chat = getAI().chats.create({
        model: contract?.model ?? MODEL,
        config,
        history: buildRebuiltChatContents(contents, getSessionLimits().replayMaxBytes),
      });
      sessionStore.replaceSession(sessionId, chat);
      return chat;
    },
    now: () => Date.now(),
    runWithoutSession: askWithoutSession,
    setSession: sessionStore.setSession.bind(sessionStore),
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

  await ctx.mcpReq.log('debug', `Resuming session ${args.sessionId}`);
  const progress = new ProgressReporter(ctx, ASK_TOOL_LABEL);
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
  await ctx.mcpReq.log('debug', `Creating session ${args.sessionId}`);
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
    await ctx.mcpReq.log('debug', `Session ${args.sessionId} not stored due to stream error`);
  }

  return askResult.result;
}

interface PreparedAskRequest {
  effectiveArgs: AskArgs;
  contextUsed: ContextUsed;
}

async function prepareAskRequest(
  args: AskArgs,
  deps: AskDependencies,
  signal: AbortSignal,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
): Promise<PreparedAskRequest | CallToolResult> {
  const validationError = validateAskRequest(args, deps);
  if (validationError) return validationError;

  const persistedCacheName = args.sessionId
    ? deps.getSessionEntry(args.sessionId)?.cacheName
    : undefined;
  const canUseWorkspaceCache =
    !persistedCacheName && (!args.sessionId || deps.getSessionEntry(args.sessionId) === undefined);
  const workspaceCacheName = canUseWorkspaceCache
    ? await resolveWorkspaceCacheName(args, signal, workspaceCacheManagerInstance)
    : persistedCacheName;
  const contextUsed = workspaceCacheName
    ? buildContextUsed(
        [{ kind: 'workspace-cache', name: workspaceCacheName, tokens: 0, relevanceScore: 1 }],
        0,
        true,
      )
    : emptyContextUsed();
  const effectiveArgs = workspaceCacheName ? { ...args, cacheName: workspaceCacheName } : args;

  return { effectiveArgs, contextUsed };
}

function isPreparedRequest(
  value: PreparedAskRequest | CallToolResult,
): value is PreparedAskRequest {
  return 'effectiveArgs' in value;
}

export function createAskWork(
  deps: AskDependencies = createDefaultAskDependencies(createSessionStore()),
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
) {
  return async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
    const prepared = await prepareAskRequest(
      args,
      deps,
      ctx.mcpReq.signal,
      workspaceCacheManagerInstance,
    );
    if (!isPreparedRequest(prepared)) return prepared;

    const { effectiveArgs, contextUsed } = prepared;

    if (!effectiveArgs.sessionId) {
      const askResult = await deps.runWithoutSession(effectiveArgs, ctx);
      return attachContextUsed(askResult.result, contextUsed);
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
      if (resumed) return resumed;
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
        if (resumed) return resumed;
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

    return await askNewSession(
      effectiveArgs as AskArgs & { sessionId: string },
      ctx,
      deps,
      contextUsed,
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
  return {
    detail: sessionDetailUri(sessionId),
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
  return safeValidateStructuredContent(
    'chat',
    ChatOutputSchema,
    pickDefined({
      ...buildBaseStructuredOutput(taskId, warnings),
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
      workspaceCacheApplied:
        (structured.contextUsed as ContextUsed | undefined)?.workspaceCacheApplied ?? false,
    }),
    result,
  );
}

export async function chatWork(
  askWork: ReturnType<typeof createAskWork>,
  args: ChatInput,
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

  return assembleChatOutput(result, args.sessionId, ctx.task?.id);
}

export function registerChatTool(
  server: McpServer,
  sessionStore: SessionStore,
  taskMessageQueue: TaskMessageQueue,
  workspaceCacheManagerInstance: WorkspaceCacheManagerImpl = workspaceCacheManager,
): void {
  const askWork = createAskWork(
    createDefaultAskDependencies(sessionStore),
    workspaceCacheManagerInstance,
  );

  registerTaskTool(
    server,
    'chat',
    {
      title: 'Chat',
      description:
        'Direct Gemini chat with optional server-managed sessions and reusable cache memory.',
      inputSchema: createChatInputSchema(sessionStore.completeSessionIds.bind(sessionStore)),
      outputSchema: ChatOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: ChatInput, ctx: ServerContext) => chatWork(askWork, args, ctx),
  );
}
