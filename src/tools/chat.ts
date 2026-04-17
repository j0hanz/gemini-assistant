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
import {
  buildBaseStructuredOutput,
  buildSharedStructuredMetadata,
  createResourceLink,
  extractTextContent,
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
import { workspaceCacheManager } from '../lib/workspace-context.js';
import {
  type AskInput,
  type ChatInput,
  createAskInputSchema,
  createChatInputSchema,
} from '../schemas/inputs.js';
import { type GeminiResponseSchema } from '../schemas/json-schema.js';
import { AskOutputSchema, ChatOutputSchema, type UsageMetadata } from '../schemas/outputs.js';

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

export interface AskStructuredContent extends Record<string, unknown> {
  answer: string;
  data?: unknown;
  functionCalls?: FunctionCallEntry[];
  schemaWarnings?: string[];
  thoughts?: string;
  toolEvents?: ToolEvent[];
  usage?: UsageMetadata;
  workspaceCache?: WorkspaceCacheMetadata;
}

export interface WorkspaceCacheMetadata {
  applied: true;
  cacheName: string;
}

interface AskDependencies {
  appendSessionEvent: (sessionId: string, item: SessionEventEntry) => boolean;
  appendSessionTranscript: (sessionId: string, item: TranscriptEntry) => boolean;
  createChat: (args: AskArgs) => Chat;
  getSession: (sessionId: string) => Chat | undefined;
  getSessionEntry: (sessionId: string) => SessionSummary | undefined;
  isEvicted: (sessionId: string) => boolean;
  now: () => number;
  runWithoutSession: (
    args: AskArgs,
    ctx: ServerContext,
    chat?: Chat,
    workspaceCache?: WorkspaceCacheMetadata,
  ) => Promise<AskExecutionResult>;
  setSession: (sessionId: string, chat: Chat) => void;
}

interface AskExecutionResult {
  result: CallToolResult;
  streamResult: StreamResult;
  toolProfile: ToolProfile;
  urls?: string[];
}

const ASK_TOOL_LABEL = 'Ask Gemini';
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
  workspaceCache?: WorkspaceCacheMetadata,
): AskStructuredContent {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : JSON.stringify(parsedData, null, 2);
  const usage = extractUsage(streamResult.usageMetadata);
  const warnings = buildAskWarnings(parsedData, jsonMode, responseSchema);
  const sharedMetadata = buildSharedStructuredMetadata({
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
    ...(workspaceCache ? { workspaceCache } : {}),
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
  workspaceCache?: WorkspaceCacheMetadata,
): CallToolResult {
  if (result.isError) return result;
  const structured = buildAskStructuredContent(
    extractTextContent(result.content),
    streamResult,
    jsonMode,
    responseSchema,
    workspaceCache,
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

function attachWorkspaceCacheMetadata(
  result: CallToolResult,
  workspaceCache?: WorkspaceCacheMetadata,
): CallToolResult {
  if (!workspaceCache || result.isError) {
    return result;
  }

  const structured = getAskStructuredContent(result) ?? {
    answer: extractTextContent(result.content),
  };

  return {
    ...result,
    structuredContent: {
      ...structured,
      workspaceCache,
    },
  };
}

function validateAskConflict(condition: boolean, message: string): CallToolResult | undefined {
  return condition ? new AppError('ask', message).toToolResult() : undefined;
}

function validateAskRequest(
  { cacheName, responseSchema, seed, sessionId, systemInstruction, temperature, urls }: AskArgs,
  deps: Pick<AskDependencies, 'getSessionEntry' | 'isEvicted'>,
): CallToolResult | undefined {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  const hasExistingSession = sessionId ? deps.getSessionEntry(sessionId) !== undefined : false;
  return (
    validateAskConflict(
      !!sessionId && deps.isEvicted(sessionId),
      `ask: Session '${sessionId}' has expired.`,
    ) ??
    validateAskConflict(
      !!sessionId && !!cacheName && hasExistingSession,
      'ask: Cannot apply a cachedContent to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
    ) ??
    validateAskConflict(
      !!cacheName && !!systemInstruction,
      'ask: systemInstruction cannot be used with cacheName. Embed the system instruction in the cache via create_cache instead.',
    ) ??
    validateAskConflict(
      !!cacheName && (temperature !== undefined || seed !== undefined),
      'ask: temperature and seed cannot be used with cacheName. Generation parameters are fixed at cache creation time.',
    ) ??
    validateAskConflict(
      !!responseSchema && !!sessionId && hasExistingSession,
      'ask: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    )
  );
}

function buildAskPrompt(message: string, urls?: readonly string[]): string {
  if (!urls || urls.length === 0) {
    return message;
  }

  return `${message}\n\nUse these URLs too:\n${urls.join('\n')}`;
}

function resolveAskTooling(args: AskArgs) {
  const orchestration = buildOrchestrationConfig({
    googleSearch: args.googleSearch,
    toolProfile: args.toolProfile,
    urls: args.urls,
  });
  const { toolProfile, ...toolConfig } = orchestration;

  return {
    prompt: buildAskPrompt(args.message, orchestration.usesUrlContext ? args.urls : undefined),
    toolProfile,
    urls: orchestration.usesUrlContext ? [...(args.urls ?? [])] : undefined,
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
  workspaceCache?: WorkspaceCacheMetadata,
): Promise<AskExecutionResult> {
  const progress = new ProgressReporter(ctx, ASK_TOOL_LABEL);
  await progress.send(0, undefined, 'Preparing');

  let capturedStreamResult: StreamResult | undefined;
  const result = await executor.runStream(
    ctx,
    'ask',
    ASK_TOOL_LABEL,
    streamGenerator,
    (streamResult) => {
      capturedStreamResult = streamResult;
      const hasThoughts = streamResult.thoughtText.length > 0;

      return {
        resultMod: (baseResult) =>
          formatStructuredResult(
            baseResult,
            streamResult,
            jsonMode,
            responseSchema,
            workspaceCache,
          ),
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

function appendSessionResource(result: CallToolResult, sessionId: string): void {
  if (result.isError) return;
  result.content.push(
    createResourceLink(`memory://sessions/${sessionId}`, `Chat Session ${sessionId}`),
  );
  result.content.push(
    createResourceLink(`memory://sessions/${sessionId}/events`, `Chat Session ${sessionId} Events`),
  );
}

async function askWithoutSession(
  args: AskArgs,
  ctx: ServerContext,
  chat?: Chat,
  workspaceCache?: WorkspaceCacheMetadata,
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
    workspaceCache,
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
    request: {
      message: args.message,
      ...(askResult.toolProfile !== 'none' ? { toolProfile: askResult.toolProfile } : {}),
      ...(askResult.urls ? { urls: askResult.urls } : {}),
    },
    response: {
      text: extractTextContent(askResult.result.content),
      ...(structured?.data !== undefined ? { data: sanitizeSessionValue(structured.data) } : {}),
      ...(structured?.functionCalls
        ? { functionCalls: sanitizeFunctionCalls(structured.functionCalls) }
        : {}),
      ...(structured?.schemaWarnings ? { schemaWarnings: structured.schemaWarnings } : {}),
      ...(structured?.thoughts ? { thoughts: structured.thoughts } : {}),
      ...(structured?.toolEvents ? { toolEvents: sanitizeToolEvents(structured.toolEvents) } : {}),
      ...(structured?.usage ? { usage: structured.usage } : {}),
      ...(structured?.workspaceCache ? { workspaceCache: structured.workspaceCache } : {}),
    },
    timestamp: deps.now(),
    ...(taskId ? { taskId } : {}),
  });
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

export function createDefaultAskDependencies(sessionStore: SessionStore): AskDependencies {
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
    now: () => Date.now(),
    runWithoutSession: askWithoutSession,
    setSession: sessionStore.setSession.bind(sessionStore),
  };
}

async function askExistingSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
  workspaceCache?: WorkspaceCacheMetadata,
): Promise<CallToolResult | undefined> {
  const chat = deps.getSession(args.sessionId);
  if (!chat) return undefined;

  await ctx.mcpReq.log('debug', `Resuming session ${args.sessionId}`);
  const progress = new ProgressReporter(ctx, ASK_TOOL_LABEL);
  await progress.send(0, undefined, 'Resuming session');
  const askResult = await deps.runWithoutSession(args, ctx, chat, workspaceCache);
  askResult.result = attachWorkspaceCacheMetadata(askResult.result, workspaceCache);
  appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
  return askResult.result;
}

async function askNewSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
  workspaceCache?: WorkspaceCacheMetadata,
): Promise<CallToolResult> {
  await ctx.mcpReq.log('debug', `Creating session ${args.sessionId}`);
  const chat = deps.createChat(args);

  const askResult = await deps.runWithoutSession(args, ctx, chat, workspaceCache);
  askResult.result = attachWorkspaceCacheMetadata(askResult.result, workspaceCache);

  if (!askResult.result.isError) {
    deps.setSession(args.sessionId, chat);
    appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
    appendSessionResource(askResult.result, args.sessionId);
  } else {
    await ctx.mcpReq.log('debug', `Session ${args.sessionId} not stored due to stream error`);
  }

  return askResult.result;
}

export function createAskWork(
  deps: AskDependencies = createDefaultAskDependencies(createSessionStore()),
) {
  return async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
    const validationError = validateAskRequest(args, deps);
    if (validationError) return validationError;

    const canUseWorkspaceCache =
      !args.sessionId || deps.getSessionEntry(args.sessionId) === undefined;
    const workspaceCacheName = canUseWorkspaceCache
      ? await resolveWorkspaceCacheName(args, ctx.mcpReq.signal)
      : undefined;
    const workspaceCache = workspaceCacheName
      ? ({ applied: true, cacheName: workspaceCacheName } as const)
      : undefined;
    const effectiveArgs = workspaceCacheName ? { ...args, cacheName: workspaceCacheName } : args;

    if (!effectiveArgs.sessionId) {
      const askResult = await deps.runWithoutSession(effectiveArgs, ctx, undefined, workspaceCache);
      return attachWorkspaceCacheMetadata(askResult.result, workspaceCache);
    }

    const resumed = await askExistingSession(
      effectiveArgs as AskArgs & { sessionId: string },
      ctx,
      deps,
      workspaceCache,
    );
    if (resumed) return resumed;

    return await askNewSession(
      effectiveArgs as AskArgs & { sessionId: string },
      ctx,
      deps,
      workspaceCache,
    );
  };
}

export function registerAskTool(
  server: McpServer,
  sessionStore: SessionStore,
  taskMessageQueue: TaskMessageQueue,
): void {
  const askWork = createAskWork(createDefaultAskDependencies(sessionStore));
  registerTaskTool(
    server,
    'ask',
    {
      title: 'Ask Gemini',
      description: 'Send a message to Gemini. Supports multi-turn chat via sessionId.',
      inputSchema: createAskInputSchema(sessionStore.completeSessionIds.bind(sessionStore)),
      outputSchema: AskOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    taskMessageQueue,
    askWork,
  );
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
    detail: `memory://sessions/${sessionId}`,
    events: `memory://sessions/${sessionId}/events`,
    transcript: `memory://sessions/${sessionId}/transcript`,
  };
}

async function chatWork(
  askWork: ReturnType<typeof createAskWork>,
  args: ChatInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result = await askWork(
    {
      message: args.goal,
      sessionId: args.session?.id,
      cacheName: args.memory?.cacheName,
      responseSchema: args.responseSchema,
      seed: args.seed,
      systemInstruction: args.systemInstruction,
      temperature: args.temperature,
      thinkingLevel: args.thinkingLevel,
    },
    ctx,
  );

  if (result.isError) {
    return result;
  }

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const answer =
    typeof structured.answer === 'string' ? structured.answer : extractTextContent(result.content);
  const warnings = Array.isArray(structured.schemaWarnings)
    ? structured.schemaWarnings.filter((value): value is string => typeof value === 'string')
    : undefined;
  const sessionId = extractSessionId(result, args.session?.id);

  return {
    ...result,
    structuredContent: {
      ...buildBaseStructuredOutput(ctx.task?.id, warnings),
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
      ...(structured.workspaceCache ? { workspaceCache: structured.workspaceCache } : {}),
    },
  };
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
