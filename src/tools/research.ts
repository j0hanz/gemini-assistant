import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { buildGenerateContentConfig } from '../lib/config-utils.js';
import { sendProgress } from '../lib/context.js';
import {
  appendSources,
  appendUrlStatus,
  collectGroundedSources,
  collectUrlMetadata,
  formatCountLabel,
  pickDefined,
} from '../lib/response.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import {
  type AgenticSearchInput,
  AgenticSearchInputSchema,
  type AnalyzeUrlInput,
  AnalyzeUrlInputSchema,
  type SearchInput,
  SearchInputSchema,
} from '../schemas/inputs.js';
import {
  AgenticSearchOutputSchema,
  AnalyzeUrlOutputSchema,
  SearchOutputSchema,
} from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const SEARCH_TOOL_LABEL = 'Web Search';
const ANALYZE_URL_TOOL_LABEL = 'Analyze URL';
const AGENTIC_SEARCH_TOOL_LABEL = 'Agentic Search';

const SEARCH_SYSTEM_INSTRUCTION =
  'Synthesize search results into a direct, factual answer. ' +
  'Base answers strictly on the provided search grounding. Be concise.';

const ANALYZE_URL_SYSTEM_INSTRUCTION =
  'Structure findings with headings. Reference specific sections or data from the retrieved pages. ' +
  'Base analysis strictly on retrieved content.';

const AGENT_SYSTEM_INSTRUCTION =
  'You are a deep research agent. Given a topic, conduct thorough multi-faceted research.\n\n' +
  'Process:\n' +
  '1. Break the topic into distinct sub-questions.\n' +
  '2. Use Google Search to investigate each sub-question.\n' +
  '3. Use Code Execution to analyze data, compute comparisons, build tables, or verify calculations.\n' +
  '4. Synthesize all findings into a comprehensive, well-structured markdown report.\n' +
  '5. Use headings, bullet points, and tables where appropriate.\n' +
  '6. Be factual — only report what search results confirm.\n' +
  '7. Include specific data points, numbers, and dates when available.\n\n' +
  'IMPORTANT: Actively use code execution for any data-heavy analysis, ranking, sorting, or comparison tasks.';

function buildSearchContents(query: string, urls?: readonly string[]): string {
  if (!urls || urls.length === 0) {
    return query;
  }

  return `${query}\n\nAlso analyze content from:\n${urls.join('\n')}`;
}

function buildPromptWithUrls(urls: string[], question: string): string {
  return `Analyze the following URLs:\n${urls.join('\n')}\n\n${question}`;
}

function buildSourceReportMessage(sourceCount: number): string {
  return sourceCount > 0 ? `${formatCountLabel(sourceCount, 'source')} found` : 'completed';
}

