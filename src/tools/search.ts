import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { extractToolContext } from '../lib/context.js';
import { geminiErrorResult } from '../lib/errors.js';
import { extractTextOrError } from '../lib/response.js';
import { withRetry } from '../lib/retry.js';
import { SearchInputSchema } from '../schemas/inputs.js';
import { SearchOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    'search',
    {
      title: 'Web Search',
      description:
        'Answer questions using Gemini with Google Search grounding for up-to-date information.',
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, systemInstruction }, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      try {
        const response = await withRetry(
          () =>
            ai.models.generateContent({
              model: MODEL,
              contents: query,
              config: {
                tools: [{ googleSearch: {} }],
                ...(systemInstruction ? { systemInstruction } : {}),
                abortSignal: tc.signal,
              },
            }),
          { signal: tc.signal },
        );

        const result = extractTextOrError(response, 'search');
        if (result.isError) return result;

        const metadata = response.candidates?.[0]?.groundingMetadata;

        const sources: string[] = [];
        if (metadata?.groundingChunks) {
          for (const chunk of metadata.groundingChunks) {
            const title = chunk.web?.title;
            const uri = chunk.web?.uri;
            if (uri) {
              sources.push(title ? `${title}: ${uri}` : uri);
            }
          }
        }

        if (sources.length > 0) {
          result.content.push({
            type: 'text',
            text: `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}`,
          });
        }

        const answerText =
          result.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('') || '';

        return {
          ...result,
          structuredContent: { answer: answerText, sources },
        };
      } catch (err) {
        await tc.log('error', `search failed: ${err instanceof Error ? err.message : String(err)}`);
        return geminiErrorResult('search', err);
      }
    },
  );
}
