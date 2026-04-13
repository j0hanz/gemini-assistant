import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { ThinkingLevel } from '@google/genai';

import { reportCompletion, reportFailure } from '../lib/context.js';
import { logAndReturnError } from '../lib/errors.js';
import { extractTextContent } from '../lib/response.js';
import { executeToolStream } from '../lib/streaming.js';
import { createToolTaskHandlers } from '../lib/task-utils.js';
import { SearchInputSchema } from '../schemas/inputs.js';
import { SearchOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const SEARCH_SYSTEM_INSTRUCTION =
  'Synthesize information from search results into a direct answer. ' +
  'Base answers strictly on the provided search grounding. ' +
  'Do not speculate beyond what sources confirm. Be concise and factual.';

function collectGroundedSources(
  groundingMetadata: Awaited<
    ReturnType<typeof executeToolStream>
  >['streamResult']['groundingMetadata'],
): string[] {
  const sources: string[] = [];
  if (!groundingMetadata?.groundingChunks) return sources;

  for (const chunk of groundingMetadata.groundingChunks) {
    const title = chunk.web?.title;
    const uri = chunk.web?.uri;
    if (uri) {
      sources.push(title ? `${title}: ${uri}` : uri);
    }
  }

  return sources;
}

async function searchWork(
  { query, systemInstruction }: { query: string; systemInstruction?: string | undefined },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Web Search';
  try {
    const { streamResult, result } = await executeToolStream(ctx, 'search', TOOL_LABEL, () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: query,
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction: systemInstruction ?? SEARCH_SYSTEM_INSTRUCTION,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: ThinkingLevel.LOW,
          },
          maxOutputTokens: 4096,
          abortSignal: ctx.mcpReq.signal,
        },
      }),
    );

    if (result.isError) return result;

    const sources = collectGroundedSources(streamResult.groundingMetadata);

    const answerText = extractTextContent(result.content) || '';

    if (sources.length > 0) {
      result.content.push({
        type: 'text',
        text: `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}`,
      });
    }

    await reportCompletion(
      ctx,
      TOOL_LABEL,
      `${sources.length} source${sources.length === 1 ? '' : 's'} found`,
    );

    return {
      ...result,
      structuredContent: { answer: answerText, sources },
    };
  } catch (err) {
    await reportFailure(ctx, TOOL_LABEL, err);
    return await logAndReturnError(ctx, 'search', err);
  }
}

export function registerSearchTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
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
      execution: { taskSupport: 'optional' },
    },
    createToolTaskHandlers(searchWork),
  );
}
