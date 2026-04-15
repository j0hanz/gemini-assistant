import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { Validator } from '@cfworker/json-schema';
import type { Chat } from '@google/genai';
import { z } from 'zod/v4';

import { errorResult, reportCompletion, sendProgress } from '../lib/errors.js';
import { createResourceLink, extractTextContent } from '../lib/response.js';
import {
  executeToolStream,
  extractUsage,
  type FunctionCallEntry,
  type StreamResult,
} from '../lib/streaming.js';
import { MUTABLE_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { AskOutputSchema } from '../schemas/outputs.js';

import {
  AskThinkingLevel,
  buildGenerateContentConfig,
  EXPOSE_THOUGHTS,
  THINKING_LEVELS,
} from '../client.js';
import { completeCacheNames, getAI, MODEL } from '../client.js';
import {
  completeSessionIds,
  getSession,
  getSessionEntry,
  isEvicted,
  setSession,
} from '../sessions.js';

interface AskArgs {
  message: string;
  sessionId?: string | undefined;
  systemInstruction?: string | undefined;
  thinkingLevel?: AskThinkingLevel | undefined;
  cacheName?: string | undefined;
  responseSchema?: Record<string, unknown> | undefined;
  temperature?: number | undefined;
  seed?: number | undefined;
  googleSearch?: boolean | undefined;
}

const ASK_TOOL_LABEL = 'Ask Gemini';
const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;
const THINKING_SUPPRESSED_WARNING =
  'thinkingLevel was ignored because responseSchema activates JSON mode (mutually exclusive)';
const SCHEMA_COMPOSITION_KEYS = ['anyOf', 'oneOf', 'allOf', 'items', 'prefixItems'] as const;

// ── Structured Output Validation ──────────────────────────────────────

const GEMINI_SUPPORTED_KEYWORDS = new Set([
  // structural
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'format',
  'minimum',
  'maximum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  // descriptive
  'title',
  'description',
  // composition
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  // meta
  '$schema',
  '$id',
]);

function visitNestedSchemas(
  schema: Record<string, unknown>,
  visitor: (nestedSchema: Record<string, unknown>) => void,
): void {
  const nested = schema.properties;
  if (nested && typeof nested === 'object') {
    for (const value of Object.values(nested as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        visitor(value as Record<string, unknown>);
      }
    }
  }

  for (const compositionKey of SCHEMA_COMPOSITION_KEYS) {
    const value = schema[compositionKey];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          visitor(item as Record<string, unknown>);
        }
      }
      continue;
    }

    if (value && typeof value === 'object') {
      visitor(value as Record<string, unknown>);
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    visitor(schema.additionalProperties as Record<string, unknown>);
  }
}

function collectUnsupportedKeywords(
  schema: Record<string, unknown>,
  found = new Set<string>(),
): string[] {
  for (const key of Object.keys(schema)) {
    if (!GEMINI_SUPPORTED_KEYWORDS.has(key)) {
      found.add(key);
    }
  }

  visitNestedSchemas(schema, (nestedSchema) => {
    collectUnsupportedKeywords(nestedSchema, found);
  });

  return [...found];
}

