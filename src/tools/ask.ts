import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Validator } from '@cfworker/json-schema';
import type { Chat } from '@google/genai';

import { errorResult, reportCompletion, sendProgress } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildOrchestrationConfig, type ToolProfile } from '../lib/orchestration.js';
import { createResourceLink, extractTextContent } from '../lib/response.js';
import {
  executeToolStream,
  extractUsage,
  type FunctionCallEntry,
  type StreamResult,
  type ToolEvent,
} from '../lib/streaming.js';
import { MUTABLE_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { validateUrls } from '../lib/validation.js';
import { workspaceCacheManager } from '../lib/workspace-context.js';
import { type AskInput, AskInputSchema } from '../schemas/inputs.js';
import {
  type GeminiResponseSchema,
  isGeminiResponseSchemaKeyword,
} from '../schemas/json-schema.js';
import { AskOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig, EXPOSE_THOUGHTS } from '../client.js';
import { getAI, MODEL } from '../client.js';
import { getWorkspaceCacheEnabled } from '../config.js';
import {
  appendSessionEvent,
  appendSessionTranscript,
  getSession,
  getSessionEntry,
  isEvicted,
  setSession,
} from '../sessions.js';

type AskArgs = AskInput;

export interface AskStructuredContent extends Record<string, unknown> {
  answer: string;
  data?: unknown;
  schemaWarnings?: string[];
  thoughts?: string;
  toolEvents?: ToolEvent[];
  usage?: ReturnType<typeof extractUsage>;
  functionCalls?: FunctionCallEntry[];
}

interface AskDependencies {
  appendSessionEvent: typeof appendSessionEvent;
  appendSessionTranscript: typeof appendSessionTranscript;
  createChat: (args: AskArgs) => Chat;
  getSession: typeof getSession;
  getSessionEntry: typeof getSessionEntry;
  isEvicted: typeof isEvicted;
  now: () => number;
  runWithoutSession: (
    args: AskArgs,
    ctx: ServerContext,
    chat?: Chat,
  ) => Promise<AskExecutionResult>;
  setSession: typeof setSession;
}

interface AskExecutionResult {
  result: CallToolResult;
  streamResult: StreamResult;
  toolProfile: ToolProfile;
  urls?: string[];
}

const ASK_TOOL_LABEL = 'Ask Gemini';
const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;
const THINKING_SUPPRESSED_WARNING =
  'thinkingLevel was ignored because responseSchema activates JSON mode (mutually exclusive)';
const SCHEMA_COMPOSITION_KEYS = ['anyOf', 'oneOf', 'allOf', 'items', 'prefixItems'] as const;

// ── Structured Output Validation ──────────────────────────────────────

function visitNestedSchemas(
  schema: GeminiResponseSchema,
  visitor: (nestedSchema: GeminiResponseSchema) => void,
): void {
  const nested = schema.properties;
  if (nested && typeof nested === 'object') {
    for (const value of Object.values(nested as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        visitor(value as GeminiResponseSchema);
      }
    }
  }

  for (const compositionKey of SCHEMA_COMPOSITION_KEYS) {
    const value = schema[compositionKey];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          visitor(item as GeminiResponseSchema);
        }
      }
      continue;
    }

    if (value && typeof value === 'object') {
      visitor(value as GeminiResponseSchema);
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    visitor(schema.additionalProperties as GeminiResponseSchema);
  }
}

function collectUnsupportedKeywords(
  schema: GeminiResponseSchema,
  found = new Set<string>(),
): string[] {
  for (const key of Object.keys(schema)) {
    if (!isGeminiResponseSchemaKeyword(key)) {
      found.add(key);
    }
  }

  visitNestedSchemas(schema, (nestedSchema) => {
    collectUnsupportedKeywords(nestedSchema, found);
  });

  return [...found];
}

