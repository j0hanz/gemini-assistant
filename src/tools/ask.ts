import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import type { Chat } from '@google/genai';
import { z } from 'zod/v4';

import {
  AskThinkingLevel,
  buildGenerateContentConfig,
  THINKING_LEVELS,
} from '../lib/config-utils.js';
import { reportCompletion, sendProgress } from '../lib/context.js';
import { errorResult } from '../lib/errors.js';
import { createResourceLink, extractTextContent } from '../lib/response.js';
import { executeToolStream, extractUsage, type StreamResult } from '../lib/streaming.js';
import { MUTABLE_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { AskOutputSchema } from '../schemas/outputs.js';

import { ai, completeCacheNames, MODEL } from '../client.js';
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
}

const ASK_TOOL_LABEL = 'Ask Gemini';
const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;

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

function buildAskStructuredContent(
  text: string,
  streamResult: Pick<StreamResult, 'thoughtText' | 'usageMetadata'>,
  jsonMode?: boolean,
): {
  answer: string;
  data?: unknown;
  thoughts?: string;
  usage?: ReturnType<typeof extractUsage>;
} {
  const parsedData = jsonMode ? tryParseJsonResponse(text) : undefined;
  const answer = parsedData === undefined ? text : JSON.stringify(parsedData, null, 2);
  const usage = extractUsage(streamResult.usageMetadata);

  return {
    answer,
    ...(parsedData !== undefined ? { data: parsedData } : {}),
    ...(streamResult.thoughtText ? { thoughts: streamResult.thoughtText } : {}),
    ...(usage ? { usage } : {}),
  };
}

function formatStructuredResult(
  result: CallToolResult,
  streamResult: Pick<StreamResult, 'thoughtText' | 'usageMetadata'>,
  jsonMode?: boolean,
): CallToolResult {
  if (result.isError) return result;
  const structured = buildAskStructuredContent(
    extractTextContent(result.content),
    streamResult,
    jsonMode,
  );

  return {
    ...result,
    content: [
      { type: 'text', text: structured.answer },
      ...result.content.filter((c) => c.type !== 'text'),
    ],
    structuredContent: structured,
  };
}

function validateAskRequest({
  sessionId,
  systemInstruction,
  cacheName,
  responseSchema,
}: AskArgs): CallToolResult | undefined {
  const hasExistingSession = sessionId ? getSessionEntry(sessionId) !== undefined : false;

  if (sessionId && isEvicted(sessionId)) {
    return errorResult(`ask: Session '${sessionId}' has expired.`);
  }

  if (sessionId && cacheName && hasExistingSession) {
    return errorResult(
      'ask: Cannot apply a cachedContent to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
    );
  }

  if (cacheName && systemInstruction) {
    return errorResult(
      'ask: systemInstruction cannot be used with cacheName. Embed the system instruction in the cache via create_cache instead.',
    );
  }

  if (responseSchema && sessionId && hasExistingSession) {
    return errorResult(
      'ask: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    );
  }

  return undefined;
}

async function runAskStream(
  ctx: ServerContext,
  streamGenerator: () => ReturnType<typeof ai.models.generateContentStream>,
  jsonMode = false,
): Promise<CallToolResult> {
  await sendProgress(ctx, 0, undefined, `${ASK_TOOL_LABEL}: Preparing`);
  const { streamResult, result } = await executeToolStream(
    ctx,
    'ask',
    ASK_TOOL_LABEL,
    streamGenerator,
  );
  const hasThoughts = streamResult.thoughtText.length > 0;
  const detail = hasThoughts ? 'completed with reasoning' : 'completed';
  await reportCompletion(ctx, ASK_TOOL_LABEL, detail);
  return formatStructuredResult(result, streamResult, jsonMode);
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
  return await runAskStream(
    ctx,
    () =>
      chat
        ? chat.sendMessageStream({
            message: args.message,
            config: buildGenerateContentConfig(args, ctx.mcpReq.signal),
          })
        : ai.models.generateContentStream({
            model: MODEL,
            contents: args.message,
            config: buildGenerateContentConfig(args, ctx.mcpReq.signal),
          }),
    !!args.responseSchema,
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
  const chat = ai.chats.create({
    model: MODEL,
    config: buildGenerateContentConfig(args),
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

export function registerAskTool(server: McpServer): void {
  registerTaskTool(
    server,
    'ask',
    {
      title: 'Ask Gemini',
      description: 'Send a message to Gemini. Supports multi-turn chat via sessionId.',
      inputSchema: z.object({
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
            .describe(
              'Cache name from create_cache. Cannot be applied to an existing chat session.',
            ),
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
            'JSON Schema object (draft-compatible) for structured output. Gemini returns conforming JSON. Disables thinking.',
          ),
      }),
      outputSchema: AskOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    askWork,
  );
}
