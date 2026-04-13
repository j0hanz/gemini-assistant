import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { extractToolContext, reportCompletion, reportFailure } from '../lib/context.js';
import { logAndReturnError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import { consumeStreamWithProgress, validateStreamResult } from '../lib/streaming.js';
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
      const TOOL_LABEL = 'Web Search';
      try {
        const stream = await withRetry(
          () =>
            ai.models.generateContentStream({
              model: MODEL,
              contents: query,
              config: {
                tools: [{ googleSearch: {} }],
                ...(systemInstruction ? { systemInstruction } : {}),
                thinkingConfig: { includeThoughts: true },
                abortSignal: tc.signal,
              },
            }),
          { signal: tc.signal },
        );

        const streamResult = await consumeStreamWithProgress(
          stream,
          tc.reportProgress,
          tc.signal,
          TOOL_LABEL,
        );
        const result = validateStreamResult(streamResult, 'search');
        if (result.isError) return result;

        const metadata = streamResult.groundingMetadata;

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

        const answerText =
          result.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('') || '';

        if (sources.length > 0) {
          result.content.push({
            type: 'text',
            text: `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}`,
          });
        }

        await reportCompletion(
          tc.reportProgress,
          TOOL_LABEL,
          `${sources.length} source${sources.length === 1 ? '' : 's'} found`,
        );

        return {
          ...result,
          structuredContent: { answer: answerText, sources },
        };
      } catch (err) {
        await reportFailure(tc.reportProgress, TOOL_LABEL, err);
        return await logAndReturnError(tc.log, 'search', err);
      }
    },
  );
}