function validateJsonAgainstSchema(data: unknown, schema: GeminiResponseSchema): string[] {
  try {
    const validator = new Validator(schema, '2020-12', false);
    const result = validator.validate(data);
    if (result.valid) return [];
    return result.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
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
): AskStructuredContent {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : JSON.stringify(parsedData, null, 2);
  const usage = extractUsage(streamResult.usageMetadata);
  const warnings = buildAskWarnings(parsedData, jsonMode, responseSchema);

  return {
    answer,
    ...(parsedData !== undefined ? { data: parsedData } : {}),
    ...(warnings.length > 0 ? { schemaWarnings: warnings } : {}),
    ...(EXPOSE_THOUGHTS && streamResult.thoughtText ? { thoughts: streamResult.thoughtText } : {}),
    ...(streamResult.toolEvents.length > 0 ? { toolEvents: streamResult.toolEvents } : {}),
    ...(usage ? { usage } : {}),
    ...(streamResult.functionCalls.length > 0 ? { functionCalls: streamResult.functionCalls } : {}),
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
  thinkingSuppressed?: boolean,
): CallToolResult {
  if (result.isError) return result;
  const structured = buildAskStructuredContent(
    extractTextContent(result.content),
    streamResult,
    jsonMode,
    responseSchema,
  );

  if (thinkingSuppressed) {
    const warnings = structured.schemaWarnings ?? [];
    warnings.push(THINKING_SUPPRESSED_WARNING);
    structured.schemaWarnings = warnings;
  }

  return {
    ...result,
    content: [
      { type: 'text', text: structured.answer },
      ...result.content.filter((c) => c.type !== 'text'),
    ],
    structuredContent: structured,
  };
}

function getAskStructuredContent(result: CallToolResult): AskStructuredContent | undefined {
  if (!result.structuredContent || typeof result.structuredContent !== 'object') {
    return undefined;
  }

  return result.structuredContent as unknown as AskStructuredContent;
}

function validateAskConflict(condition: boolean, message: string): CallToolResult | undefined {
  return condition ? errorResult(message) : undefined;
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
  thinkingSuppressed = false,
  responseSchema?: GeminiResponseSchema,
): Promise<AskExecutionResult> {
  await sendProgress(ctx, 0, undefined, `${ASK_TOOL_LABEL}: Preparing`);
  if (thinkingSuppressed) {
    await ctx.mcpReq.log('debug', `ask: ${THINKING_SUPPRESSED_WARNING}`);
  }
  if (responseSchema) {
    const unsupported = collectUnsupportedKeywords(responseSchema);
    if (unsupported.length > 0) {
      await ctx.mcpReq.log(
        'warning',
        `ask: responseSchema contains keywords unsupported by Gemini: ${unsupported.join(', ')}`,
      );
    }
  }
  const { streamResult, result } = await executeToolStream(
    ctx,
    'ask',
    ASK_TOOL_LABEL,
    streamGenerator,
  );
  const hasThoughts = streamResult.thoughtText.length > 0;
  const detail = hasThoughts ? 'completed with reasoning' : 'completed';
  await reportCompletion(ctx, ASK_TOOL_LABEL, detail);
  return {
    result: formatStructuredResult(
      result,
      streamResult,
      jsonMode,
      responseSchema,
      thinkingSuppressed,
    ),
    streamResult,
    toolProfile,
    ...(urls && urls.length > 0 ? { urls } : {}),
  };
}

function appendSessionResource(result: CallToolResult, sessionId: string): void {
  if (result.isError) return;
  result.content.push(createResourceLink(`sessions://${sessionId}`, `Chat Session ${sessionId}`));
  result.content.push(
    createResourceLink(`sessions://${sessionId}/events`, `Chat Session ${sessionId} Events`),
  );
}

async function askWithoutSession(
  args: AskArgs,
  ctx: ServerContext,
  chat?: Chat,
): Promise<AskExecutionResult> {
  const { prompt, toolConfig, toolProfile, tools, urls, functionCallingMode } =
    resolveAskTooling(args);
  const thinkingSuppressed = !!args.thinkingLevel && !!args.responseSchema;
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
    thinkingSuppressed,
    args.responseSchema,
  );
}

function appendTranscriptPair(
  sessionId: string,
  message: string,
  result: CallToolResult,
  deps: Pick<AskDependencies, 'appendSessionTranscript' | 'now'>,
  taskId?: string,
): void {
  if (result.isError) return;

  deps.appendSessionTranscript(sessionId, {
    role: 'user',
    text: message,
    timestamp: deps.now(),
    ...(taskId ? { taskId } : {}),
  });
  deps.appendSessionTranscript(sessionId, {
    role: 'assistant',
    text: extractTextContent(result.content),
    timestamp: deps.now(),
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
      ...(structured?.data !== undefined ? { data: structured.data } : {}),
      ...(structured?.functionCalls ? { functionCalls: structured.functionCalls } : {}),
      ...(structured?.schemaWarnings ? { schemaWarnings: structured.schemaWarnings } : {}),
      ...(structured?.thoughts ? { thoughts: structured.thoughts } : {}),
      ...(structured?.toolEvents ? { toolEvents: structured.toolEvents } : {}),
      ...(structured?.usage ? { usage: structured.usage } : {}),
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
  )
    return undefined;
  try {
    return await workspaceCacheManager.getOrCreateCache([process.cwd()], signal);
  } catch (err) {
    logger.warn('workspace', `Failed to resolve workspace cache: ${String(err)}`);
    return undefined;
  }
}

function createDefaultAskDependencies(): AskDependencies {
  return {
    appendSessionEvent,
    appendSessionTranscript,
    createChat: (args) => {
      const { functionCallingMode, toolConfig, tools } = resolveAskTooling(args);
      return getAI().chats.create({
        model: MODEL,
        config: buildGenerateContentConfig({ ...args, functionCallingMode, toolConfig, tools }),
      });
    },
    getSession,
    getSessionEntry,
    isEvicted,
    now: () => Date.now(),
    runWithoutSession: askWithoutSession,
    setSession,
  };
}

async function askExistingSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
): Promise<CallToolResult | undefined> {
  const chat = deps.getSession(args.sessionId);
  if (!chat) return undefined;

  await ctx.mcpReq.log('debug', `Resuming session ${args.sessionId}`);
  await sendProgress(ctx, 0, undefined, `${ASK_TOOL_LABEL}: Resuming session`);
  const askResult = await deps.runWithoutSession(args, ctx, chat);
  appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
  return askResult.result;
}

async function askNewSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
  deps: AskDependencies,
): Promise<CallToolResult> {
  await ctx.mcpReq.log('debug', `Creating session ${args.sessionId}`);
  const chat = deps.createChat(args);

  const askResult = await deps.runWithoutSession(args, ctx, chat);

  if (!askResult.result.isError) {
    deps.setSession(args.sessionId, chat);
    appendSessionTurn(args.sessionId, askResult, args, deps, ctx.task?.id);
    appendSessionResource(askResult.result, args.sessionId);
  } else {
    await ctx.mcpReq.log('debug', `Session ${args.sessionId} not stored due to stream error`);
  }

  return askResult.result;
}

export function createAskWork(deps: AskDependencies = createDefaultAskDependencies()) {
  return async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
    const validationError = validateAskRequest(args, deps);
    if (validationError) return validationError;

    const workspaceCacheName = args.sessionId
      ? undefined
      : await resolveWorkspaceCacheName(args, ctx.mcpReq.signal);
    const effectiveArgs = workspaceCacheName ? { ...args, cacheName: workspaceCacheName } : args;

    if (!effectiveArgs.sessionId) {
      return (await deps.runWithoutSession(effectiveArgs, ctx)).result;
    }

    const resumed = await askExistingSession(
      effectiveArgs as AskArgs & { sessionId: string },
      ctx,
      deps,
    );
    if (resumed) return resumed;

    return await askNewSession(effectiveArgs as AskArgs & { sessionId: string }, ctx, deps);
  };
}

const askWork = createAskWork();

export function registerAskTool(server: McpServer): void {
  registerTaskTool(
    server,
    'ask',
    {
      title: 'Ask Gemini',
      description: 'Send a message to Gemini. Supports multi-turn chat via sessionId.',
      inputSchema: AskInputSchema,
      outputSchema: AskOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    askWork,
  );
}
