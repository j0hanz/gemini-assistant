import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import type {
  GroundingChunk,
  GroundingMetadata,
  GroundingSupport,
  UrlContextMetadata,
} from '@google/genai';

import { AppError } from '../lib/errors.js';
import { logger, maybeSummarizePayload } from '../lib/logger.js';
import {
  buildAgenticResearchPrompt,
  buildFileAnalysisPrompt,
  buildGroundedAnswerPrompt,
} from '../lib/model-prompts.js';
import { pickDefined } from '../lib/object.js';
import {
  type BuiltInToolName,
  type BuiltInToolSpec,
  resolveOrchestration,
  selectSearchAndUrlContextTools,
} from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import {
  appendSources,
  appendUrlStatus,
  buildBaseStructuredOutput,
  collectGroundedSourceDetailsWithCounts,
  collectGroundedSourcesWithCounts,
  collectGroundingCitations,
  collectSearchEntryPoint,
  collectUrlMetadataWithCounts,
  computeGroundingSignals,
  deriveFindingsFromCitations,
  deriveOverallStatus,
  formatCountLabel,
  mergeSourceDetails,
  safeValidateStructuredContent,
} from '../lib/response.js';
import {
  deriveComputationsFromToolEvents,
  executeToolStream,
  type StreamResult,
} from '../lib/streaming.js';
import {
  elicitTaskInput,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerTaskTool,
} from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { getWorkspaceCacheName } from '../lib/workspace-context.js';
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
const MAX_DEEP_RESEARCH_TURNS = 4;
const log = logger.child('research');

type StreamGenerator = () => Promise<
  AsyncGenerator<import('@google/genai').GenerateContentResponse>
>;
type StreamResponseBuilder<T extends Record<string, unknown>> = Parameters<
  typeof executor.runStream<T>
>[4];
type GenerationConfigFields = Pick<
  ResearchInput,
  'maxOutputTokens' | 'safetySettings' | 'thinkingBudget' | 'fileSearch'
>;

function buildResearchBuiltInSpecs(
  names: readonly BuiltInToolName[] | undefined,
  fileSearch: ResearchInput['fileSearch'] | undefined,
): BuiltInToolSpec[] {
  const specs: BuiltInToolSpec[] = (names ?? []).map((kind) => ({ kind }) as BuiltInToolSpec);
  if (fileSearch) {
    specs.push({
      kind: 'fileSearch',
      fileSearchStoreNames: fileSearch.fileSearchStoreNames,
      ...(fileSearch.metadataFilter !== undefined
        ? { metadataFilter: fileSearch.metadataFilter }
        : {}),
    });
  }
  return specs;
}

