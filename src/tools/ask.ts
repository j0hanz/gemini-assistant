import type { McpServer } from '@modelcontextprotocol/server';

import { errorResult } from '../lib/errors.js';
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
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ message, sessionId, systemInstruction, cacheName }) => {
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
            },
          });
          return {
            content: [{ type: 'text', text: response.text ?? '' }],
          };
        }

        // Multi-turn: existing session
        let chat = getSession(sessionId);
        if (chat) {
          const response = await chat.sendMessage({ message });
          return {
            content: [{ type: 'text', text: response.text ?? '' }],
          };
        }

        // Multi-turn: new session
        chat = ai.chats.create({
          model: MODEL,
          config: {
            ...cacheConfig,
            ...(systemInstruction ? { systemInstruction } : {}),
          },
        });
        const response = await chat.sendMessage({ message });
        setSession(sessionId, chat);

        return {
          content: [{ type: 'text', text: response.text ?? '' }],
        };
      } catch (err) {
        return errorResult(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
