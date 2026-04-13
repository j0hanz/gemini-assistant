import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { extractToolContext, reportCompletion, reportFailure } from '../lib/context.js';
import { errorResult, logAndReturnError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import { consumeStreamWithProgress, validateStreamResult } from '../lib/streaming.js';

import { ai, MODEL } from '../client.js';
import { getSession, isEvicted, listSessionEntries, setSession } from '../sessions.js';

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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ message, sessionId, systemInstruction, cacheName }, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      const TOOL_LABEL = 'Ask Gemini';

      const streamAndValidate = async (
        stream: AsyncGenerator<import('@google/genai').GenerateContentResponse>,
      ) => {
        const streamResult = await consumeStreamWithProgress(
          stream,
          tc.reportProgress,
          tc.signal,
          TOOL_LABEL,
        );
        return validateStreamResult(streamResult, 'ask');
      };

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
          const stream = await withRetry(
            () =>
              ai.models.generateContentStream({
                model: MODEL,
                contents: message,
                config: {
                  ...cacheConfig,
                  ...(systemInstruction ? { systemInstruction } : {}),
                  thinkingConfig: { includeThoughts: true },
                  abortSignal: tc.signal,
                },
              }),
            { signal: tc.signal },
          );
          const result = await streamAndValidate(stream);
          await reportCompletion(
            tc.reportProgress,
            TOOL_LABEL,
            `responded (${
              result.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('').length
            } chars)`,
          );
          return result;
        }

        // Multi-turn: existing session
        let chat = getSession(sessionId);
        if (chat) {
          await tc.log('debug', `Resuming session ${sessionId}`);
          const stream = await chat.sendMessageStream({
            message,
            config: { abortSignal: tc.signal },
          });
          const result = await streamAndValidate(stream);
          await reportCompletion(
            tc.reportProgress,
            TOOL_LABEL,
            `responded (${
              result.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('').length
            } chars)`,
          );
          return result;
        }

        // Multi-turn: new session
        await tc.log('debug', `Creating session ${sessionId}`);
        chat = ai.chats.create({
          model: MODEL,
          config: {
            ...cacheConfig,
            ...(systemInstruction ? { systemInstruction } : {}),
            thinkingConfig: { includeThoughts: true },
          },
        });
        const stream = await chat.sendMessageStream({
          message,
          config: { abortSignal: tc.signal },
        });

        const result = await streamAndValidate(stream);
        if (!result.isError) {
          setSession(sessionId, chat);
          result.content.push({
            type: 'resource_link' as const,
            uri: `sessions://${sessionId}`,
            name: `Chat Session ${sessionId}`,
            mimeType: 'application/json',
          });
        } else {
          await tc.log('debug', `Session ${sessionId} not stored due to stream error`);
        }
        const text = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');
        await reportCompletion(tc.reportProgress, TOOL_LABEL, `responded (${text.length} chars)`);
        return result;
      } catch (err) {
        await reportFailure(tc.reportProgress, TOOL_LABEL, err);
        return await logAndReturnError(tc.log, 'ask', err);
      }
    },
  );
}