function buildGroundedResearchBuiltInSpecs(
  urls: readonly string[] | undefined,
  fileSearch: ResearchInput['fileSearch'] | undefined,
  extraTools: readonly BuiltInToolName[] = [],
): BuiltInToolSpec[] {
  return buildResearchBuiltInSpecs(
    [...selectSearchAndUrlContextTools(true, urls), ...extraTools],
    fileSearch,
  );
}

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
): { domain?: string; origin: 'urlContext'; url: string }[] {
  return urls.map((url) =>
    pickDefined({ domain: new URL(url).hostname, origin: 'urlContext' as const, url }),
  );
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

function buildDroppedSupportWarnings({
  droppedChunkCount,
  droppedSupportCount,
  droppedUrlCount,
}: {
  droppedChunkCount: number;
  droppedSupportCount: number;
  droppedUrlCount: number;
}): string[] {
  return [
    ...(droppedSupportCount > 0
      ? [`dropped ${String(droppedSupportCount)} non-public grounding supports`]
      : []),
    ...(droppedChunkCount > 0
      ? [`dropped ${String(droppedChunkCount)} non-public grounding chunks`]
      : []),
    ...(droppedUrlCount > 0
      ? [`dropped ${String(droppedUrlCount)} non-public URL metadata entries`]
      : []),
  ];
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

async function enrichTopicWithSampling(
  topic: string,
  searchDepth: number,
  ctx: ServerContext,
): Promise<string> {
  type RequestSampling = NonNullable<typeof ctx.mcpReq.requestSampling>;
  const requestSampling = ctx.mcpReq.requestSampling as RequestSampling | undefined;
  if (searchDepth < 3 || typeof requestSampling !== 'function') {
    log.debug('Sampling skipped for shallow research or unavailable requestSampling');
    return topic;
  }

  try {
    const samplingRes = await requestSampling({
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
    return `${topic}\n\n<planning_leads priority="low" evidence="false">\n${sampledText.slice(0, 200)}\n</planning_leads>\n<task>Research the topic above. Do not cite planning_leads as evidence.</task>`;
  } catch (error) {
    await ctx.mcpReq.log('debug', 'Sampling unavailable; continuing without extra angles');
    log.debug('requestSampling encountered an issue', {
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
  retrievalTurnsRan?: number,
): string[] {
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

  const warnings: string[] = [];

  if (searchDepth >= 3 && retrievalTurnsRan !== undefined && retrievalTurnsRan < searchDepth - 1) {
    const warning = `deep research ran ${String(retrievalTurnsRan)} retrieval turn(s), fewer than requested budget ${String(searchDepth - 1)}`;
    log.warn('deep research retrieval turn budget underused', { ...payload, retrievalTurnsRan });
    void ctx.mcpReq
      .log('warning', 'deep research retrieval turn budget underused')
      .catch(() => undefined);
    warnings.push(warning);
  }

  if (searchDepth >= 4 && !('codeExecution' in toolsUsedOccurrences)) {
    const warning = `deep research did not invoke Code Execution at depth ${String(searchDepth)}`;
    log.warn('deep research did not invoke Code Execution', payload);
    void ctx.mcpReq
      .log('warning', 'deep research did not invoke Code Execution')
      .catch(() => undefined);
    warnings.push(warning);
  }

  return warnings;
}

function computeResearchContext(streamResult: StreamResult) {
  const groundedSourcesResult = collectGroundedSourcesWithCounts(streamResult.groundingMetadata);
  const urlMetadataResult = collectUrlMetadataWithCounts(
    streamResult.urlContextMetadata?.urlMetadata,
  );
  const urlContextSources = collectUrlContextSources(urlMetadataResult.items);
  const groundedSourceDetailsResult = collectGroundedSourceDetailsWithCounts(
    streamResult.groundingMetadata,
    new Set(urlContextSources),
  );
  const sourceDetails = mergeSourceDetails(
    groundedSourceDetailsResult.items,
    buildUrlContextSourceDetails(urlContextSources),
  );
  const { citations, droppedSupportCount } = collectGroundingCitations(
    streamResult.groundingMetadata,
  );
  const searchEntryPoint = collectSearchEntryPoint(streamResult.groundingMetadata);
  const findings = deriveFindingsFromCitations(citations);
  const groundingSignals = computeGroundingSignals(
    streamResult,
    citations,
    urlMetadataResult.items,
    sourceDetails,
  );
  const status = deriveOverallStatus(groundingSignals);
  const warnings = buildDroppedSupportWarnings({
    droppedSupportCount,
    droppedChunkCount: groundedSourceDetailsResult.droppedNonPublic,
    droppedUrlCount: urlMetadataResult.droppedNonPublic,
  });
  const computations = deriveComputationsFromToolEvents(streamResult.toolEvents);

  return {
    groundedSources: groundedSourcesResult.items,
    urlMetadata: urlMetadataResult.items,
    urlContextSources,
    sourceDetails,
    citations,
    searchEntryPoint,
    findings,
    groundingSignals,
    status,
    warnings,
    computations,
  };
}

function buildAgenticSearchResult(
  streamResult: StreamResult,
  textContent: string,
  ctx: ServerContext,
  searchDepth: number,
  extraWarnings: readonly string[] = [],
  retrievalTurnsRan?: number,
) {
  const deepResearchWarnings = emitDeepResearchToolBudgetLogs(
    ctx,
    streamResult,
    searchDepth,
    retrievalTurnsRan,
  );

  const context = computeResearchContext(streamResult);
  const warnings = [...context.warnings, ...deepResearchWarnings, ...extraWarnings];
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(context.sourceDetails));
  appendUrlStatus(contentAdditions, context.urlMetadata);
  appendSearchEntryPointContent(contentAdditions, context.searchEntryPoint?.renderedContent);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      report: textContent,
      sources: context.sourceDetails.length > 0 ? undefined : context.groundedSources,
      sourceDetails: context.sourceDetails.length > 0 ? context.sourceDetails : undefined,
      urlContextSources:
        context.sourceDetails.length > 0
          ? undefined
          : context.urlContextSources.length > 0
            ? context.urlContextSources
            : undefined,
      urlMetadata: context.urlMetadata.length > 0 ? context.urlMetadata : undefined,
      toolsUsed: streamResult.toolsUsed.length > 0 ? streamResult.toolsUsed : undefined,
      status: context.status,
      groundingSignals: context.groundingSignals,
      findings: context.findings.length > 0 ? context.findings : undefined,
      citations: context.citations.length > 0 ? context.citations : undefined,
      computations: context.computations.length > 0 ? context.computations : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    reportMessage: buildSourceReportMessage(context.groundedSources.length),
  };
}

function buildSearchResult(streamResult: StreamResult, textContent: string) {
  const context = computeResearchContext(streamResult);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(context.sourceDetails));
  appendUrlStatus(contentAdditions, context.urlMetadata);
  appendSearchEntryPointContent(contentAdditions, context.searchEntryPoint?.renderedContent);
  if (context.status === 'ungrounded') {
    contentAdditions.unshift({
      type: 'text',
      text: '[status: ungrounded]',
    });
  }
  if (context.groundedSources.length === 0 && context.urlMetadata.length === 0) {
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
      sources: context.sourceDetails.length > 0 ? undefined : context.groundedSources,
      sourceDetails: context.sourceDetails.length > 0 ? context.sourceDetails : undefined,
      urlContextSources:
        context.sourceDetails.length > 0
          ? undefined
          : context.urlContextSources.length > 0
            ? context.urlContextSources
            : undefined,
      urlMetadata: context.urlMetadata.length > 0 ? context.urlMetadata : undefined,
      status: context.status,
      groundingSignals: context.groundingSignals,
      findings: context.findings.length > 0 ? context.findings : undefined,
      citations: context.citations.length > 0 ? context.citations : undefined,
      computations: context.computations.length > 0 ? context.computations : undefined,
      warnings: context.warnings.length > 0 ? context.warnings : undefined,
    }),
    reportMessage: buildSourceReportMessage(context.groundedSources.length),
  };
}

function summarizeRetrieval(text: string, maxChars = 1_500): string {
  const findingsIndex = text.indexOf('## Findings');
  const candidate = findingsIndex >= 0 ? text.slice(findingsIndex) : text;
  const trimmed = candidate.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function buildAnalyzeUrlResult(streamResult: StreamResult, textContent: string) {
  const context = computeResearchContext(streamResult);
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(context.sourceDetails));
  appendUrlStatus(contentAdditions, context.urlMetadata);
  appendSearchEntryPointContent(contentAdditions, context.searchEntryPoint?.renderedContent);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: pickDefined({
      summary: textContent,
      sources: context.groundedSources.length > 0 ? context.groundedSources : undefined,
      sourceDetails: context.sourceDetails.length > 0 ? context.sourceDetails : undefined,
      urlContextSources:
        context.urlContextSources.length > 0 ? context.urlContextSources : undefined,
      urlMetadata: context.urlMetadata.length > 0 ? context.urlMetadata : undefined,
      status: context.status,
      groundingSignals: context.groundingSignals,
      citations: context.citations.length > 0 ? context.citations : undefined,
      computations: context.computations.length > 0 ? context.computations : undefined,
      warnings: context.warnings.length > 0 ? context.warnings : undefined,
    }),
    reportMessage: `${formatCountLabel(context.urlMetadata.length, 'URL')} retrieved`,
  };
}

function parsePlannedSubQueries(
  text: string,
  fallbackTopic: string,
  searchDepth: number,
): string[] {
  const maxQueries = Math.min(searchDepth, 5);
  try {
    const parsed = JSON.parse(text) as unknown;
    const candidates = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && 'queries' in parsed
        ? (parsed as { queries?: unknown }).queries
        : undefined;
    if (Array.isArray(candidates)) {
      const queries = candidates
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, maxQueries);
      if (queries.length > 0) return queries;
    }
  } catch {
    // Fall through to deterministic fallback queries.
  }

  return [
    fallbackTopic,
    `${fallbackTopic} evidence and sources`,
    `${fallbackTopic} recent developments`,
    `${fallbackTopic} comparisons and tradeoffs`,
    `${fallbackTopic} open questions`,
  ].slice(0, maxQueries);
}

