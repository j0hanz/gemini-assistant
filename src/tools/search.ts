import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import type { UrlMetadata } from '@google/genai';
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

interface UrlMetadataEntry {
  url: string;
  status: string;
}

function collectUrlMetadata(urlMetadata: UrlMetadata[] | undefined): UrlMetadataEntry[] {
  const entries: UrlMetadataEntry[] = [];
  if (!urlMetadata) return entries;

  for (const meta of urlMetadata) {
    if (meta.retrievedUrl) {
      entries.push({
        url: meta.retrievedUrl,
        status: meta.urlRetrievalStatus ?? 'UNKNOWN',
      });
    }
  }

  return entries;
}

async function searchWork(
  {
    query,
    systemInstruction,
    urls,
  }: { query: string; systemInstruction?: string | undefined; urls?: string[] | undefined },
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

    if (urlMeta.length > 0) {
      const statusSummary = urlMeta.map((m) => `- ${m.url}: ${m.status}`).join('\n');
      result.content.push({
        type: 'text',
        text: `\n\nURL Retrieval Status:\n${statusSummary}`,
      });
    }

    await reportCompletion(
      ctx,
      TOOL_LABEL,
      `${sources.length} source${sources.length === 1 ? '' : 's'} found`,
    );

    return {
      ...result,
      structuredContent: {
        answer: answerText,
        sources,
        ...(urlMeta.length > 0 ? { urlMetadata: urlMeta } : {}),
      },
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
        'Answer questions using Gemini with Google Search grounding. ' +
        'Optionally provide URLs for deep analysis via URL Context.',
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
