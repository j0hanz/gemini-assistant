import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import type { ThinkingLevel } from '@google/genai';
import { z } from 'zod/v4';

import { reportCompletion, reportFailure } from '../lib/context.js';
import { errorResult, logAndReturnError } from '../lib/errors.js';
import { extractTextContent } from '../lib/response.js';
import { executeToolStream } from '../lib/streaming.js';
import { AskOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';
import { getSession, isEvicted, listSessionEntries, setSession } from '../sessions.js';

const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;

const DEFAULT_SYSTEM_INSTRUCTION =
  'You are a helpful AI assistant. Provide direct, accurate answers. ' +
  'Use Markdown formatting for structure. Be concise.';

function formatStructuredResult(result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  const text = extractTextContent(result.content);
  const structured = { answer: text };
  return {
    ...result,
    content: [
      { type: 'text', text: JSON.stringify(structured) },
      ...result.content.filter((c) => c.type !== 'text'),
    ],
    structuredContent: structured,
  };
}

export function registerAskTool(server: McpServer): void {
  server.registerTool(
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
          .describe(
            'Thinking depth (applies at session creation or single-turn). MINIMAL (fastest), LOW, MEDIUM, HIGH (deepest).',
          ),
        cacheName: completable(
          z
            .string()
            .optional()
            .describe(
              'Cache name from create_cache. Cannot be applied to an existing chat session.',
            ),
          async (value) => {
            const names: string[] = [];
            try {
              const pager = await ai.caches.list();
              for await (const cached of pager) {
                if (cached.name?.startsWith(value ?? '')) names.push(cached.name);
              }
            } catch {
              // Cache listing may fail — return empty completions
            }
            return names;
          },
        ),
      }),
      outputSchema: AskOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (
      { message, sessionId, systemInstruction, thinkingLevel, cacheName },
      ctx: ServerContext,
    ) => {
      const TOOL_LABEL = 'Ask Gemini';

      try {
        if (sessionId && isEvicted(sessionId)) {
          return errorResult(`ask: Session '${sessionId}' has expired.`);
        }

        // Mid-session conflict guard
        if (sessionId && cacheName) {
          const existing = getSession(sessionId);
          if (existing) {
            return errorResult(
              'ask: Cannot apply a cachedContent to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
            );
          }
        }

        const cacheConfig = cacheName ? { cachedContent: cacheName } : undefined;

        // Single-turn: no sessionId
        if (!sessionId) {
          const { result } = await executeToolStream(ctx, 'ask', TOOL_LABEL, () =>
            ai.models.generateContentStream({
              model: MODEL,
              contents: message,
              config: {
                ...cacheConfig,
                systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION,
                thinkingConfig: {
                  includeThoughts: true,
                  ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
                },
                maxOutputTokens: 8192,
                abortSignal: ctx.mcpReq.signal,
              },
            }),
          );

          await reportCompletion(
            ctx,
            TOOL_LABEL,
            `responded (${extractTextContent(result.content).length} chars)`,
          );
          return formatStructuredResult(result);
        }

        // Multi-turn: existing session
        let chat = getSession(sessionId);
        if (chat) {
          await ctx.mcpReq.log('debug', `Resuming session ${sessionId}`);

          const currentChat = chat;
          const { result } = await executeToolStream(ctx, 'ask', TOOL_LABEL, () =>
            currentChat.sendMessageStream({
              message,
              config: { abortSignal: ctx.mcpReq.signal },
            }),
          );

          await reportCompletion(
            ctx,
            TOOL_LABEL,
            `responded (${extractTextContent(result.content).length} chars)`,
          );
          return formatStructuredResult(result);
        }

        // Multi-turn: new session
        await ctx.mcpReq.log('debug', `Creating session ${sessionId}`);
        chat = ai.chats.create({
          model: MODEL,
          config: {
            ...cacheConfig,
            systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION,
            thinkingConfig: {
              includeThoughts: true,
              ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
            },
            maxOutputTokens: 8192,
          },
        });

        const { result } = await executeToolStream(ctx, 'ask', TOOL_LABEL, () =>
          chat.sendMessageStream({
            message,
            config: { abortSignal: ctx.mcpReq.signal },
          }),
        );

        if (!result.isError) {
          setSession(sessionId, chat);
          result.content.push({
            type: 'resource_link' as const,
            uri: `sessions://${sessionId}`,
            name: `Chat Session ${sessionId}`,
            mimeType: 'application/json',
          });
        } else {
          await ctx.mcpReq.log('debug', `Session ${sessionId} not stored due to stream error`);
        }

        const text = extractTextContent(result.content);
        await reportCompletion(ctx, TOOL_LABEL, `responded (${text.length} chars)`);
        return formatStructuredResult(result);
      } catch (err) {
        await reportFailure(ctx, TOOL_LABEL, err);
        return await logAndReturnError(ctx, 'ask', err);
      }
    },
  );
}
