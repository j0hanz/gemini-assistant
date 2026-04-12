import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { extractToolContext } from '../lib/context.js';
import { errorResult, geminiErrorResult } from '../lib/errors.js';
import { extractTextOrError } from '../lib/response.js';
import { withRetry } from '../lib/retry.js';

import { ai, MODEL } from '../client.js';
import { getSession, isEvicted, listSessionEntries, setSession } from '../sessions.js';

export function registerAskTool(server: McpServer): void {
  server.registerTool(
    'ask',
    {
      title: 'Ask Gemini',
      description: 'Send a message to Gemini. Supports multi-turn chat via sessionId.',
      inputSchema: z.object({
        message: z.string().max(100_000).describe('User message or prompt'),
        sessionId: completable(
          z.string().optional().describe('Session ID for multi-turn chat. Omit for single-turn.'),
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
          const response = await withRetry(
            () =>
              ai.models.generateContent({
                model: MODEL,
                contents: message,
                config: {
                  ...cacheConfig,
                  ...(systemInstruction ? { systemInstruction } : {}),
                  abortSignal: tc.signal,
                },
              }),
            { signal: tc.signal },
          );
          return extractTextOrError(response, 'ask');
        }

        // Multi-turn: existing session
        let chat = getSession(sessionId);
        if (chat) {
          await tc.log('debug', `Resuming session ${sessionId}`);
          const response = await chat.sendMessage({
            message,
            config: { abortSignal: tc.signal },
          });
          return extractTextOrError(response, 'ask');
        }

        // Multi-turn: new session
        await tc.log('debug', `Creating session ${sessionId}`);
        chat = ai.chats.create({
          model: MODEL,
          config: {
            ...cacheConfig,
            ...(systemInstruction ? { systemInstruction } : {}),
          },
        });
        const response = await chat.sendMessage({
          message,
          config: { abortSignal: tc.signal },
        });
        setSession(sessionId, chat);

        const result = extractTextOrError(response, 'ask');
        if (!result.isError) {
          result.content.push({
            type: 'resource_link' as const,
            uri: `sessions://${sessionId}`,
            name: `Chat Session ${sessionId}`,
            mimeType: 'application/json',
          });
        }
        return result;
      } catch (err) {
        await tc.log('error', `ask failed: ${err instanceof Error ? err.message : String(err)}`);
        return geminiErrorResult('ask', err);
      }
    },
  );
}
