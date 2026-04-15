import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { FunctionCallingConfigMode } from '@google/genai';

import { sendProgress } from '../lib/errors.js';
import {
  appendSources,
  appendUrlStatus,
  collectGroundedSourceDetails,
  collectGroundedSources,
  collectUrlMetadata,
  formatCountLabel,
  pickDefined,
} from '../lib/response.js';
import { handleToolExecution, type StreamResult } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { validateUrls } from '../lib/validation.js';
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

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

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

function extractSampledText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'text' in entry
          ? String((entry as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }

  return typeof content === 'object' && content !== null && 'text' in content
    ? String((content as { text: unknown }).text)
    : '';
}

async function enrichTopicWithSampling(topic: string, ctx: ServerContext): Promise<string> {
  try {
    const samplingRes = await ctx.mcpReq.requestSampling({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `I'm about to research the topic "${topic}". Could you provide a brief initial impression or related core keywords I should focus on?`,
          },
        },
      ],
      maxTokens: 500,
      systemPrompt: 'You are a helpful assistant helping an agent formulate research strategies.',
    });

    const sampledText = extractSampledText(samplingRes.content);
    if (!sampledText) {
      return topic;
    }

    await ctx.mcpReq.log('info', `Sampled context: ${sampledText}`);
    return `${topic}\n\nAdditional related keywords/guidance: ${sampledText}`;
  } catch (error) {
    await ctx.mcpReq.log('info', `requestSampling encountered an issue: ${String(error)}`);
    return topic;
  }
}

function buildAgenticDepthInstruction(searchDepth: number): string {
  if (searchDepth <= 2) {
    return 'Do a focused search covering 2-3 key aspects.';
  }

  if (searchDepth <= 3) {
    return 'Do a thorough search covering 4-5 key aspects.';
  }

  return 'Do an exhaustive search covering as many aspects as possible.';
}

function buildAgenticSearchResult(streamResult: StreamResult, textContent: string) {
  const sources = collectGroundedSources(streamResult.groundingMetadata);
  const sourceDetails = collectGroundedSourceDetails(streamResult.groundingMetadata);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, sources);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      report: textContent,
      sources,
      sourceDetails: sourceDetails.length > 0 ? sourceDetails : undefined,
      toolsUsed: streamResult.toolsUsed.length > 0 ? streamResult.toolsUsed : undefined,
      functionCalls: streamResult.functionCalls.length > 0 ? streamResult.functionCalls : undefined,
    }),
    reportMessage: buildSourceReportMessage(sources.length),
  };
}

function buildSearchResult(streamResult: StreamResult, textContent: string) {
  const sources = collectGroundedSources(streamResult.groundingMetadata);
  const sourceDetails = collectGroundedSourceDetails(streamResult.groundingMetadata);
  const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, sources);
  appendUrlStatus(contentAdditions, urlMetadata);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      answer: textContent,
      sources,
      sourceDetails: sourceDetails.length > 0 ? sourceDetails : undefined,
      urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
    }),
    reportMessage: buildSourceReportMessage(sources.length),
  };
}

function buildAnalyzeUrlResult(streamResult: StreamResult, textContent: string) {
  const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
  const contentAdditions: CallToolResult['content'] = [];

  appendUrlStatus(contentAdditions, urlMetadata);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      answer: textContent,
      urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
    }),
    reportMessage: `${formatCountLabel(urlMetadata.length, 'URL')} retrieved`,
  };
}

async function searchWork(
  { query, systemInstruction, urls, thinkingLevel }: SearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  await sendProgress(ctx, 0, undefined, `${SEARCH_TOOL_LABEL}: Starting`);
  await ctx.mcpReq.log('info', `Search: ${query}`);
  const tools = [{ googleSearch: {} }, ...((urls?.length ?? 0) > 0 ? [{ urlContext: {} }] : [])];

  return await handleToolExecution(
    ctx,
    'search',
    SEARCH_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: buildSearchContents(query, urls),
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? SEARCH_SYSTEM_INSTRUCTION,
            thinkingLevel: thinkingLevel ?? 'LOW',
            tools,
            functionCallingMode: FunctionCallingConfigMode.ANY,
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildSearchResult,
  );
}

async function analyzeUrlWork(
  { urls, question, systemInstruction, thinkingLevel }: AnalyzeUrlInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  await sendProgress(ctx, 0, undefined, `${ANALYZE_URL_TOOL_LABEL}: Fetching`);
  await ctx.mcpReq.log('info', `Analyzing ${String(urls.length)} URL(s)`);
  return await handleToolExecution(
    ctx,
    'analyze_url',
    ANALYZE_URL_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: buildPromptWithUrls(urls, question),
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? ANALYZE_URL_SYSTEM_INSTRUCTION,
            thinkingLevel: thinkingLevel ?? 'LOW',
            tools: [{ urlContext: {} }],
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildAnalyzeUrlResult,
  );
}

async function agenticSearchWork(
  { topic, searchDepth, thinkingLevel }: AgenticSearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  await sendProgress(ctx, 0, undefined, `${AGENTIC_SEARCH_TOOL_LABEL}: Starting deep research`);
  await ctx.mcpReq.log('info', `Agentic search: ${topic}`);
  const enrichedTopic = await enrichTopicWithSampling(topic, ctx);
  const depthInstruction = buildAgenticDepthInstruction(searchDepth);

  return await handleToolExecution(
    ctx,
    'agentic_search',
    AGENTIC_SEARCH_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents:
          `Research this topic comprehensively: ${enrichedTopic}\n\n` +
          `${depthInstruction}\n` +
          'Search for multiple different aspects and compile a detailed report.',
        config: buildGenerateContentConfig(
          {
            systemInstruction: AGENT_SYSTEM_INSTRUCTION,
            thinkingLevel: thinkingLevel ?? 'MEDIUM',
            tools: [{ googleSearch: {} }, { codeExecution: {} }],
            toolConfig: { includeServerSideToolInvocations: true },
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildAgenticSearchResult,
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
