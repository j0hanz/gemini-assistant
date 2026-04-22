import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { AppError } from '../lib/errors.js';
import { logger, maybeSummarizePayload } from '../lib/logger.js';
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
  validateStructuredContent,
} from '../lib/response.js';
import { type StreamResult } from '../lib/streaming.js';
import {
  elicitTaskInput,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerTaskTool,
} from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { validateUrls } from '../lib/validation.js';
import {
  type AgenticSearchInput,
  type AnalyzeUrlInput,
  type ResearchInput,
  ResearchInputSchema,
  type SearchInput,
} from '../schemas/inputs.js';
import { ResearchOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const SEARCH_TOOL_LABEL = 'Web Search';
const ANALYZE_URL_TOOL_LABEL = 'Analyze URL';
const AGENTIC_SEARCH_TOOL_LABEL = 'Agentic Search';
const log = logger.child('research');

type StreamGenerator = () => Promise<
  AsyncGenerator<import('@google/genai').GenerateContentResponse>
>;
type StreamResponseBuilder<T extends Record<string, unknown>> = Parameters<
  typeof executor.runStream<T>
>[4];

async function runToolStream<T extends Record<string, unknown>>(
  ctx: ServerContext,
  toolKey: string,
  label: string,
  initialMsg: string,
  logMessage: string,
  logData: unknown,
  startFn: StreamGenerator,
  resultFn?: StreamResponseBuilder<T>,
): Promise<CallToolResult> {
  const progress = new ProgressReporter(ctx, label);
  await progress.send(0, undefined, initialMsg);
  await ctx.mcpReq.log('info', logMessage);
  log.info(logMessage, maybeSummarizePayload(logData, log.getVerbosePayloads()));
  return executor.runStream(ctx, toolKey, label, startFn, resultFn);
}

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
        typeof entry === 'object' && entry !== null && 'text' in entry ? String(entry.text) : '',
      )
      .join('\n');
  }

  return typeof content === 'object' && content !== null && 'text' in content
    ? String(content.text)
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

    await ctx.mcpReq.log('info', 'Sampling provided research angles');
    log.debug('Sampling provided research angles', { sampledTextLength: sampledText.length });
    return `${topic}\n\nKeywords/angles:\n${sampledText}`;
  } catch (error) {
    await ctx.mcpReq.log('info', 'Sampling unavailable; continuing without extra angles');
    log.info('requestSampling encountered an issue', {
      error: AppError.formatMessage(error),
    });
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

function buildSearchResult(streamResult: StreamResult, textContent: string) {
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

  const { functionCallingMode, toolConfig, tools } = buildOrchestrationConfig({
    toolProfile: (urls?.length ?? 0) > 0 ? 'search_url' : 'search',
  });
  const prompt = buildGroundedAnswerPrompt(query, urls);

  return runToolStream(
    ctx,
    'research',
    SEARCH_TOOL_LABEL,
    'Starting',
    'Search requested',
    { query, urlCount: urls?.length ?? 0 },
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? prompt.systemInstruction,
            thinkingLevel,
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

  const prompt = buildFileAnalysisPrompt({
    goal: question,
    kind: 'url',
    urls,
  });

  return runToolStream(
    ctx,
    'analyze_url',
    ANALYZE_URL_TOOL_LABEL,
    'Fetching',
    'Analyze URL requested',
    { question, urlCount: urls.length },
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? prompt.systemInstruction,
            thinkingLevel,
            ...buildOrchestrationConfig({ toolProfile: 'url' }),
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
      await ctx.mcpReq.log('warning', 'Elicitation skipped; continuing without extra constraints');
      log.warn('Elicitation skipped or failed', { error: AppError.formatMessage(err) });
    }
  }

  const enrichedTopic = await enrichTopicWithSampling(topic, ctx);
  const prompt = buildAgenticResearchPrompt({
    searchDepth,
    topic: enrichedTopic,
  });

  return runToolStream(
    ctx,
    'research',
    AGENTIC_SEARCH_TOOL_LABEL,
    'Starting deep research',
    'Agentic search requested',
    { topic, searchDepth },
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: prompt.systemInstruction,
            thinkingLevel,
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
  args: ResearchInput & {
    mode: 'quick';
  },
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

async function runDeepResearch(args: ResearchInput, ctx: ServerContext): Promise<CallToolResult> {
  return await agenticSearchWork(
    {
      topic: args.deliverable
        ? `${args.goal}\n\nRequested deliverable: ${args.deliverable}`
        : args.goal,
      searchDepth: args.searchDepth ?? 3,
      thinkingLevel: args.thinkingLevel,
    },
    ctx,
  );
}

function isQuickResearchInput(args: ResearchInput): args is ResearchInput & {
  mode: 'quick';
} {
  return args.mode === 'quick';
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
  const result = isQuickResearchInput(args)
    ? await runQuickResearch(args, ctx)
    : await runDeepResearch(args, ctx);

  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent ?? {};
  const structuredContent = validateStructuredContent(
    'research',
    ResearchOutputSchema,
    buildResearchStructuredContent(args, ctx, structured),
  );

  return {
    ...result,
    structuredContent,
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
      annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    },
    taskMessageQueue,
    researchWork,
  );
}
