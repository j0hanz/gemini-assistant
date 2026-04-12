import type { McpServer } from '@modelcontextprotocol/server';

import { errorResult } from '../lib/errors.js';
import { SearchInputSchema } from '../schemas/inputs.js';

import { ai, MODEL } from '../client.js';

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    'search',
    {
      title: 'Web Search',
      description:
        'Answer questions using Gemini with Google Search grounding for up-to-date information.',
      inputSchema: SearchInputSchema,
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, systemInstruction }) => {
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: query,
          config: {
            tools: [{ googleSearch: {} }],
            ...(systemInstruction ? { systemInstruction } : {}),
          },
        });

        const answer = response.text ?? '';
        const metadata = response.candidates?.[0]?.groundingMetadata;

        const sources: string[] = [];
        if (metadata?.groundingChunks) {
          for (const chunk of metadata.groundingChunks) {
            if (chunk.web?.uri) {
              sources.push(chunk.web.uri);
            }
          }
        }

        const parts: { type: 'text'; text: string }[] = [{ type: 'text', text: answer }];

        if (sources.length > 0) {
          parts.push({
            type: 'text',
            text: `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}`,
          });
        }

        return { content: parts };
      } catch (err) {
        return errorResult(`search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
