import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { buildGenerateContentConfig } from '../lib/config-utils.js';
import {
  appendSources,
  appendUrlStatus,
  collectGroundedSources,
  collectUrlMetadata,
  formatCountLabel,
  pickDefined,
} from '../lib/response.js';
import { handleToolExecution } from '../lib/streaming.js';
import { createToolTaskHandlers, READONLY_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { type SearchInput, SearchInputSchema } from '../schemas/inputs.js';
import { SearchOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const SEARCH_SYSTEM_INSTRUCTION =
  'Synthesize search results into a direct, factual answer. ' +
  'Base answers strictly on the provided search grounding. Be concise.';

function buildSearchContents(query: string, urls?: readonly string[]): string {
  if (!urls || urls.length === 0) {
    return query;
  }

  return `${query}\n\nAlso analyze content from:\n${urls.join('\n')}`;
}

function buildSearchReportMessage(sourceCount: number, responseLength: number): string {
  return sourceCount > 0
    ? `${formatCountLabel(sourceCount, 'source')} found`
    : `responded (${responseLength} chars)`;
}

async function searchWork(
  { query, systemInstruction, urls, thinkingLevel }: SearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Web Search';
  const hasUrls = (urls?.length ?? 0) > 0;

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
        contents: buildSearchContents(query, urls),
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

      const contentAdditions: CallToolResult['content'] = [];
      appendSources(contentAdditions, sources);
      appendUrlStatus(contentAdditions, urlMeta);

      return {
        resultMod: (r) => ({
          content: [...r.content, ...contentAdditions],
        }),
        structuredContent: pickDefined({
          answer: textContent,
          sources,
          urlMetadata: urlMeta.length > 0 ? urlMeta : undefined,
        }),
        reportMessage: buildSearchReportMessage(sources.length, textContent.length),
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
