import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import {
  buildAgenticResearchPrompt,
  buildFileAnalysisPrompt,
  buildGroundedAnswerPrompt,
} from '../lib/model-prompts.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import {
  appendSources,
  appendUrlStatus,
  buildBaseStructuredOutput,
  collectGroundedSourceDetails,
  collectGroundedSources,
  collectUrlMetadata,
  formatCountLabel,
  pickDefined,
} from '../lib/response.js';
import { type StreamResult } from '../lib/streaming.js';
import { elicitTaskInput, READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { validateUrls } from '../lib/validation.js';
import {
  type AgenticSearchInput,
  AgenticSearchInputSchema,
  type AnalyzeUrlInput,
  AnalyzeUrlInputSchema,
  type ResearchInput,
  ResearchInputSchema,
  type SearchInput,
  SearchInputSchema,
} from '../schemas/inputs.js';
import {
  AgenticSearchOutputSchema,
  AnalyzeUrlOutputSchema,
  ResearchOutputSchema,
  SearchOutputSchema,
} from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const SEARCH_TOOL_LABEL = 'Web Search';
const ANALYZE_URL_TOOL_LABEL = 'Analyze URL';
const AGENTIC_SEARCH_TOOL_LABEL = 'Agentic Search';

function buildSourceReportMessage(sourceCount: number): string {
  return sourceCount > 0 ? `${formatCountLabel(sourceCount, 'source')} found` : 'completed';
}

function formatSourceLabels(
  sourceDetails: readonly { title?: string | undefined; url: string }[],
): string[] {
  return sourceDetails.map((source) =>
    source.title ? `${source.title}: ${source.url}` : source.url,
  );
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

export function buildAgenticSearchResult(streamResult: StreamResult, textContent: string) {
  const sources = collectGroundedSources(streamResult.groundingMetadata);
  const sourceDetails = collectGroundedSourceDetails(streamResult.groundingMetadata);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(sourceDetails));

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      report: textContent,
      sources,
      sourceDetails: sourceDetails.length > 0 ? sourceDetails : undefined,
      toolsUsed: streamResult.toolsUsed.length > 0 ? streamResult.toolsUsed : undefined,
    }),
    reportMessage: buildSourceReportMessage(sources.length),
  };
}

