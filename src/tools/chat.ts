import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { Validator } from '@cfworker/json-schema';
import type { Chat } from '@google/genai';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildOrchestrationConfig, type ToolProfile } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { sessionDetailUri, sessionEventsUri, sessionTranscriptUri } from '../lib/resource-uris.js';
import {
  buildBaseStructuredOutput,
  buildSharedStructuredMetadata,
  createResourceLink,
  extractTextContent,
  validateStructuredContent,
  withRelatedTaskMeta,
} from '../lib/response.js';
import {
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
import { workspaceCacheManager } from '../lib/workspace-context.js';
import {
  type AskInput,
  type ChatInput,
  createChatInputSchema,
  parseResponseSchemaJsonValue,
} from '../schemas/inputs.js';
import { type GeminiResponseSchema } from '../schemas/json-schema.js';
import { ChatOutputSchema, type ContextUsed, type UsageMetadata } from '../schemas/outputs.js';

import { buildGenerateContentConfig, EXPOSE_THOUGHTS, getAI, MODEL } from '../client.js';
import { getWorkspaceCacheEnabled } from '../config.js';
import {
  createSessionStore,
  type SessionEventEntry,
  type SessionStore,
  type SessionSummary,
  type TranscriptEntry,
} from '../sessions.js';

type AskArgs = AskInput;

interface AskStructuredContent extends Record<string, unknown> {
  answer: string;
  contextUsed?: ContextUsed;
  data?: unknown;
  functionCalls?: FunctionCallEntry[];
  schemaWarnings?: string[];
  thoughts?: string;
  toolEvents?: ToolEvent[];
  usage?: UsageMetadata;
}

interface AskDependencies {
  appendSessionEvent: (sessionId: string, item: SessionEventEntry) => boolean;
  appendSessionTranscript: (sessionId: string, item: TranscriptEntry) => boolean;
  createChat: (args: AskArgs) => Chat;
  getSession: (sessionId: string) => Chat | undefined;
  getSessionEntry: (sessionId: string) => SessionSummary | undefined;
  isEvicted: (sessionId: string) => boolean;
  now: () => number;
  listSessionTranscriptEntries: (sessionId: string) => TranscriptEntry[] | undefined;
  runWithoutSession: (
    args: AskArgs,
    ctx: ServerContext,
    chat?: Chat,
  ) => Promise<AskExecutionResult>;
  setSession: (sessionId: string, chat: Chat) => void;
}

interface AskExecutionResult {
  result: CallToolResult;
  streamResult: StreamResult;
  toolProfile: ToolProfile;
  urls?: string[];
}

const ASK_TOOL_LABEL = 'Chat';
const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;

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

export function buildAskStructuredContent(
  text: string,
  streamResult: Pick<
    StreamResult,
    'functionCalls' | 'thoughtText' | 'toolEvents' | 'usageMetadata'
  >,
  jsonMode?: boolean,
  responseSchema?: GeminiResponseSchema,
  contextUsed?: ContextUsed,
): AskStructuredContent {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : JSON.stringify(parsedData, null, 2);
  const usage = extractUsage(streamResult.usageMetadata);
  const warnings = buildAskWarnings(parsedData, jsonMode, responseSchema);
  const sharedMetadata = buildSharedStructuredMetadata({
    ...(contextUsed ? { contextUsed } : {}),
    functionCalls: streamResult.functionCalls,
    includeThoughts: EXPOSE_THOUGHTS,
    thoughtText: streamResult.thoughtText,
    toolEvents: streamResult.toolEvents,
    usage,
  });

  return {
    answer,
    ...(parsedData !== undefined ? { data: parsedData } : {}),
    ...(warnings.length > 0 ? { schemaWarnings: warnings } : {}),
    ...sharedMetadata,
  };
}

export function formatStructuredResult(
  result: CallToolResult,
  streamResult: Pick<
    StreamResult,
    'functionCalls' | 'thoughtText' | 'toolEvents' | 'usageMetadata'
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

function hasExistingSessionCacheConflict(
  sessionId: string | undefined,
  cacheName: string | undefined,
  hasExistingSession: boolean,
): boolean {
  return !!sessionId && !!cacheName && hasExistingSession;
}

function hasCacheInstructionConflict(
  cacheName: string | undefined,
  systemInstruction: string | undefined,
): boolean {
  return !!cacheName && !!systemInstruction;
}

function hasCacheGenerationControlConflict(
  cacheName: string | undefined,
  temperature: number | undefined,
  seed: number | undefined,
): boolean {
  return !!cacheName && (temperature !== undefined || seed !== undefined);
}

function hasExistingSessionResponseSchemaConflict(
  responseSchema: GeminiResponseSchema | undefined,
  sessionId: string | undefined,
  hasExistingSession: boolean,
): boolean {
  return !!responseSchema && !!sessionId && hasExistingSession;
}

function getAskToolProfile(args: AskArgs): ToolProfile | undefined {
  return 'toolProfile' in args ? args.toolProfile : undefined;
}

function getAskUrls(args: AskArgs): readonly string[] | undefined {
  return 'urls' in args ? args.urls : undefined;
}

function validateAskRequest(
  args: AskArgs,
  deps: Pick<AskDependencies, 'getSessionEntry' | 'isEvicted'>,
): CallToolResult | undefined {
  const { cacheName, responseSchema, seed, sessionId, systemInstruction, temperature } = args;
  const urls = getAskUrls(args);
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  const hasExistingSession = sessionId ? deps.getSessionEntry(sessionId) !== undefined : false;
  const conflicts: [boolean, string][] = [
    [hasExpiredSession(sessionId, deps), `chat: Session '${sessionId}' has expired.`],
    [
      hasExistingSessionCacheConflict(sessionId, cacheName, hasExistingSession),
      'chat: Cannot apply cached content to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
    ],
    [
      hasCacheInstructionConflict(cacheName, systemInstruction),
      'chat: systemInstruction cannot be used with cacheName. Embed the system instruction in the cache via memory action=caches.create instead.',
    ],
    [
      hasCacheGenerationControlConflict(cacheName, temperature, seed),
      'chat: temperature and seed cannot be used with cacheName. Generation parameters are fixed when the cache is created.',
    ],
    [
      hasExistingSessionResponseSchemaConflict(responseSchema, sessionId, hasExistingSession),
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
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

function resolveAskTooling(args: AskArgs) {
  const askToolProfile = getAskToolProfile(args);
  const urls = getAskUrls(args);
  const orchestration = buildOrchestrationConfig({
    googleSearch: args.googleSearch,
    toolProfile: askToolProfile,
    urls,
  });
  const { toolProfile, ...toolConfig } = orchestration;

  return {
    prompt: buildAskPrompt(args.message, orchestration.usesUrlContext ? urls : undefined),
    toolProfile,
    urls: orchestration.usesUrlContext ? [...(urls ?? [])] : undefined,
    ...toolConfig,
  };
}

async function runAskStream(
  ctx: ServerContext,
  streamGenerator: () => ReturnType<ReturnType<typeof getAI>['models']['generateContentStream']>,
  toolProfile: ToolProfile,
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
        resultMod: (baseResult) =>
          formatStructuredResult(baseResult, streamResult, jsonMode, responseSchema),
        reportMessage: hasThoughts ? 'completed with reasoning' : 'completed',
      };
    },
  );

  const streamResult =
    capturedStreamResult ??
    ({
      text: '',
      thoughtText: '',
      parts: [],
      toolsUsed: [],
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

function appendSessionResource(result: CallToolResult, sessionId: string, taskId?: string): void {
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
}

async function askWithoutSession(
  args: AskArgs,
  ctx: ServerContext,
  chat?: Chat,
): Promise<AskExecutionResult> {
  const { prompt, toolConfig, toolProfile, tools, urls, functionCallingMode } =
    resolveAskTooling(args);
  return await runAskStream(
    ctx,
    () =>
      chat
        ? chat.sendMessageStream({
            message: prompt,
            config: buildGenerateContentConfig(
              { ...args, functionCallingMode, toolConfig, tools },
              ctx.mcpReq.signal,
            ),
          })
        : getAI().models.generateContentStream({
            model: MODEL,
            contents: prompt,
            config: buildGenerateContentConfig(
              { ...args, functionCallingMode, toolConfig, tools },
              ctx.mcpReq.signal,
            ),
          }),
    toolProfile,
    urls,
    !!args.responseSchema,
    args.responseSchema,
  );
}

const SESSION_VALUE_MAX_STRING_LENGTH = 2000;
const SESSION_VALUE_MAX_ARRAY_ITEMS = 20;
const SESSION_VALUE_MAX_OBJECT_KEYS = 50;
const SESSION_VALUE_TRUNCATION_SUFFIX = '... [truncated]';

function sanitizeSessionValue(value: unknown): unknown {
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
    return value.slice(0, SESSION_VALUE_MAX_ARRAY_ITEMS).map((item) => sanitizeSessionValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, SESSION_VALUE_MAX_OBJECT_KEYS)
        .map(([key, nestedValue]) => [key, sanitizeSessionValue(nestedValue)]),
    );
  }

  return value;
}

function sanitizeFunctionCalls(functionCalls: FunctionCallEntry[]): FunctionCallEntry[] {
  return functionCalls.map((functionCall) => ({
    ...functionCall,
    ...(functionCall.args
      ? { args: sanitizeSessionValue(functionCall.args) as Record<string, unknown> }
      : {}),
  }));
}

function sanitizeToolEvents(toolEvents: ToolEvent[]): ToolEvent[] {
  return toolEvents.map((toolEvent) => ({
    ...toolEvent,
    ...(toolEvent.args
      ? { args: sanitizeSessionValue(toolEvent.args) as Record<string, unknown> }
      : {}),
    ...(toolEvent.code ? { code: sanitizeSessionValue(toolEvent.code) as string } : {}),
    ...(toolEvent.output ? { output: sanitizeSessionValue(toolEvent.output) as string } : {}),
    ...(toolEvent.response
      ? { response: sanitizeSessionValue(toolEvent.response) as Record<string, unknown> }
      : {}),
    ...(toolEvent.text ? { text: sanitizeSessionValue(toolEvent.text) as string } : {}),
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
  deps: Pick<AskDependencies, 'appendSessionEvent' | 'appendSessionTranscript' | 'now'>,
  taskId?: string,
): void {
  appendTranscriptPair(sessionId, args.message, askResult.result, deps, taskId);
  if (askResult.result.isError) return;
  const structured = getAskStructuredContent(askResult.result);

  deps.appendSessionEvent(sessionId, {
    request: buildSessionEventRequest(args.message, askResult),
    response: buildSessionEventResponse(askResult.result, structured),
    timestamp: deps.now(),
    ...(taskId ? { taskId } : {}),
  });
}

function buildSessionEventRequest(
  message: string,
  askResult: AskExecutionResult,
): SessionEventEntry['request'] {
  return {
    message,
    ...(askResult.toolProfile !== 'none' ? { toolProfile: askResult.toolProfile } : {}),
    ...(askResult.urls ? { urls: askResult.urls } : {}),
  };
}

function buildSessionEventResponse(
  result: CallToolResult,
  structured: AskStructuredContent | undefined,
): SessionEventEntry['response'] {
  return {
    text: extractTextContent(result.content),
    ...buildSessionEventData(structured),
    ...buildSessionEventFunctionCalls(structured),
    ...buildSessionEventSchemaWarnings(structured),
    ...buildSessionEventThoughts(structured),
    ...buildSessionEventToolEvents(structured),
    ...buildSessionEventUsage(structured),
  };
}

function buildSessionEventData(
  structured: AskStructuredContent | undefined,
): Partial<SessionEventEntry['response']> {
  return structured?.data !== undefined ? { data: sanitizeSessionValue(structured.data) } : {};
}

function buildSessionEventFunctionCalls(
  structured: AskStructuredContent | undefined,
): Partial<SessionEventEntry['response']> {
  return structured?.functionCalls
    ? { functionCalls: sanitizeFunctionCalls(structured.functionCalls) }
    : {};
}

function buildSessionEventSchemaWarnings(
  structured: AskStructuredContent | undefined,
): Partial<SessionEventEntry['response']> {
  return structured?.schemaWarnings ? { schemaWarnings: structured.schemaWarnings } : {};
}

function buildSessionEventThoughts(
  structured: AskStructuredContent | undefined,
): Partial<SessionEventEntry['response']> {
  return structured?.thoughts ? { thoughts: structured.thoughts } : {};
}

function buildSessionEventToolEvents(
  structured: AskStructuredContent | undefined,
): Partial<SessionEventEntry['response']> {
  return structured?.toolEvents ? { toolEvents: sanitizeToolEvents(structured.toolEvents) } : {};
}

function buildSessionEventUsage(
  structured: AskStructuredContent | undefined,
): Partial<SessionEventEntry['response']> {
  return structured?.usage ? { usage: structured.usage } : {};
}

async function resolveWorkspaceCacheName(
  args: AskArgs,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (
    args.cacheName ||
    args.systemInstruction ||
    args.temperature !== undefined ||
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
    return await workspaceCacheManager.getOrCreateCache(allowedRoots, signal);
  } catch (err) {
    logger.child('workspace').warn(`Failed to resolve workspace cache: ${String(err)}`);
    return undefined;
  }
}

function createDefaultAskDependencies(sessionStore: SessionStore): AskDependencies {
  return {
    appendSessionEvent: sessionStore.appendSessionEvent.bind(sessionStore),
    appendSessionTranscript: sessionStore.appendSessionTranscript.bind(sessionStore),
    createChat: (args) => {
      const { functionCallingMode, toolConfig, tools } = resolveAskTooling(args);
      return getAI().chats.create({
        model: MODEL,
        config: buildGenerateContentConfig({ ...args, functionCallingMode, toolConfig, tools }),
      });
    },
    getSession: sessionStore.getSession.bind(sessionStore),
    getSessionEntry: sessionStore.getSessionEntry.bind(sessionStore),
    isEvicted: sessionStore.isEvicted.bind(sessionStore),
    listSessionTranscriptEntries: sessionStore.listSessionTranscriptEntries.bind(sessionStore),
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
  contextUsed?: ContextUsed,
): Promise<CallToolResult | undefined> {
  const chat = deps.getSession(args.sessionId);
  if (!chat) return undefined;

  const sessionSummary = buildSessionSummary(
    deps.listSessionTranscriptEntries(args.sessionId) ?? [],
  );
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
  appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
  return askResult.result;
}

async function askNewSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
  contextUsed?: ContextUsed,
): Promise<CallToolResult> {
  await ctx.mcpReq.log('debug', `Creating session ${args.sessionId}`);
  const chat = deps.createChat(args);

  const askResult = await deps.runWithoutSession(args, ctx, chat);
  askResult.result = attachContextUsed(askResult.result, contextUsed);

  if (!askResult.result.isError) {
    deps.setSession(args.sessionId, chat);
    appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
    appendSessionResource(askResult.result, args.sessionId, ctx.task?.id);
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
): Promise<PreparedAskRequest | CallToolResult> {
  const validationError = validateAskRequest(args, deps);
  if (validationError) return validationError;

  const canUseWorkspaceCache =
    !args.sessionId || deps.getSessionEntry(args.sessionId) === undefined;
  const workspaceCacheName = canUseWorkspaceCache
    ? await resolveWorkspaceCacheName(args, signal)
    : undefined;
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
) {
  return async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
    const prepared = await prepareAskRequest(args, deps, ctx.mcpReq.signal);
    if (!isPreparedRequest(prepared)) return prepared;

    const { effectiveArgs, contextUsed } = prepared;

    if (!effectiveArgs.sessionId) {
      const askResult = await deps.runWithoutSession(effectiveArgs, ctx);
      return attachContextUsed(askResult.result, contextUsed);
    }

    const resumed = await askExistingSession(
      effectiveArgs as AskArgs & { sessionId: string },
      ctx,
      deps,
      contextUsed,
    );
    if (resumed) return resumed;

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
  const structuredContent = validateStructuredContent('chat', ChatOutputSchema, {
    ...buildBaseStructuredOutput(taskId, warnings),
    answer,
    ...(structured.data !== undefined ? { data: structured.data } : {}),
    ...(sessionId
      ? {
          session: {
            id: sessionId,
            resources: sessionResources(sessionId),
          },
        }
      : {}),
    ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
    ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
    ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
    ...(structured.usage ? { usage: structured.usage } : {}),
    ...(structured.contextUsed ? { contextUsed: structured.contextUsed } : {}),
  });

  return {
    ...result,
    structuredContent,
  };
}

export async function chatWork(
  askWork: ReturnType<typeof createAskWork>,
  args: ChatInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result = await askWork(
    {
      message: args.goal,
      sessionId: args.sessionId,
      cacheName: args.cacheName,
      responseSchema:
        args.responseSchemaJson !== undefined
          ? parseResponseSchemaJsonValue(args.responseSchemaJson)
          : undefined,
      seed: args.seed,
      systemInstruction: args.systemInstruction,
      temperature: args.temperature,
      thinkingLevel: args.thinkingLevel,
    },
    ctx,
  );

  return assembleChatOutput(result, args.sessionId, ctx.task?.id);
}

export function registerChatTool(
  server: McpServer,
  sessionStore: SessionStore,
  taskMessageQueue: TaskMessageQueue,
): void {
  const askWork = createAskWork(createDefaultAskDependencies(sessionStore));

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
