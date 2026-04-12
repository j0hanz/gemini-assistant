import type { McpServer } from '@modelcontextprotocol/server';
import { ai, MODEL } from '../client.js';
import { getSession, setSession, isEvicted } from '../sessions.js';
import { AskInputSchema } from '../schemas/inputs.js';
import { errorResult } from '../lib/errors.js';

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
    async ({ message, sessionId, systemInstruction }) => {
      try {
        if (sessionId && isEvicted(sessionId)) {
          return errorResult(`Session '${sessionId}' has expired.`);
        }

        // Single-turn: no sessionId
        if (!sessionId) {
          const response = await ai.models.generateContent({
            model: MODEL,
            contents: message,
            config: systemInstruction ? { systemInstruction } : undefined,
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
          config: systemInstruction ? { systemInstruction } : undefined,
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