async function searchWork(
  { query, systemInstruction, urls, thinkingLevel }: SearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (urls) {
    for (const url of urls) {
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid URL provided: ${url}` }],
          isError: true,
        };
      }
    }
  }

  await sendProgress(ctx, 0, undefined, `${SEARCH_TOOL_LABEL}: Starting`);
  const tools: Record<string, Record<string, never>>[] = [
    { googleSearch: {} },
    ...((urls?.length ?? 0) > 0 ? [{ urlContext: {} }] : []),
  ];

  return await handleToolExecution(
    ctx,
    'search',
    SEARCH_TOOL_LABEL,
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
      const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
      const contentAdditions: CallToolResult['content'] = [];

      appendSources(contentAdditions, sources);
      appendUrlStatus(contentAdditions, urlMetadata);

      return {
        resultMod: (result) => ({
          content: [...result.content, ...contentAdditions],
        }),
        structuredContent: pickDefined({
          answer: textContent,
          sources,
          urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
        }),
        reportMessage: buildSourceReportMessage(sources.length),
      };
    },
  );
}

async function analyzeUrlWork(
  { urls, question, systemInstruction, thinkingLevel }: AnalyzeUrlInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      return {
        content: [{ type: 'text', text: `Invalid URL provided: ${url}` }],
        isError: true,
      };
    }
  }

  await sendProgress(ctx, 0, undefined, `${ANALYZE_URL_TOOL_LABEL}: Fetching`);
  return await handleToolExecution(
    ctx,
    'analyze_url',
    ANALYZE_URL_TOOL_LABEL,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: buildPromptWithUrls(urls, question),
        config: {
          tools: [{ urlContext: {} }],
          ...buildGenerateContentConfig(
            {
              systemInstruction: systemInstruction ?? ANALYZE_URL_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'LOW',
            },
            ctx.mcpReq.signal,
          ),
        },
      }),
    (streamResult, textContent) => {
      const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
      const contentAdditions: CallToolResult['content'] = [];

      appendUrlStatus(contentAdditions, urlMetadata);

      return {
        resultMod: (result) => ({
          content: [...result.content, ...contentAdditions],
        }),
        structuredContent: pickDefined({
          answer: textContent,
          urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
        }),
        reportMessage: `${formatCountLabel(urlMetadata.length, 'URL')} retrieved`,
      };
    },
  );
}

async function agenticSearchWork(
  { topic, searchDepth, thinkingLevel }: AgenticSearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  await sendProgress(ctx, 0, undefined, `${AGENTIC_SEARCH_TOOL_LABEL}: Starting deep research`);
  const depthInstruction =
    searchDepth <= 2
      ? 'Do a focused search covering 2-3 key aspects.'
      : searchDepth <= 3
        ? 'Do a thorough search covering 4-5 key aspects.'
        : 'Do an exhaustive search covering as many aspects as possible.';

  return await handleToolExecution(
    ctx,
    'agentic_search',
    AGENTIC_SEARCH_TOOL_LABEL,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents:
          `Research this topic comprehensively: ${topic}\n\n` +
          `${depthInstruction}\n` +
          'Search for multiple different aspects and compile a detailed report.',
        config: {
          tools: [{ googleSearch: {} }, { codeExecution: {} }],
          toolConfig: { includeServerSideToolInvocations: true },
          ...buildGenerateContentConfig(
            {
              systemInstruction: AGENT_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'MEDIUM',
            },
            ctx.mcpReq.signal,
          ),
        },
      }),
    (streamResult, textContent) => {
      const sources = collectGroundedSources(streamResult.groundingMetadata);
      const contentAdditions: CallToolResult['content'] = [];

      appendSources(contentAdditions, sources);

      return {
        resultMod: (result) => ({
          content: [...result.content, ...contentAdditions],
        }),
        structuredContent: pickDefined({
          report: textContent,
          sources,
          toolsUsed: streamResult.toolsUsed.length > 0 ? streamResult.toolsUsed : undefined,
        }),
        reportMessage: buildSourceReportMessage(sources.length),
      };
    },
  );
}

export function registerSearchTool(server: McpServer): void {
  registerTaskTool(
    server,
    'search',
    {
      title: SEARCH_TOOL_LABEL,
      description:
        'Answer questions with Google Search grounding. ' +
        'Optionally include URLs for deep analysis via URL Context.',
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    searchWork,
  );
}

export function registerAnalyzeUrlTool(server: McpServer): void {
  registerTaskTool(
    server,
    'analyze_url',
    {
      title: ANALYZE_URL_TOOL_LABEL,
      description:
        'Fetch and analyze one or more public URLs via Gemini URL Context (max 20). ' +
        'Supports web pages, PDFs, images, and other public content.',
      inputSchema: AnalyzeUrlInputSchema,
      outputSchema: AnalyzeUrlOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    analyzeUrlWork,
  );
}

export function registerAgenticSearchTool(server: McpServer): void {
  registerTaskTool(
    server,
    'agentic_search',
    {
      title: AGENTIC_SEARCH_TOOL_LABEL,
      description:
        'Deep research with Google Search grounding and code execution. ' +
        'Uses tool combination to let Gemini autonomously search multiple aspects ' +
        'and compile a comprehensive report. Emits progress notifications.',
      inputSchema: AgenticSearchInputSchema,
      outputSchema: AgenticSearchOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    agenticSearchWork,
  );
}
