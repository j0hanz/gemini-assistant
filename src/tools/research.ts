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

const SEARCH_SYSTEM_INSTRUCTION = 'Answer from grounded search results only. Be concise.';

const ANALYZE_URL_SYSTEM_INSTRUCTION =
  'Answer from retrieved URL content only. Cite relevant sections, fields, or short quotes.';

const AGENT_SYSTEM_INSTRUCTION =
  'Research with Google Search and Code Execution.\n\n' +
  'Process:\n' +
  '1. Split the topic into sub-questions.\n' +
  '2. Search multiple angles.\n' +
  '3. Use Code Execution for calculations, comparisons, rankings, and tables when useful.\n' +
  '4. Write a grounded Markdown report.\n' +
  '5. Include concrete numbers and dates when available.\n' +
  '6. Do not state unsupported claims.';

function buildSearchContents(query: string, urls?: readonly string[]): string {
  if (!urls || urls.length === 0) {
    return query;
  }

  return `${query}\n\nUse these URLs too:\n${urls.join('\n')}`;
}

function buildPromptWithUrls(urls: string[], question: string): string {
  return `URLs:\n${urls.join('\n')}\n\nTask: ${question}`;
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
            text: `Topic: "${topic}"\nGive brief starting keywords or angles to research.`,
          },
        },
      ],
      maxTokens: 500,
      systemPrompt: 'Help an agent choose research angles.',
    });

    const sampledText = extractSampledText(samplingRes.content);
    if (!sampledText) {
      return topic;
    }

    await ctx.mcpReq.log('info', `Sampled context: ${sampledText}`);
    return `${topic}\n\nKeywords/angles:\n${sampledText}`;
  } catch (error) {
    await ctx.mcpReq.log('info', `requestSampling encountered an issue: ${String(error)}`);
    return topic;
  }
}

function buildAgenticDepthInstruction(searchDepth: number): string {
  if (searchDepth <= 2) {
    return 'Focused: cover 2-3 key aspects.';
  }

  if (searchDepth <= 3) {
    return 'Thorough: cover 4-5 key aspects.';
  }

  return 'Exhaustive: cover as many relevant aspects as possible.';
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
          `Topic: ${enrichedTopic}\n\n` +
          `${depthInstruction}\n\n` +
          'Task: research the topic and produce a grounded report.',
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
