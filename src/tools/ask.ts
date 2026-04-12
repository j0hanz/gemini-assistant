import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { extractToolContext } from '../lib/context.js';
import { errorResult, geminiErrorResult } from '../lib/errors.js';
import { extractTextOrError } from '../lib/response.js';
import { AskInputSchema } from '../schemas/inputs.js';

import { ai, MODEL } from '../client.js';
import { getSession, isEvicted, setSession } from '../sessions.js';

export function registerAskTool(server: McpServer): void {
  server.registerTool(
    'ask',
    {
      title: 'Ask Gemini',
      description: 'Send a message to Gemini. Supports multi-turn chat via sessionId.',
      inputSchema: AskInputSchema,
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
          return errorResult(`Session '${sessionId}' has expired.`);
        }

        // Mid-session conflict guard
        if (sessionId && cacheName) {
          const existing = getSession(sessionId);
          if (existing) {
            return errorResult(
              'Cannot apply a cachedContent to an existing chat session. Please omit cacheName, or start a new chat with a different sessionId.',
            );
          }
        }

        const cacheConfig = cacheName ? { cachedContent: cacheName } : undefined;

        // Single-turn: no sessionId
        if (!sessionId) {
          const response = await ai.models.generateContent({
            model: MODEL,
            contents: message,
            config: {
              ...cacheConfig,
              ...(systemInstruction ? { systemInstruction } : {}),
              abortSignal: tc.signal,
            },
          });
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

        return extractTextOrError(response, 'ask');
      } catch (err) {
        return geminiErrorResult('ask', err);
      }
    },
  );
}
