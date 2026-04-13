import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { ThinkingLevel } from '@google/genai';

import { reportCompletion } from '../lib/context.js';
import { handleToolError } from '../lib/errors.js';
import { appendUrlStatus, collectUrlMetadata, extractTextContent } from '../lib/response.js';
import { executeToolStream, extractUsage } from '../lib/streaming.js';
import { createToolTaskHandlers, READONLY_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { SearchInputSchema } from '../schemas/inputs.js';
import { SearchOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const SEARCH_SYSTEM_INSTRUCTION =
  'Synthesize search results into a direct, factual answer. ' +
  'Base answers strictly on the provided search grounding. Be concise.';

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
  {
    query,
    systemInstruction,
    urls,
  }: {
    query: string;
    systemInstruction?: string | undefined;
    urls?: string[] | undefined;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Web Search';
  try {
    const hasUrls = urls && urls.length > 0;
    const contents = hasUrls ? `${query}\n\nAlso analyze content from:\n${urls.join('\n')}` : query;

    const tools: Record<string, Record<string, never>>[] = [
      { googleSearch: {} },
      ...(hasUrls ? [{ urlContext: {} }] : []),
    ];

    const { streamResult, result } = await executeToolStream(ctx, 'search', TOOL_LABEL, () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          tools,
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
    const urlMeta = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);

    const answerText = extractTextContent(result.content) || '';

    if (sources.length > 0) {
      result.content.push({
        type: 'text',
        text: `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}`,
      });
    }

    appendUrlStatus(result.content, urlMeta);

    await reportCompletion(
      ctx,
      TOOL_LABEL,
      `${sources.length} source${sources.length === 1 ? '' : 's'} found`,
    );

    const usage = extractUsage(streamResult.usageMetadata);

    return {
      ...result,
      structuredContent: {
        answer: answerText,
        sources,
        ...(urlMeta.length > 0 ? { urlMetadata: urlMeta } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  } catch (err) {
    return await handleToolError(ctx, 'search', TOOL_LABEL, err);
  }
}

export function registerSearchTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'search',
    {
      title: 'Web Search',
      description:
        'Answer questions with Google Search grounding. ' +
        'Optionally include URLs for deep analysis via URL Context.',
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: READONLY_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(searchWork),
  );
}