function validateJsonAgainstSchema(data: unknown, schema: Record<string, unknown>): string[] {
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
  responseSchema: Record<string, unknown> | undefined,
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

function buildAskStructuredContent(
  text: string,
  streamResult: Pick<StreamResult, 'thoughtText' | 'usageMetadata' | 'functionCalls'>,
  jsonMode?: boolean,
  responseSchema?: Record<string, unknown>,
): {
  answer: string;
  data?: unknown;
  schemaWarnings?: string[];
  thoughts?: string;
  usage?: ReturnType<typeof extractUsage>;
  functionCalls?: FunctionCallEntry[];
} {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : JSON.stringify(parsedData, null, 2);
  const usage = extractUsage(streamResult.usageMetadata);
  const warnings = buildAskWarnings(parsedData, jsonMode, responseSchema);

  return {
    answer,
    ...(parsedData !== undefined ? { data: parsedData } : {}),
    ...(warnings.length > 0 ? { schemaWarnings: warnings } : {}),
    ...(EXPOSE_THOUGHTS && streamResult.thoughtText ? { thoughts: streamResult.thoughtText } : {}),
    ...(usage ? { usage } : {}),
    ...(streamResult.functionCalls.length > 0 ? { functionCalls: streamResult.functionCalls } : {}),
  };
}

function formatStructuredResult(
  result: CallToolResult,
  streamResult: Pick<StreamResult, 'thoughtText' | 'usageMetadata' | 'functionCalls'>,
  jsonMode?: boolean,
  responseSchema?: Record<string, unknown>,
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

function validateAskConflict(condition: boolean, message: string): CallToolResult | undefined {
  return condition ? errorResult(message) : undefined;
}

function validateAskRequest({
  sessionId,
  systemInstruction,
  cacheName,
  responseSchema,
  temperature,
  seed,
}: AskArgs): CallToolResult | undefined {
  const hasExistingSession = sessionId ? getSessionEntry(sessionId) !== undefined : false;
  return (
    validateAskConflict(
      !!sessionId && isEvicted(sessionId),
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

async function runAskStream(
  ctx: ServerContext,
  streamGenerator: () => ReturnType<ReturnType<typeof getAI>['models']['generateContentStream']>,
  jsonMode = false,
  thinkingSuppressed = false,
  responseSchema?: Record<string, unknown>,
): Promise<CallToolResult> {
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
  return formatStructuredResult(result, streamResult, jsonMode, responseSchema, thinkingSuppressed);
}

function appendSessionResource(result: CallToolResult, sessionId: string): void {
  if (result.isError) return;
  result.content.push(createResourceLink(`sessions://${sessionId}`, `Chat Session ${sessionId}`));
}

async function askWithoutSession(
  args: AskArgs,
  ctx: ServerContext,
  chat?: Chat,
): Promise<CallToolResult> {
  const tools = args.googleSearch ? [{ googleSearch: {} }] : undefined;
  const thinkingSuppressed = !!args.thinkingLevel && !!args.responseSchema;
  return await runAskStream(
    ctx,
    () =>
      chat
        ? chat.sendMessageStream({
            message: args.message,
            config: buildGenerateContentConfig({ ...args, tools }, ctx.mcpReq.signal),
          })
        : getAI().models.generateContentStream({
            model: MODEL,
            contents: args.message,
            config: buildGenerateContentConfig({ ...args, tools }, ctx.mcpReq.signal),
          }),
    !!args.responseSchema,
    thinkingSuppressed,
    args.responseSchema,
  );
}

async function askExistingSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
): Promise<CallToolResult | undefined> {
  const chat = getSession(args.sessionId, ctx.task?.id);
  if (!chat) return undefined;

  await ctx.mcpReq.log('debug', `Resuming session ${args.sessionId}`);
  await sendProgress(ctx, 0, undefined, `${ASK_TOOL_LABEL}: Resuming session`);
  return await askWithoutSession(args, ctx, chat);
}

async function askNewSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
): Promise<CallToolResult> {
  await ctx.mcpReq.log('debug', `Creating session ${args.sessionId}`);
  const tools = args.googleSearch ? [{ googleSearch: {} }] : undefined;
  const chat = getAI().chats.create({
    model: MODEL,
    config: buildGenerateContentConfig({ ...args, tools }),
  });

  const result = await askWithoutSession(args, ctx, chat);

  if (!result.isError) {
    setSession(args.sessionId, chat, ctx.task?.id);
    appendSessionResource(result, args.sessionId);
  } else {
    await ctx.mcpReq.log('debug', `Session ${args.sessionId} not stored due to stream error`);
  }

  return result;
}

async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
  const validationError = validateAskRequest(args);
  if (validationError) return validationError;

  if (!args.sessionId) {
    return await askWithoutSession(args, ctx);
  }

  const resumed = await askExistingSession(args as AskArgs & { sessionId: string }, ctx);
  if (resumed) return resumed;

  return await askNewSession(args as AskArgs & { sessionId: string }, ctx);
}

const AskInputSchema = z.object({
  message: z.string().min(1).max(100_000).describe('User message or prompt'),
  sessionId: completable(
    z
      .string()
      .max(256)
      .optional()
      .describe('Session ID for multi-turn chat. Omit for single-turn.'),
    completeSessionIds,
  ),
  systemInstruction: z
    .string()
    .optional()
    .describe('System prompt (used on session creation or single-turn)'),
  thinkingLevel: z
    .enum(THINKING_LEVELS)
    .optional()
    .describe('Thinking depth. MINIMAL=fastest, LOW, MEDIUM, HIGH=deepest.'),
  cacheName: completable(
    z
      .string()
      .optional()
      .describe('Cache name from create_cache. Cannot be applied to an existing chat session.'),
    completeCacheNames,
  ),
  responseSchema: z
    .record(z.string(), z.unknown())
    .refine(
      (s) =>
        'type' in s ||
        'properties' in s ||
        'anyOf' in s ||
        'oneOf' in s ||
        'allOf' in s ||
        '$ref' in s ||
        'enum' in s ||
        'items' in s,
      {
        message:
          'responseSchema must contain at least one JSON Schema keyword (type, properties, anyOf, oneOf, allOf, $ref, enum, or items)',
      },
    )
    .optional()
    .describe(
      'JSON Schema object (draft-compatible) for structured output. Gemini returns conforming JSON. Disables thinking. Gemini 2.0 models may require a propertyOrdering array.',
    ),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe(
      'Controls randomness (0.0=deterministic, 2.0=most creative). Model default if omitted.',
    ),
  seed: z
    .number()
    .int()
    .optional()
    .describe('Fixed seed for reproducible outputs. Model default if omitted.'),
  googleSearch: z
    .boolean()
    .optional()
    .describe('Enable Google Search grounding. Model can use web results for up-to-date answers.'),
});

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
