import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { AskThinkingLevel, buildGenerateContentConfig } from '../lib/config-utils.js';
import { appendUrlStatus, collectUrlMetadata } from '../lib/response.js';
import { executeToolStream, handleToolExecution } from '../lib/streaming.js';
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
    thinkingLevel,
  }: {
    query: string;
    systemInstruction?: string | undefined;
    urls?: string[] | undefined;
    thinkingLevel?: AskThinkingLevel | undefined;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Web Search';
  const hasUrls = urls && urls.length > 0;
  const contents = hasUrls ? `${query}\n\nAlso analyze content from:\n${urls.join('\n')}` : query;

  const tools: Record<string, Record<string, never>>[] = [
    { googleSearch: {} },
    ...(hasUrls ? [{ urlContext: {} }] : []),
  ];

  return await handleToolExecution(
    ctx,
    'search',
    TOOL_LABEL,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          tools,
          ...buildGenerateContentConfig(
            {
              systemInstruction: systemInstruction ?? SEARCH_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'LOW',
            },
            ctx.mcpReq.signal,
          ),
          maxOutputTokens: 4096,
        },
      }),
    (streamResult, textContent) => {
      const sources = collectGroundedSources(streamResult.groundingMetadata);
      const urlMeta = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);

      const contentPush: CallToolResult['content'] = [];

      if (sources.length > 0) {
        contentPush.push({
          type: 'text',
          text: `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}`,
        });
      }

      appendUrlStatus(contentPush, urlMeta);

      return {
        resultMod: (r) => ({
          content: [...r.content, ...contentPush],
        }),
        structuredContent: {
          answer: textContent || '',
          sources,
          ...(urlMeta.length > 0 ? { urlMetadata: urlMeta } : {}),
        },
        reportMessage:
          sources.length > 0
            ? `${sources.length} source${sources.length === 1 ? '' : 's'} found`
            : `responded (${textContent.length} chars)`,
      };
    },
  );
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
