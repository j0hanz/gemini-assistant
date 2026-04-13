import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import type { ThinkingLevel } from '@google/genai';
import { z } from 'zod/v4';

import { reportCompletion } from '../lib/context.js';
import { errorResult, handleToolError, throwInvalidParams } from '../lib/errors.js';
import { extractTextContent } from '../lib/response.js';
import { executeToolStream, extractUsage } from '../lib/streaming.js';
import { createToolTaskHandlers, MUTABLE_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { AskOutputSchema } from '../schemas/outputs.js';

import { ai, completeCacheNames, MODEL } from '../client.js';
import {
  getSession,
  getSessionEntry,
  isEvicted,
  listSessionEntries,
  setSession,
} from '../sessions.js';

const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
type AskThinkingLevel = (typeof THINKING_LEVELS)[number];

interface AskArgs {
  message: string;
  sessionId?: string | undefined;
  systemInstruction?: string | undefined;
  thinkingLevel?: AskThinkingLevel | undefined;
  cacheName?: string | undefined;
  responseSchema?: Record<string, unknown> | undefined;
}

const ASK_TOOL_LABEL = 'Ask Gemini';

const DEFAULT_SYSTEM_INSTRUCTION =
  'Provide direct, accurate answers. Use Markdown for structure. Be concise.';

function formatStructuredResult(
  result: CallToolResult,
  usageMetadata?: ReturnType<typeof extractUsage>,
  jsonMode?: boolean,
): CallToolResult {
  if (result.isError) return result;
  const text = extractTextContent(result.content);

  let structured: Record<string, unknown>;
  if (jsonMode) {
    try {
      structured = {
        ...(JSON.parse(text) as Record<string, unknown>),
        ...(usageMetadata ? { usage: usageMetadata } : {}),
      };
    } catch {
      structured = { answer: text, ...(usageMetadata ? { usage: usageMetadata } : {}) };
    }
  } else {
    structured = { answer: text, ...(usageMetadata ? { usage: usageMetadata } : {}) };
  }

  return {
    ...result,
    content: [{ type: 'text', text }, ...result.content.filter((c) => c.type !== 'text')],
    structuredContent: structured,
  };
}

function buildThinkingConfig(thinkingLevel?: AskThinkingLevel) {
  return {
    includeThoughts: true,
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
  };
}

function buildAskConfig(
  {
    systemInstruction,
    thinkingLevel,
    cacheName,
    responseSchema,
  }: Pick<AskArgs, 'systemInstruction' | 'thinkingLevel' | 'cacheName' | 'responseSchema'>,
  signal?: AbortSignal,
) {
  return {
    ...(cacheName ? { cachedContent: cacheName } : {}),
    ...(cacheName ? {} : { systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION }),
    // Structured output (responseSchema) is incompatible with thinking — omit thinkingConfig when JSON mode is active
    ...(responseSchema
      ? { responseMimeType: 'application/json', responseSchema }
      : { thinkingConfig: buildThinkingConfig(thinkingLevel) }),
    maxOutputTokens: 8192,
    ...(signal ? { abortSignal: signal } : {}),
  };
}

function validateAskRequest({
  sessionId,
  systemInstruction,
  cacheName,
  responseSchema,
}: AskArgs): CallToolResult | undefined {
  if (sessionId && isEvicted(sessionId)) {
    return errorResult(`ask: Session '${sessionId}' has expired.`);
  }

  if (sessionId && cacheName && getSessionEntry(sessionId)) {
    throwInvalidParams(
      'ask: Cannot apply a cachedContent to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
    );
  }

  if (cacheName && systemInstruction) {
    throwInvalidParams(
      'ask: systemInstruction cannot be used with cacheName. Embed the system instruction in the cache via create_cache instead.',
    );
  }

  if (responseSchema && sessionId && getSessionEntry(sessionId)) {
    throwInvalidParams(
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
  const { streamResult, result } = await executeToolStream(
    ctx,
    'ask',
    ASK_TOOL_LABEL,
    streamGenerator,
  );
  const text = extractTextContent(result.content);
  await reportCompletion(ctx, ASK_TOOL_LABEL, `responded (${text.length} chars)`);
  return formatStructuredResult(result, extractUsage(streamResult.usageMetadata), jsonMode);
}

function appendSessionResource(result: CallToolResult, sessionId: string): void {
  if (result.isError) return;
  result.content.push({
    type: 'resource_link' as const,
    uri: `sessions://${sessionId}`,
    name: `Chat Session ${sessionId}`,
    mimeType: 'application/json',
  });
}

async function askSingleTurn(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
  return await runAskStream(
    ctx,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: args.message,
        config: buildAskConfig(args, ctx.mcpReq.signal),
      }),
    !!args.responseSchema,
  );
}

async function askExistingSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
): Promise<CallToolResult | undefined> {
  const chat = getSession(args.sessionId);
  if (!chat) return undefined;

  await ctx.mcpReq.log('debug', `Resuming session ${args.sessionId}`);
  return await runAskStream(ctx, () =>
    chat.sendMessageStream({
      message: args.message,
      config: { abortSignal: ctx.mcpReq.signal },
    }),
  );
}

async function askNewSession(
  args: AskArgs & { sessionId: string },
  ctx: ServerContext,
): Promise<CallToolResult> {
  await ctx.mcpReq.log('debug', `Creating session ${args.sessionId}`);
  const chat = ai.chats.create({
    model: MODEL,
    config: buildAskConfig(args),
  });

  const result = await runAskStream(
    ctx,
    () =>
      chat.sendMessageStream({
        message: args.message,
        config: { abortSignal: ctx.mcpReq.signal },
      }),
    !!args.responseSchema,
  );

  if (!result.isError) {
    setSession(args.sessionId, chat);
    appendSessionResource(result, args.sessionId);
  } else {
    await ctx.mcpReq.log('debug', `Session ${args.sessionId} not stored due to stream error`);
  }

  return result;
}

async function askWork(args: AskArgs, ctx: ServerContext): Promise<CallToolResult> {
  try {
    const validationError = validateAskRequest(args);
    if (validationError) return validationError;

    if (!args.sessionId) {
      return await askSingleTurn(args, ctx);
    }

    const resumed = await askExistingSession(args as AskArgs & { sessionId: string }, ctx);
    if (resumed) return resumed;

    return await askNewSession(args as AskArgs & { sessionId: string }, ctx);
  } catch (err) {
    return await handleToolError(ctx, 'ask', ASK_TOOL_LABEL, err);
  }
}

export function registerAskTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
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
          (value) =>
            listSessionEntries()
              .map((s) => s.id)
              .filter((id) => id.startsWith(value ?? '')),
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
          .optional()
          .describe(
            'JSON Schema for structured output. Gemini returns conforming JSON. Disables thinking.',
          ),
      }),
      outputSchema: AskOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(askWork),
  );
}