function dedupeGroundingSupports(
  groundingMetadata: GroundingMetadata | undefined,
): GroundingMetadata | undefined {
  if (!groundingMetadata?.groundingSupports || !groundingMetadata.groundingChunks) {
    return groundingMetadata;
  }

  const seen = new Set<string>();
  const groundingSupports = groundingMetadata.groundingSupports.filter((support) => {
    const text = support.segment?.text ?? '';
    const urls = (support.groundingChunkIndices ?? [])
      .map((index) => groundingMetadata.groundingChunks?.[index]?.web?.uri)
      .filter((url): url is string => typeof url === 'string')
      .sort();
    const key = `${text}\u0000${urls.join('\u0000')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ...groundingMetadata, groundingSupports };
}

function mergeGroundingMetadata(results: readonly StreamResult[]): GroundingMetadata | undefined {
  const groundingChunks: GroundingChunk[] = [];
  const groundingSupports: GroundingSupport[] = [];
  let searchEntryPoint: GroundingMetadata['searchEntryPoint'];

  for (const result of results) {
    const metadata = result.groundingMetadata;
    if (!metadata) continue;
    const offset = groundingChunks.length;
    groundingChunks.push(...(metadata.groundingChunks ?? []));
    for (const support of metadata.groundingSupports ?? []) {
      groundingSupports.push({
        ...support,
        groundingChunkIndices: (support.groundingChunkIndices ?? []).map((index) => index + offset),
      });
    }
    searchEntryPoint ??= metadata.searchEntryPoint;
  }

  if (groundingChunks.length === 0 && groundingSupports.length === 0 && !searchEntryPoint) {
    return undefined;
  }

  return dedupeGroundingSupports(
    pickDefined({
      groundingChunks,
      groundingSupports,
      searchEntryPoint,
    }),
  );
}

function mergeUrlContextMetadata(results: readonly StreamResult[]): UrlContextMetadata | undefined {
  const urlMetadata = results.flatMap((result) => result.urlContextMetadata?.urlMetadata ?? []);
  return urlMetadata.length > 0 ? { urlMetadata } : undefined;
}

function aggregateStreamResults(
  results: readonly StreamResult[],
  text: string,
  warnings: readonly string[],
): StreamResult {
  return pickDefined({
    text,
    textByWave: results.flatMap((result) => result.textByWave),
    thoughtText: results.map((result) => result.thoughtText).join('\n'),
    parts: results.flatMap((result) => result.parts),
    toolsUsed: [...new Set(results.flatMap((result) => result.toolsUsed))],
    toolsUsedOccurrences: results.flatMap((result) => result.toolsUsedOccurrences),
    functionCalls: results.flatMap((result) => result.functionCalls),
    toolEvents: results.flatMap((result) => result.toolEvents),
    hadCandidate: results.some((result) => result.hadCandidate),
    groundingMetadata: mergeGroundingMetadata(results),
    urlContextMetadata: mergeUrlContextMetadata(results),
    finishMessage: warnings.length > 0 ? warnings.join('\n') : undefined,
  });
}

async function runDeepResearchTurn(
  ctx: ServerContext,
  label: string,
  contents: string,
  config: Parameters<typeof buildGenerateContentConfig>[0],
): Promise<{ result: CallToolResult; streamResult: StreamResult }> {
  return executeToolStream(ctx, 'research', label, () =>
    getAI().models.generateContentStream({
      model: MODEL,
      contents,
      config: buildGenerateContentConfig(config, ctx.mcpReq.signal),
    }),
  );
}

async function runDeepResearchPlan(
  args: {
    deliverable?: string | undefined;
    topic: string;
    searchDepth: number;
    thinkingLevel?: ResearchInput['thinkingLevel'] | undefined;
    thinkingBudget?: number | undefined;
    urls?: readonly string[] | undefined;
    maxOutputTokens?: number | undefined;
    safetySettings?: ResearchInput['safetySettings'] | undefined;
    fileSearch?: ResearchInput['fileSearch'] | undefined;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const warnings: string[] = [];
  const results: StreamResult[] = [];
  const progress = new ProgressReporter(ctx, AGENTIC_SEARCH_TOOL_LABEL);
  await progress.send(0, undefined, 'Planning deep research');
  await ctx.mcpReq.log('info', 'Agentic search requested');
  log.info('Agentic search requested', {
    searchDepth: args.searchDepth,
    urlCount: args.urls?.length ?? 0,
  });

  const planTurn = await runDeepResearchTurn(
    ctx,
    'Research plan',
    `Return JSON only as {"queries":["..."]}. Produce ${String(Math.min(args.searchDepth, 5))} focused public web search queries for:\n${args.topic}`,
    {
      systemInstruction: 'Plan retrieval queries. Do not answer the research question.',
      costProfile: 'research.deep.plan',
      safetySettings: args.safetySettings,
    },
  );
  if (planTurn.result.isError) return planTurn.result;
  results.push(planTurn.streamResult);

  const subQueries = parsePlannedSubQueries(
    planTurn.streamResult.text,
    args.topic,
    args.searchDepth,
  );
  const maxRetrievalTurns = Math.min(
    subQueries.length,
    args.searchDepth,
    MAX_DEEP_RESEARCH_TURNS - (args.searchDepth >= 4 ? 3 : 2),
  );
  if (maxRetrievalTurns < subQueries.length) {
    warnings.push('deep research turn budget exceeded; returning partial retrieval coverage');
  }

  const resolvedRetrieval = await resolveOrchestration(
    {
      builtInToolSpecs: buildGroundedResearchBuiltInSpecs(args.urls, args.fileSearch),
      urls: args.urls,
    },
    ctx,
    'agentic_search',
  );
  if (resolvedRetrieval.error) return resolvedRetrieval.error;

  for (const [index, query] of subQueries.slice(0, maxRetrievalTurns).entries()) {
    if (ctx.mcpReq.signal.aborted) {
      warnings.push('deep research aborted; returning partial aggregated result');
      break;
    }
    await progress.send(
      Math.min(80, 10 + index * 15),
      undefined,
      `Retrieving source set ${String(index + 1)}`,
    );
    const prompt = buildGroundedAnswerPrompt(query, args.urls);
    const turn = await runDeepResearchTurn(
      ctx,
      `Research retrieval ${String(index + 1)}`,
      prompt.promptText,
      {
        systemInstruction: prompt.systemInstruction,
        costProfile: 'research.deep.retrieval',
        thinkingBudget: args.thinkingBudget,
        safetySettings: args.safetySettings,
        tools: resolvedRetrieval.config.tools,
        toolConfig: resolvedRetrieval.config.toolConfig,
      },
    );
    if (turn.result.isError) return turn.result;
    results.push(turn.streamResult);
  }

  const retrievalSummaries = results
    .slice(1)
    .map((result, index) => `## Retrieval ${String(index + 1)}\n${summarizeRetrieval(result.text)}`)
    .join('\n\n');
  const resolvedSynthesis = await resolveOrchestration(
    {
      builtInToolSpecs: buildResearchBuiltInSpecs(
        args.searchDepth >= 4 ? (['codeExecution'] as const) : undefined,
        args.fileSearch,
      ),
    },
    ctx,
    'agentic_search',
  );
  if (resolvedSynthesis.error) return resolvedSynthesis.error;
  const cacheName = await getWorkspaceCacheName(ctx);

  const synthesisPrompt = buildAgenticResearchPrompt({
    deliverable: args.deliverable,
    searchDepth: args.searchDepth,
    topic: `${args.topic}\n\nRetrieved evidence summaries:\n${retrievalSummaries}`,
    urls: args.urls,
  });
  const synthesisTurn = await runDeepResearchTurn(
    ctx,
    'Research synthesis',
    synthesisPrompt.promptText,
    {
      systemInstruction: synthesisPrompt.systemInstruction,
      costProfile: 'research.deep.synthesis',
      thinkingLevel: args.thinkingLevel,
      thinkingBudget: args.thinkingBudget,
      maxOutputTokens: args.maxOutputTokens,
      safetySettings: args.safetySettings,
      cacheName,
      tools: resolvedSynthesis.config.tools,
      toolConfig: resolvedSynthesis.config.toolConfig,
    },
  );
  if (synthesisTurn.result.isError) return synthesisTurn.result;
  results.push(synthesisTurn.streamResult);

  if (args.searchDepth >= 3 && results.length < MAX_DEEP_RESEARCH_TURNS) {
    const contradictionTurn = await runDeepResearchTurn(
      ctx,
      'Research contradiction check',
      `Review this synthesis for source disagreements. Return only claims that are partially supported or disputed.\n\n${summarizeRetrieval(synthesisTurn.streamResult.text)}`,
      {
        systemInstruction:
          'Flag contradictions conservatively. Do not add new source claims without retrieved evidence.',
        costProfile: 'research.deep.contradiction',
        thinkingLevel: 'LOW',
        maxOutputTokens: 1_024,
        safetySettings: args.safetySettings,
      },
    );
    if (contradictionTurn.result.isError) return contradictionTurn.result;
    results.push(contradictionTurn.streamResult);
  }

  const aggregate = aggregateStreamResults(results, synthesisTurn.streamResult.text, warnings);
  const built = buildAgenticSearchResult(
    aggregate,
    synthesisTurn.streamResult.text,
    ctx,
    args.searchDepth,
    warnings,
    maxRetrievalTurns,
  );
  const overlay = built.resultMod(synthesisTurn.result);
  return {
    ...synthesisTurn.result,
    ...overlay,
    structuredContent: built.structuredContent,
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
    fileSearch,
  }: SearchInput & GenerationConfigFields,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const resolved = await resolveOrchestration(
    {
      builtInToolSpecs: buildGroundedResearchBuiltInSpecs(urls, fileSearch),
      urls,
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
            costProfile: 'research.quick',
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
    fileSearch,
  }: AnalyzeUrlInput & GenerationConfigFields,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const resolved = await resolveOrchestration(
    {
      builtInToolSpecs: buildResearchBuiltInSpecs(['urlContext'] as const, fileSearch),
      urls,
    },
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
            costProfile: 'analyze.summary',
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
    fileSearch,
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

  const enrichedTopic = await enrichTopicWithSampling(topic, searchDepth, ctx);

  if (searchDepth >= 3) {
    return runDeepResearchPlan(
      {
        deliverable,
        topic: enrichedTopic,
        searchDepth,
        thinkingLevel,
        thinkingBudget,
        urls,
        maxOutputTokens,
        safetySettings,
        fileSearch,
      },
      ctx,
    );
  }

  const prompt = buildAgenticResearchPrompt({
    deliverable,
    searchDepth,
    topic: enrichedTopic,
    urls,
  });

  const resolved = await resolveOrchestration(
    {
      builtInToolSpecs: buildGroundedResearchBuiltInSpecs(urls, fileSearch, ['codeExecution']),
      urls,
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
            costProfile: 'research.quick',
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
      fileSearch: args.fileSearch,
    },
    ctx,
  );
}

async function runDeepResearch(args: ResearchInput, ctx: ServerContext): Promise<CallToolResult> {
  const searchDepth = args.searchDepth ?? 2;
  const hasExplicitThinkingLevel = Object.prototype.hasOwnProperty.call(args, 'thinkingLevel');
  const thinkingLevel = hasExplicitThinkingLevel ? args.thinkingLevel : undefined;

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
      fileSearch: args.fileSearch,
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
    ...(structured.status ? { status: structured.status } : {}),
    mode: args.mode,
    summary: extractResearchSummary(structured),
    ...(Array.isArray(structured.sources) ? { sources: structured.sources } : {}),
    ...(structured.sourceDetails ? { sourceDetails: structured.sourceDetails } : {}),
    ...(structured.urlContextSources ? { urlContextSources: structured.urlContextSources } : {}),
    ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
    ...(structured.toolsUsed ? { toolsUsed: structured.toolsUsed } : {}),
    ...(structured.groundingSignals ? { groundingSignals: structured.groundingSignals } : {}),
    ...(structured.findings ? { findings: structured.findings } : {}),
    ...(structured.citations ? { citations: structured.citations } : {}),
    ...(structured.computations ? { computations: structured.computations } : {}),
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
