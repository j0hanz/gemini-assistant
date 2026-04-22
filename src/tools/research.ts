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
import { pickDefined } from '../lib/object.js';
import { resolveOrchestration } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import {
  appendSources,
  appendUrlStatus,
  buildBaseStructuredOutput,
  collectGroundedSourceDetails,
  collectGroundedSources,
  collectGroundingCitations,
  collectSearchEntryPoint,
  collectUrlMetadata,
  formatCountLabel,
  mergeSourceDetails,
  safeValidateStructuredContent,
} from '../lib/response.js';
import { type StreamResult } from '../lib/streaming.js';
import {
  elicitTaskInput,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerTaskTool,
} from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
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
type GenerationConfigFields = Pick<
  ResearchInput,
  'maxOutputTokens' | 'safetySettings' | 'thinkingBudget'
>;

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
  return sourceCount > 0
    ? `${formatCountLabel(sourceCount, 'source')} found`
    : 'completed with no grounded sources surfaced';
}

function formatSourceLabels(
  sourceDetails: readonly { title?: string | undefined; url: string }[],
): string[] {
  return sourceDetails.map((source) =>
    source.title ? `${source.title}: ${source.url}` : source.url,
  );
}

function collectUrlContextSources(
  urlMetadata: readonly { status: string; url: string }[],
): string[] {
  return urlMetadata
    .filter((entry) => entry.status === 'URL_RETRIEVAL_STATUS_SUCCESS')
    .map((entry) => entry.url);
}

function buildUrlContextSourceDetails(
  urls: readonly string[],
): { origin: 'urlContext'; url: string }[] {
  return urls.map((url) => ({ origin: 'urlContext', url }));
}

function appendSearchEntryPointContent(
  content: CallToolResult['content'],
  renderedContent?: string,
): void {
  if (!renderedContent) return;
  content.push({
    type: 'text',
    text: `Google Search Suggestions:\n${renderedContent}`,
  });
}

function buildDroppedSupportWarnings(droppedSupportCount: number): string[] {
  return droppedSupportCount > 0
    ? [`dropped ${String(droppedSupportCount)} non-public grounding supports`]
    : [];
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
    return `${topic}\n\nPlanning notes (unverified leads; verify before relying on them):\n${sampledText}`;
  } catch (error) {
    await ctx.mcpReq.log('info', 'Sampling unavailable; continuing without extra angles');
    log.info('requestSampling encountered an issue', {
      error: AppError.formatMessage(error),
    });
    return topic;
  }
}

function countOccurrences(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function emitDeepResearchToolBudgetLogs(
  ctx: ServerContext,
  streamResult: StreamResult,
  searchDepth: number,
): void {
  const toolsUsedOccurrences = countOccurrences(streamResult.toolsUsedOccurrences);
  const payload = {
    searchDepth,
    toolsUsed: streamResult.toolsUsed,
    toolsUsedOccurrences,
  };

  log.info('deep research tool budget observed', payload);
  void ctx.mcpReq
    .log('info', `deep research tool budget observed at depth ${String(searchDepth)}`)
    .catch(() => undefined);

  if (searchDepth >= 3 && !('codeExecution' in toolsUsedOccurrences)) {
    log.warn('deep research did not invoke Code Execution', payload);
    void ctx.mcpReq
      .log('warning', 'deep research did not invoke Code Execution')
      .catch(() => undefined);
  }
}

function buildAgenticSearchResult(
  streamResult: StreamResult,
  textContent: string,
  ctx: ServerContext,
  searchDepth: number,
) {
  emitDeepResearchToolBudgetLogs(ctx, streamResult, searchDepth);

  const groundedSources = collectGroundedSources(streamResult.groundingMetadata);
  const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
  const urlContextSources = collectUrlContextSources(urlMetadata);
  const sourceDetails = mergeSourceDetails(
    collectGroundedSourceDetails(streamResult.groundingMetadata, new Set(urlContextSources)),
    buildUrlContextSourceDetails(urlContextSources),
  );
  const { citations, droppedSupportCount } = collectGroundingCitations(
    streamResult.groundingMetadata,
  );
  const searchEntryPoint = collectSearchEntryPoint(streamResult.groundingMetadata);
  const warnings = buildDroppedSupportWarnings(droppedSupportCount);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(sourceDetails));
  appendUrlStatus(contentAdditions, urlMetadata);
  appendSearchEntryPointContent(contentAdditions, searchEntryPoint?.renderedContent);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      report: textContent,
      sources: groundedSources,
      sourceDetails: sourceDetails.length > 0 ? sourceDetails : undefined,
      urlContextSources: urlContextSources.length > 0 ? urlContextSources : undefined,
      urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
      toolsUsed: streamResult.toolsUsed.length > 0 ? streamResult.toolsUsed : undefined,
      grounded: groundedSources.length > 0,
      urlContextUsed: urlContextSources.length > 0,
      citations: citations.length > 0 ? citations : undefined,
      searchEntryPoint,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    reportMessage: buildSourceReportMessage(groundedSources.length),
  };
}