export function buildSearchResult(streamResult: StreamResult, textContent: string) {
  const groundedSources = collectGroundedSources(streamResult.groundingMetadata);
  const sourceDetails = collectGroundedSourceDetails(streamResult.groundingMetadata);
  const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
  const contentAdditions: CallToolResult['content'] = [];

  // Fallback: when grounding metadata is empty but URL-context succeeded,
  // surface the retrieved URLs as sources so the response is transparent
  // about what was consumed.
  const urlFallbackSources =
    groundedSources.length === 0
      ? urlMetadata
          .filter((entry) => entry.status === 'URL_RETRIEVAL_STATUS_SUCCESS')
          .map((entry) => entry.url)
      : [];
  const sources = groundedSources.length > 0 ? groundedSources : urlFallbackSources;

  appendSources(contentAdditions, formatSourceLabels(sourceDetails));
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

export function buildAnalyzeUrlResult(streamResult: StreamResult, textContent: string) {
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

export async function searchWork(
  { query, systemInstruction, urls, thinkingLevel }: SearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  const progress = new ProgressReporter(ctx, SEARCH_TOOL_LABEL);
  await progress.send(0, undefined, 'Starting');
  await ctx.mcpReq.log('info', `Search: ${query}`);
  const { functionCallingMode, toolConfig, tools } = buildOrchestrationConfig({
    toolProfile: (urls?.length ?? 0) > 0 ? 'search_url' : 'search',
  });
  const prompt = buildGroundedAnswerPrompt(query, urls);

  return await executor.runStream(
    ctx,
    'search',
    SEARCH_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? prompt.systemInstruction,
            thinkingLevel: thinkingLevel ?? 'LOW',
            functionCallingMode,
            toolConfig,
            tools,
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildSearchResult,
  );
}

export async function analyzeUrlWork(
  { urls, question, systemInstruction, thinkingLevel }: AnalyzeUrlInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) {
    return invalidUrlResult;
  }

  const progress = new ProgressReporter(ctx, ANALYZE_URL_TOOL_LABEL);
  await progress.send(0, undefined, 'Fetching');
  await ctx.mcpReq.log('info', `Analyzing ${String(urls.length)} URL(s)`);
  const prompt = buildFileAnalysisPrompt({
    goal: question,
    kind: 'url',
    urls,
  });

  return await executor.runStream(
    ctx,
    'analyze_url',
    ANALYZE_URL_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? prompt.systemInstruction,
            thinkingLevel: thinkingLevel ?? 'LOW',
            ...buildOrchestrationConfig({ toolProfile: 'url' }),
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildAnalyzeUrlResult,
  );
}

export async function agenticSearchWork(
  { topic, searchDepth, thinkingLevel }: AgenticSearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (searchDepth && searchDepth > 3) {
    try {
      const constraint = await elicitTaskInput(
        ctx,
        `High depth research requested (${searchDepth}). What specific aspect should the agent focus on? (Or reply 'none' to proceed)`,
        'Waiting for constraints for deep research',
      );
      if (constraint && constraint.trim().toLowerCase() !== 'none') {
        topic = `${topic}\n\nAdditional User Constraint: ${constraint}`;
      }
    } catch (err) {
      await ctx.mcpReq.log('warning', `Elicitation skipped or failed: ${String(err)}`);
    }
  }

  const progress = new ProgressReporter(ctx, AGENTIC_SEARCH_TOOL_LABEL);
  await progress.send(0, undefined, 'Starting deep research');
  await ctx.mcpReq.log('info', `Agentic search: ${topic}`);
  const enrichedTopic = await enrichTopicWithSampling(topic, ctx);
  const prompt = buildAgenticResearchPrompt({
    searchDepth,
    topic: enrichedTopic,
  });

  return await executor.runStream(
    ctx,
    'agentic_search',
    AGENTIC_SEARCH_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: prompt.systemInstruction,
            thinkingLevel: thinkingLevel ?? 'MEDIUM',
            ...buildOrchestrationConfig({
              includeServerSideToolInvocations: true,
              toolProfile: 'search_code',
            }),
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildAgenticSearchResult,
  );
}

async function runQuickResearch(
  args: Extract<ResearchInput, { mode: 'quick' }>,
  ctx: ServerContext,
): Promise<CallToolResult> {
  return await searchWork(
    {
      query: args.goal,
      systemInstruction: args.systemInstruction,
      thinkingLevel: args.thinkingLevel,
      urls: args.urls,
    },
    ctx,
  );
}

async function runDeepResearch(
  args: Extract<ResearchInput, { mode: 'deep' }>,
  ctx: ServerContext,
): Promise<CallToolResult> {
  return await agenticSearchWork(
    {
      topic: args.deliverable
        ? `${args.goal}\n\nRequested deliverable: ${args.deliverable}`
        : args.goal,
      searchDepth: args.searchDepth,
      thinkingLevel: args.thinkingLevel,
    },
    ctx,
  );
}

function extractResearchSummary(structured: Record<string, unknown>): string {
  if (typeof structured.answer === 'string') {
    return structured.answer;
  }

  return typeof structured.report === 'string' ? structured.report : '';
}

function buildResearchStructuredContent(
  args: ResearchInput,
  ctx: ServerContext,
  structured: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...buildBaseStructuredOutput(ctx.task?.id),
    mode: args.mode,
    summary: extractResearchSummary(structured),
    sources: Array.isArray(structured.sources) ? structured.sources : [],
    ...(structured.sourceDetails ? { sourceDetails: structured.sourceDetails } : {}),
    ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
    ...(structured.toolsUsed ? { toolsUsed: structured.toolsUsed } : {}),
    ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
    ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
    ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
    ...(structured.usage ? { usage: structured.usage } : {}),
  };
}

async function researchWork(args: ResearchInput, ctx: ServerContext): Promise<CallToolResult> {
  const result =
    args.mode === 'quick' ? await runQuickResearch(args, ctx) : await runDeepResearch(args, ctx);

  if (result.isError) {
    return result;
  }

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;

  return {
    ...result,
    structuredContent: buildResearchStructuredContent(args, ctx, structured),
  };
}

export function registerResearchTool(server: McpServer, taskMessageQueue: TaskMessageQueue): void {
  registerTaskTool(
    server,
    'research',
    {
      title: 'Research',
      description: 'Quick grounded lookup or deeper multi-step research with an explicit mode.',
      inputSchema: ResearchInputSchema,
      outputSchema: ResearchOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    taskMessageQueue,
    researchWork,
  );
}

export function registerSearchTool(server: McpServer, taskMessageQueue: TaskMessageQueue): void {
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
    taskMessageQueue,
    searchWork,
  );
}

export function registerAnalyzeUrlTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
): void {
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
    taskMessageQueue,
    analyzeUrlWork,
  );
}

export function registerAgenticSearchTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
): void {
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
    taskMessageQueue,
    agenticSearchWork,
  );
}