function buildSearchResult(streamResult: StreamResult, textContent: string) {
  const groundedSources = collectGroundedSources(streamResult.groundingMetadata);
  const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
  const urlContextSources = collectUrlContextSources(urlMetadata);
  const sourceDetails = mergeSourceDetails(
    collectGroundedSourceDetails(streamResult.groundingMetadata, new Set(urlContextSources)),
    buildUrlContextSourceDetails(urlContextSources),
  );
  const { citations, droppedSupportCount } = collectGroundingCitations(
    streamResult.groundingMetadata,
  );
  const searchEntryPoint = collectSearchEntryPoint(streamResult.groundingMetadata);
  const warnings = buildDroppedSupportWarnings(droppedSupportCount);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(sourceDetails));
  appendUrlStatus(contentAdditions, urlMetadata);
  appendSearchEntryPointContent(contentAdditions, searchEntryPoint?.renderedContent);
  if (groundedSources.length === 0 && urlMetadata.length === 0) {
    contentAdditions.push({
      type: 'text',
      text: 'No grounded sources were retrieved; the answer may be ungrounded.',
    });
  }

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      answer: textContent,
      sources: groundedSources,
      sourceDetails: sourceDetails.length > 0 ? sourceDetails : undefined,
      urlContextSources: urlContextSources.length > 0 ? urlContextSources : undefined,
      urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
      grounded: groundedSources.length > 0,
      urlContextUsed: urlContextSources.length > 0,
      citations: citations.length > 0 ? citations : undefined,
      searchEntryPoint,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    reportMessage: buildSourceReportMessage(groundedSources.length),
  };
}

function buildAnalyzeUrlResult(streamResult: StreamResult, textContent: string) {
  const groundedSources = collectGroundedSources(streamResult.groundingMetadata);
  const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);
  const urlContextSources = collectUrlContextSources(urlMetadata);
  const sourceDetails = mergeSourceDetails(
    collectGroundedSourceDetails(streamResult.groundingMetadata, new Set(urlContextSources)),
    buildUrlContextSourceDetails(urlContextSources),
  );
  const { citations, droppedSupportCount } = collectGroundingCitations(
    streamResult.groundingMetadata,
  );
  const searchEntryPoint = collectSearchEntryPoint(streamResult.groundingMetadata);
  const warnings = buildDroppedSupportWarnings(droppedSupportCount);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(sourceDetails));
  appendUrlStatus(contentAdditions, urlMetadata);
  appendSearchEntryPointContent(contentAdditions, searchEntryPoint?.renderedContent);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      summary: textContent,
      sources: groundedSources.length > 0 ? groundedSources : undefined,
      sourceDetails: sourceDetails.length > 0 ? sourceDetails : undefined,
      urlContextSources: urlContextSources.length > 0 ? urlContextSources : undefined,
      urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
      grounded: groundedSources.length > 0,
      urlContextUsed: urlContextSources.length > 0,
      citations: citations.length > 0 ? citations : undefined,
      searchEntryPoint,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    reportMessage: `${formatCountLabel(urlMetadata.length, 'URL')} retrieved`,
  };
}

async function searchWork(
  {
    query,
    systemInstruction,
    urls,
    thinkingLevel,
    thinkingBudget,
    maxOutputTokens,
    safetySettings,
  }: SearchInput & GenerationConfigFields,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const resolved = await resolveOrchestration(
    {
      builtInToolNames:
        (urls?.length ?? 0) > 0
          ? (['googleSearch', 'urlContext'] as const)
          : (['googleSearch'] as const),
      urls,
      includeServerSideToolInvocations: true,
    },
    ctx,
    'search',
  );
  if (resolved.error) return resolved.error;
  const { tools, toolConfig } = resolved.config;
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
            thinkingBudget,
            maxOutputTokens,
            safetySettings,
            tools,
            toolConfig,
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildSearchResult,
  );
}

export async function analyzeUrlWork(
  {
    urls,
    question,
    systemInstruction,
    thinkingLevel,
    thinkingBudget,
    maxOutputTokens,
    safetySettings,
  }: AnalyzeUrlInput & GenerationConfigFields,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const resolved = await resolveOrchestration(
    { builtInToolNames: ['urlContext'] as const, urls, includeServerSideToolInvocations: true },
    ctx,
    'analyze_url',
  );
  if (resolved.error) return resolved.error;
  const { tools, toolConfig } = resolved.config;

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
            thinkingBudget,
            maxOutputTokens,
            safetySettings,
            tools,
            toolConfig,
          },
          ctx.mcpReq.signal,
        ),
      }),
    buildAnalyzeUrlResult,
  );
}

async function agenticSearchWork(
  {
    deliverable,
    topic,
    searchDepth,
    thinkingLevel,
    thinkingBudget,
    urls,
    maxOutputTokens,
    safetySettings,
  }: Omit<AgenticSearchInput, 'thinkingLevel'> &
    GenerationConfigFields & {
      deliverable?: string | undefined;
      thinkingLevel?: ResearchInput['thinkingLevel'] | undefined;
      urls?: readonly string[] | undefined;
    },
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (searchDepth >= 5 || (searchDepth >= 4 && !deliverable)) {
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
    deliverable,
    searchDepth,
    topic: enrichedTopic,
    urls,
  });

  const resolved = await resolveOrchestration(
    {
      builtInToolNames:
        (urls?.length ?? 0) > 0
          ? (['googleSearch', 'urlContext', 'codeExecution'] as const)
          : (['googleSearch', 'codeExecution'] as const),
      urls,
      includeServerSideToolInvocations: true,
    },
    ctx,
    'agentic_search',
  );
  if (resolved.error) return resolved.error;
  const { tools, toolConfig } = resolved.config;

  return runToolStream(
    ctx,
    'research',
    AGENTIC_SEARCH_TOOL_LABEL,
    'Starting deep research',
    'Agentic search requested',
    { topic, searchDepth, urlCount: urls?.length ?? 0 },
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: prompt.systemInstruction,
            thinkingLevel,
            thinkingBudget,
            maxOutputTokens,
            safetySettings,
            tools,
            toolConfig,
          },
          ctx.mcpReq.signal,
        ),
      }),
    (streamResult, textContent) =>
      buildAgenticSearchResult(streamResult, textContent, ctx, searchDepth),
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
      thinkingBudget: args.thinkingBudget,
      urls: args.urls,
      maxOutputTokens: args.maxOutputTokens,
      safetySettings: args.safetySettings,
    },
    ctx,
  );
}

async function runDeepResearch(args: ResearchInput, ctx: ServerContext): Promise<CallToolResult> {
  const searchDepth = args.searchDepth ?? 3;
  const hasExplicitThinkingLevel = Object.prototype.hasOwnProperty.call(args, 'thinkingLevel');
  const thinkingLevel = hasExplicitThinkingLevel
    ? args.thinkingLevel
    : searchDepth >= 4
      ? 'HIGH'
      : searchDepth >= 3
        ? 'MEDIUM'
        : undefined;

  return await agenticSearchWork(
    {
      deliverable: args.deliverable,
      topic: args.goal,
      searchDepth,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      thinkingBudget: args.thinkingBudget,
      urls: args.urls,
      maxOutputTokens: args.maxOutputTokens,
      safetySettings: args.safetySettings,
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
    ...buildBaseStructuredOutput(
      ctx.task?.id,
      Array.isArray(structured.warnings)
        ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
        : undefined,
    ),
    mode: args.mode,
    summary: extractResearchSummary(structured),
    sources: Array.isArray(structured.sources) ? structured.sources : [],
    ...(structured.sourceDetails ? { sourceDetails: structured.sourceDetails } : {}),
    ...(structured.urlContextSources ? { urlContextSources: structured.urlContextSources } : {}),
    ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
    ...(structured.toolsUsed ? { toolsUsed: structured.toolsUsed } : {}),
    ...(structured.grounded !== undefined ? { grounded: structured.grounded } : {}),
    ...(structured.urlContextUsed !== undefined
      ? { urlContextUsed: structured.urlContextUsed }
      : {}),
    ...(structured.citations ? { citations: structured.citations } : {}),
    ...(structured.searchEntryPoint ? { searchEntryPoint: structured.searchEntryPoint } : {}),
    ...(structured.contextUsed ? { contextUsed: structured.contextUsed } : {}),
    ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
    ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
    ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
    ...(structured.usage ? { usage: structured.usage } : {}),
    ...(structured.safetyRatings ? { safetyRatings: structured.safetyRatings } : {}),
    ...(structured.finishMessage ? { finishMessage: structured.finishMessage } : {}),
    ...(structured.citationMetadata ? { citationMetadata: structured.citationMetadata } : {}),
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
  return safeValidateStructuredContent(
    'research',
    ResearchOutputSchema,
    buildResearchStructuredContent(args, ctx, structured),
    result,
  );
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
