import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import type { GroundingMetadata, Interactions, UrlContextMetadata } from '@google/genai';

import { AppError } from '../lib/errors.js';
import {
  builtInsToInteractionTools,
  createBackgroundInteraction,
  interactionToStreamResult,
  pollUntilComplete,
} from '../lib/interactions.js';
import { logger, mcpLog } from '../lib/logger.js';
import {
  buildAgenticResearchPrompt,
  buildFileAnalysisPrompt,
  buildGroundedAnswerPrompt,
  type Capabilities,
} from '../lib/model-prompts.js';
import { resolveOrchestration } from '../lib/orchestration.js';
import { PROGRESS_TOTAL, sendProgress } from '../lib/progress.js';
import {
  appendSources,
  appendUrlStatus,
  auditClaimedToolUsage,
  buildDroppedSupportWarnings,
  buildSharedStructuredMetadata,
  buildSourceReportMessage,
  buildStructuredResponse,
  buildSuccessfulStructuredContent,
  buildUrlContextSourceDetails,
  collectGroundedSourceDetailsWithCounts,
  collectGroundedSourcesWithCounts,
  collectGroundingCitations,
  collectUrlContextSources,
  collectUrlMetadataWithCounts,
  computeGroundingSignals,
  countOccurrences,
  deriveFindingsFromCitations,
  deriveOverallStatus,
  extractSampledText,
  formatCountLabel,
  formatSourceLabels,
  mergeSourceDetails,
  parseJson,
  pickDefined,
} from '../lib/response.js';
import {
  deriveComputationsFromToolEvents,
  executeToolStream,
  extractUsage,
  type StreamResult,
} from '../lib/streaming.js';
import {
  elicitTaskInput,
  getTaskEmitter,
  getWorkSignal,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerWorkTool,
} from '../lib/tasks.js';
import { createDefaultToolServices, type ToolServices } from '../lib/tool-context.js';
import { createToolContext, executor } from '../lib/tool-executor.js';
import { toAskThinkingLevel, type ToolsSpecInput } from '../lib/tool-profiles.js';
import { type AnalyzeInput, type ResearchInput, ResearchInputSchema } from '../schemas/inputs.js';
import { ResearchOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig, getAI } from '../client.js';
import { getGeminiModel } from '../config.js';
import { TOOL_LABELS } from '../public-contract.js';
import { appendResourceLinks } from '../resources/index.js';

const MAX_DEEP_RESEARCH_TURNS = 4;
const log = logger.child('research');

type QuickResearchInput = Extract<ResearchInput, { mode: 'quick' }>;
type DeepResearchInput = Extract<ResearchInput, { mode: 'deep' }>;
type AnalyzeUrlInput = Extract<AnalyzeInput, { targetKind: 'url' }>;

async function enrichTopicWithSampling(
  topic: string,
  searchDepth: number,
  ctx: ServerContext,
  services: ToolServices,
): Promise<string> {
  if (searchDepth < 3) {
    log.debug('Sampling skipped for shallow research');
    return topic;
  }

  if (!services.clientCapabilities()?.sampling) {
    log.debug('Sampling skipped: client does not advertise sampling capability');
    return topic;
  }

  try {
    const samplingRes = await ctx.mcpReq.requestSampling(
      {
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
      },
      { signal: ctx.mcpReq.signal },
    );

    const sampledText = extractSampledText(samplingRes.content);
    if (!sampledText) {
      return topic;
    }

    await mcpLog(ctx, 'info', 'Sampling provided research angles');
    log.debug('Sampling provided research angles', { sampledTextLength: sampledText.length });
    return `${topic}\n\n<planning_leads priority="low" evidence="false">\n${sampledText.slice(0, 200)}\n</planning_leads>\n<task>Research the topic above. Do not cite planning_leads as evidence.</task>`;
  } catch (error) {
    await mcpLog(ctx, 'debug', 'Sampling unavailable; continuing without extra angles');
    log.debug('requestSampling encountered an issue', {
      error: AppError.formatMessage(error),
    });
    return topic;
  }
}

function emitDeepResearchToolBudgetLogs(
  ctx: ServerContext,
  streamResult: StreamResult,
  searchDepth: number,
  resolvedRetrievalBudget: number,
  retrievalTurnsRan?: number,
): string[] {
  const toolsUsedOccurrences = countOccurrences(streamResult.toolsUsedOccurrences);
  const payload = {
    resolvedRetrievalBudget,
    searchDepth,
    toolsUsed: streamResult.toolsUsed,
    toolsUsedOccurrences,
  };

  log.info('deep research tool budget observed', payload);
  void mcpLog(ctx, 'info', `deep research tool budget observed at depth ${String(searchDepth)}`);

  const warnings: string[] = [];

  if (
    searchDepth >= 3 &&
    retrievalTurnsRan !== undefined &&
    retrievalTurnsRan < resolvedRetrievalBudget
  ) {
    const warning = `deep research ran ${String(retrievalTurnsRan)} retrieval turn(s), fewer than resolved budget ${String(resolvedRetrievalBudget)}`;
    log.warn('deep research retrieval turn budget underused', { ...payload, retrievalTurnsRan });
    void mcpLog(ctx, 'warning', 'deep research retrieval turn budget underused');
    warnings.push(warning);
  }

  if (searchDepth >= 4 && !('codeExecution' in toolsUsedOccurrences)) {
    const warning = `deep research did not invoke Code Execution at depth ${String(searchDepth)}`;
    log.warn('deep research did not invoke Code Execution', payload);
    void mcpLog(ctx, 'warning', 'deep research did not invoke Code Execution');
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
    findings,
    groundingSignals,
    status,
    warnings,
    computations,
  };
}

function buildPromptCapabilities(
  activeCapabilities: ReadonlySet<string>,
  multiTurnRetrieval = false,
): Capabilities {
  return {
    googleSearch: activeCapabilities.has('googleSearch'),
    urlContext: activeCapabilities.has('urlContext'),
    codeExecution: activeCapabilities.has('codeExecution'),
    fileSearch: activeCapabilities.has('fileSearch'),
    ...(multiTurnRetrieval ? { multiTurnRetrieval: true } : {}),
  };
}

function buildAgenticSearchResult(
  streamResult: StreamResult,
  textContent: string,
  ctx: ServerContext,
  searchDepth: number,
  resolvedRetrievalBudget: number,
  extraWarnings: readonly string[] = [],
  retrievalTurnsRan?: number,
) {
  const deepResearchWarnings = emitDeepResearchToolBudgetLogs(
    ctx,
    streamResult,
    searchDepth,
    resolvedRetrievalBudget,
    retrievalTurnsRan,
  );

  const context = computeResearchContext(streamResult);
  const warnings = [
    ...context.warnings,
    ...auditClaimedToolUsage(textContent, streamResult.toolsUsed),
    ...deepResearchWarnings,
    ...extraWarnings,
  ];
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(context.sourceDetails));
  appendUrlStatus(contentAdditions, context.urlMetadata);

  return {
    resultMod: (result: CallToolResult) => ({
      content: [...result.content, ...contentAdditions],
    }),
    structuredContent: buildStructuredResponse(
      pickDefined({
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
      {
        functionCalls: streamResult.functionCalls,
        toolEvents: streamResult.toolEvents,
        usage: streamResult.usageMetadata ? extractUsage(streamResult.usageMetadata) : undefined,
        safetyRatings: streamResult.safetyRatings,
        finishMessage: streamResult.finishMessage,
        citationMetadata: streamResult.citationMetadata,
        groundingMetadata: streamResult.groundingMetadata,
        urlContextMetadata: streamResult.urlContextMetadata,
      },
    ),
    reportMessage: buildSourceReportMessage(context.groundedSources.length),
  };
}

function buildSearchResult(streamResult: StreamResult, textContent: string) {
  const context = computeResearchContext(streamResult);
  const warnings = [
    ...context.warnings,
    ...auditClaimedToolUsage(textContent, streamResult.toolsUsed),
  ];
  const contentAdditions: CallToolResult['content'] = [];

  appendSources(contentAdditions, formatSourceLabels(context.sourceDetails));
  appendUrlStatus(contentAdditions, context.urlMetadata);
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
    structuredContent: buildStructuredResponse(
      pickDefined({
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
        warnings: warnings.length > 0 ? warnings : undefined,
      }),
    ),
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
): { queries: string[]; warnings: string[] } {
  const maxQueries = Math.min(searchDepth, 5);
  const parsed = parseJson(text);
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
    if (queries.length > 0) {
      return { queries, warnings: [] };
    }
  }

  return {
    queries: [
      fallbackTopic,
      `${fallbackTopic} evidence and sources`,
      `${fallbackTopic} recent developments`,
      `${fallbackTopic} comparisons and tradeoffs`,
      `${fallbackTopic} open questions`,
    ].slice(0, maxQueries),
    warnings: ['research: planner JSON unparseable; using fallback queries'],
  };
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

function mergeStreamMetadata<K extends keyof StreamResult>(
  results: readonly StreamResult[],
  key: K,
  combine: (values: readonly NonNullable<StreamResult[K]>[]) => StreamResult[K] | undefined,
): StreamResult[K] | undefined {
  const values: NonNullable<StreamResult[K]>[] = [];
  for (const result of results) {
    const value = result[key];
    if (value !== undefined && value !== null) {
      values.push(value);
    }
  }
  return combine(values);
}

function combineCitationMetadata(
  results: readonly StreamResult[],
): StreamResult['citationMetadata'] {
  const citationSources: unknown[] = results.flatMap((result) => {
    const metadata = result.citationMetadata;
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      !('citationSources' in metadata) ||
      !Array.isArray((metadata as { citationSources?: unknown }).citationSources)
    ) {
      return [];
    }

    return (metadata as { citationSources: unknown[] }).citationSources;
  });

  return citationSources.length > 0 ? { citationSources } : undefined;
}

function sumUsageMetadata(results: readonly StreamResult[]): StreamResult['usageMetadata'] {
  const usages = results
    .map((r) => r.usageMetadata)
    .filter((u): u is NonNullable<typeof u> => u !== undefined);
  if (usages.length === 0) return undefined;

  const sum = (
    key:
      | 'promptTokenCount'
      | 'candidatesTokenCount'
      | 'totalTokenCount'
      | 'cachedContentTokenCount'
      | 'thoughtsTokenCount'
      | 'toolUsePromptTokenCount',
  ) => usages.reduce((acc, u) => acc + (u[key] ?? 0), 0);

  return pickDefined({
    promptTokenCount: sum('promptTokenCount'),
    candidatesTokenCount: sum('candidatesTokenCount'),
    totalTokenCount: sum('totalTokenCount'),
    cachedContentTokenCount: sum('cachedContentTokenCount'),
    thoughtsTokenCount: sum('thoughtsTokenCount'),
    toolUsePromptTokenCount: sum('toolUsePromptTokenCount'),
    promptTokensDetails: usages.findLast((u) => u.promptTokensDetails)?.promptTokensDetails,
    cacheTokensDetails: usages.findLast((u) => u.cacheTokensDetails)?.cacheTokensDetails,
    candidatesTokensDetails: usages.findLast((u) => u.candidatesTokensDetails)
      ?.candidatesTokensDetails,
  });
}

function combineUrlContextMetadata(
  metadatas: readonly UrlContextMetadata[],
): UrlContextMetadata | undefined {
  const urlMetadata = metadatas.flatMap((metadata) => metadata.urlMetadata ?? []);
  return urlMetadata.length > 0 ? { urlMetadata } : undefined;
}

function aggregateStreamResults(
  results: readonly StreamResult[],
  text: string,
  synthesisResult: StreamResult,
  warnings: readonly string[],
): { streamResult: StreamResult; warnings: string[] } {
  return {
    streamResult: pickDefined({
      text,
      textByWave: results.flatMap((result) => result.textByWave),
      thoughtText: results.map((result) => result.thoughtText).join('\n'),
      parts: results.flatMap((result) => result.parts),
      toolsUsed: [...new Set(results.flatMap((result) => result.toolsUsed))],
      toolsUsedOccurrences: results.flatMap((result) => result.toolsUsedOccurrences),
      functionCalls: results.flatMap((result) => result.functionCalls),
      toolEvents: results.flatMap((result) => result.toolEvents),
      hadCandidate: results.some((result) => result.hadCandidate),
      finishReason: synthesisResult.finishReason,
      finishMessage: synthesisResult.finishMessage,
      promptFeedback: synthesisResult.promptFeedback,
      promptBlockReason: synthesisResult.promptBlockReason,
      groundingMetadata: synthesisResult.groundingMetadata
        ? dedupeGroundingSupports(synthesisResult.groundingMetadata)
        : undefined,
      urlContextMetadata: mergeStreamMetadata(
        results,
        'urlContextMetadata',
        combineUrlContextMetadata,
      ),
      usageMetadata: sumUsageMetadata(results),
      safetyRatings: results.reduce<unknown[]>((ratings, result) => {
        if (Array.isArray(result.safetyRatings)) {
          for (const rating of result.safetyRatings) {
            ratings.push(rating);
          }
        }
        return ratings;
      }, []),
      citationMetadata: combineCitationMetadata(results),
      warnings: warnings.length > 0 ? [...warnings] : undefined,
    }),
    warnings: [...warnings],
  };
}

async function runDeepResearchTurn(
  ctx: ServerContext,
  label: string,
  contents: string,
  config: Parameters<typeof buildGenerateContentConfig>[0],
): Promise<{ result: CallToolResult; streamResult: StreamResult }> {
  const signal = getWorkSignal(ctx);
  return executeToolStream(
    ctx,
    'research',
    label,
    () =>
      getAI().models.generateContentStream({
        model: getGeminiModel(),
        contents,
        config: buildGenerateContentConfig(config, signal),
      }),
    signal,
  );
}

async function runDeepResearchPlan(
  args: {
    deliverable?: string | undefined;
    topic: string;
    searchDepth: number;
    thinkingLevel?: ResearchInput['thinkingLevel'] | undefined;
    tools?: ToolsSpecInput | undefined;
    maxOutputTokens?: number | undefined;
    safetySettings?: ResearchInput['safetySettings'] | undefined;
  },
  ctx: ServerContext,
  services: ToolServices,
): Promise<CallToolResult> {
  const tasks = getTaskEmitter(ctx);
  const warnings: string[] = [];
  const results: StreamResult[] = [];
  const { progress } = createToolContext('agenticSearch', ctx);
  await progress.send(0, undefined, 'Planning deep research');
  await mcpLog(ctx, 'info', 'Agentic search requested');
  log.info('Agentic search requested', {
    searchDepth: args.searchDepth,
  });

  await tasks.phase('planning');
  const planTurn = await runDeepResearchTurn(
    ctx,
    'Research plan',
    `Return JSON: {"queries":["..."]}. Produce ${String(Math.min(args.searchDepth, 5))} focused web search queries for:\n${args.topic}`,
    {
      systemInstruction: 'Plan retrieval queries. Do not answer the research question.',
      costProfile: 'research.deep.plan',
      safetySettings: args.safetySettings,
    },
  );
  if (planTurn.result.isError) return planTurn.result;
  results.push(planTurn.streamResult);

  const plannedQueries = parsePlannedSubQueries(
    planTurn.streamResult.text,
    args.topic,
    args.searchDepth,
  );
  warnings.push(...plannedQueries.warnings);
  const subQueries = plannedQueries.queries;
  const requestedRetrievalBudget = Math.max(1, Math.min(args.searchDepth, subQueries.length));
  const maxRetrievalTurns = Math.min(subQueries.length, args.searchDepth, MAX_DEEP_RESEARCH_TURNS);
  if (maxRetrievalTurns < requestedRetrievalBudget) {
    warnings.push(
      `deep research resolved retrieval budget to ${String(maxRetrievalTurns)} turn(s) from requested ${String(requestedRetrievalBudget)}`,
    );
  }
  if (maxRetrievalTurns < subQueries.length) {
    warnings.push('deep research turn budget exceeded; returning partial retrieval coverage');
  }

  // Retrieval turns use googleSearch + urlContext only; codeExecution is reserved for synthesis.
  // Map deep-research → web-research for retrieval to avoid codeExecution during retrieval turns.
  const retrievalSpec: ToolsSpecInput | undefined =
    args.tools?.profile === 'deep-research'
      ? { profile: 'web-research', overrides: { urls: args.tools.overrides?.urls } }
      : args.tools;
  const resolvedRetrieval = await resolveOrchestration(retrievalSpec, ctx, {
    toolKey: 'research',
    mode: 'deep',
  });
  if (resolvedRetrieval.error) return resolvedRetrieval.error;

  for (const [index, query] of subQueries.slice(0, maxRetrievalTurns).entries()) {
    if (getWorkSignal(ctx).aborted) {
      warnings.push('deep research aborted; returning partial aggregated result');
      break;
    }
    await progress.send(
      Math.min(80, 10 + index * 15),
      undefined,
      `Retrieving source set ${String(index + 1)}`,
    );
    const retrievalUrls = resolvedRetrieval.config.resolvedProfile?.overrides.urls;
    const prompt = buildGroundedAnswerPrompt(
      query,
      retrievalUrls,
      undefined,
      buildPromptCapabilities(resolvedRetrieval.config.activeCapabilities, false),
    );
    await tasks.phase('retrieving');
    const turn = await runDeepResearchTurn(
      ctx,
      `Research retrieval ${String(index + 1)}`,
      prompt.promptText,
      {
        systemInstruction: prompt.systemInstruction,
        costProfile: 'research.deep.retrieval',
        safetySettings: args.safetySettings,
        tools: resolvedRetrieval.config.tools,
        toolConfig: resolvedRetrieval.config.toolConfig,
      },
    );
    if (turn.result.isError) return turn.result;
    results.push(turn.streamResult);

    const retrievalSources = collectGroundedSourcesWithCounts(turn.streamResult.groundingMetadata);
    for (const uri of retrievalSources.items) {
      await tasks.finding({ kind: 'source', data: { uri } });
    }
    for (const ev of turn.streamResult.toolEvents) {
      if (ev.kind === 'tool_call' || ev.kind === 'function_call') {
        await tasks.finding({ kind: 'tool-call', data: { name: ev.name, args: ev.args } });
      }
    }
  }

  const retrievalSummaries = results
    .slice(1)
    .map((result, index) => `## Retrieval ${String(index + 1)}\n${summarizeRetrieval(result.text)}`)
    .join('\n\n');
  const synthesisToolsSpec: ToolsSpecInput | undefined =
    args.searchDepth >= 4 ? { profile: 'code-math' } : undefined;
  const resolvedSynthesis = await resolveOrchestration(synthesisToolsSpec, ctx, {
    toolKey: 'research',
    mode: 'deep',
  });
  if (resolvedSynthesis.error) return resolvedSynthesis.error;
  const cacheName = await services.workspace.resolveCacheName(ctx);
  const synthesisCanRetrieve =
    resolvedSynthesis.config.activeCapabilities.has('googleSearch') ||
    resolvedSynthesis.config.activeCapabilities.has('urlContext') ||
    resolvedSynthesis.config.activeCapabilities.has('fileSearch');

  const synthesisPrompt = buildAgenticResearchPrompt({
    capabilities: buildPromptCapabilities(
      resolvedSynthesis.config.activeCapabilities,
      synthesisCanRetrieve,
    ),
    deliverable: args.deliverable,
    topic: `${args.topic}\n\nRetrieved evidence summaries:\n${retrievalSummaries}`,
    urls: resolvedRetrieval.config.resolvedProfile?.overrides.urls,
  });
  await tasks.phase('synthesizing');
  const synthesisTurn = await runDeepResearchTurn(
    ctx,
    'Research synthesis',
    synthesisPrompt.promptText,
    {
      systemInstruction: synthesisPrompt.systemInstruction,
      costProfile: 'research.deep.synthesis',
      thinkingLevel: args.thinkingLevel,
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

  const aggregate = aggregateStreamResults(
    results,
    synthesisTurn.streamResult.text,
    synthesisTurn.streamResult,
    warnings,
  );
  const built = buildAgenticSearchResult(
    aggregate.streamResult,
    synthesisTurn.streamResult.text,
    ctx,
    args.searchDepth,
    maxRetrievalTurns,
    aggregate.warnings,
    maxRetrievalTurns,
  );
  const overlay = built.resultMod(synthesisTurn.result);
  const sharedMetadata = buildSharedStructuredMetadata({});

  const structuredContent = built.structuredContent;

  await tasks.phase('finalizing');
  return {
    ...synthesisTurn.result,
    ...overlay,
    structuredContent:
      typeof structuredContent === 'object'
        ? {
            ...structuredContent,
            ...sharedMetadata,
          }
        : structuredContent,
  };
}

async function searchWork(
  {
    goal,
    systemInstruction,
    tools: toolsSpec,
    thinkingLevel,
    maxOutputTokens,
    safetySettings,
  }: QuickResearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const tasks = getTaskEmitter(ctx);
  const { progress } = createToolContext('search', ctx);
  await progress.send(0, undefined, 'Starting');
  await mcpLog(ctx, 'info', 'Search requested');

  const resolved = await resolveOrchestration(toolsSpec, ctx, {
    toolKey: 'research',
    mode: 'quick',
  });
  if (resolved.error) return resolved.error;

  const { tools, toolConfig } = resolved.config;
  const resolvedUrls = resolved.config.resolvedProfile?.overrides.urls;
  const prompt = buildGroundedAnswerPrompt(
    goal,
    resolvedUrls,
    undefined,
    buildPromptCapabilities(resolved.config.activeCapabilities, false),
  );

  await tasks.phase('retrieving');
  const result = await executor.runWithProgress(ctx, {
    toolKey: 'research',
    label: TOOL_LABELS.search,
    initialMsg: 'Starting',
    generator: () =>
      getAI().models.generateContentStream({
        model: getGeminiModel(),
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: systemInstruction ?? prompt.systemInstruction,
            costProfile: 'research.quick',
            thinkingLevel,
            maxOutputTokens,
            safetySettings,
            tools,
            toolConfig,
          },
          getWorkSignal(ctx),
        ),
      }),
    responseBuilder: (streamResult, textContent) => buildSearchResult(streamResult, textContent),
  });
  await tasks.phase('finalizing');
  return result;
}

export async function analyzeUrlWork(
  { urls, goal, thinkingLevel, maxOutputTokens, safetySettings }: AnalyzeUrlInput,
  ctx: ServerContext,
  services?: ToolServices,
): Promise<CallToolResult> {
  const prompt = buildFileAnalysisPrompt({
    goal,
    kind: 'url',
    urls,
  });

  const { progress } = createToolContext('analyzeUrl', ctx);
  await progress.send(0, undefined, 'Fetching');
  await mcpLog(ctx, 'info', `Analyze URL requested for ${urls.length} urls`);

  return await executor.executeGeminiPipeline(ctx, {
    toolName: 'analyze_url',
    label: TOOL_LABELS.analyzeUrl,
    cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,
    commonInputs: { urls },
    buildContents: () => ({
      contents: [prompt.promptText],
      systemInstruction: prompt.systemInstruction,
    }),
    config: {
      costProfile: 'analyze.summary',
      thinkingLevel,
      maxOutputTokens,
      safetySettings,
    },
    responseBuilder: buildAnalyzeUrlResult,
  });
}

async function promptForConstraints(
  ctx: ServerContext,
  topic: string,
  searchDepth: number,
  deliverable?: string,
): Promise<string> {
  if (searchDepth >= 5 || (searchDepth >= 4 && !deliverable)) {
    try {
      const constraint = await elicitTaskInput(
        ctx,
        `High depth research requested (${searchDepth}). What specific aspect should the agent focus on? (Or reply 'none' to proceed)`,
        'Waiting for constraints for deep research',
      );
      if (constraint && constraint.trim().toLowerCase() !== 'none') {
        return `${topic}\n\nAdditional User Constraint: ${constraint}`;
      }
    } catch (err) {
      await mcpLog(ctx, 'warning', 'Elicitation skipped; continuing without extra constraints');
      log.warn('Elicitation skipped or failed', { error: AppError.formatMessage(err) });
    }
  }
  return topic;
}

async function agenticSearchWork(
  {
    deliverable,
    goal,
    searchDepth = 2,
    thinkingLevel,
    tools: toolsSpec,
    maxOutputTokens,
    safetySettings,
  }: DeepResearchInput,
  ctx: ServerContext,
  services: ToolServices,
): Promise<CallToolResult> {
  const tasks = getTaskEmitter(ctx);
  const topic = await promptForConstraints(ctx, goal, searchDepth, deliverable);

  await tasks.phase('enriching-topic');
  const enrichedTopic = await enrichTopicWithSampling(topic, searchDepth, ctx, services);

  if (searchDepth >= 3) {
    return runDeepResearchPlan(
      {
        deliverable,
        topic: enrichedTopic,
        searchDepth,
        thinkingLevel,
        tools: toolsSpec,
        maxOutputTokens,
        safetySettings,
      },
      ctx,
      services,
    );
  }

  const resolved = await resolveOrchestration(toolsSpec, ctx, {
    toolKey: 'research',
    mode: 'deep',
  });
  if (resolved.error) return resolved.error;
  const resolvedUrls = resolved.config.resolvedProfile?.overrides.urls;
  await tasks.phase('planning');
  const prompt = buildAgenticResearchPrompt({
    capabilities: buildPromptCapabilities(resolved.config.activeCapabilities, false),
    deliverable,
    topic: enrichedTopic,
    urls: resolvedUrls,
  });

  await tasks.phase('retrieving');
  await mcpLog(ctx, 'info', 'Agentic search requested');
  log.info('Agentic search requested', { searchDepth });

  const interactionTools = builtInsToInteractionTools(
    resolved.config.resolvedProfile?.builtIns ?? [],
  );
  const interactionThinkingLevel = (
    thinkingLevel ?? toAskThinkingLevel(resolved.config.resolvedProfile?.thinkingLevel ?? 'low')
  ).toLowerCase() as Interactions.ThinkingLevel;

  const backgroundInteraction = await createBackgroundInteraction({
    model: getGeminiModel(),
    input: prompt.promptText,
    tools: interactionTools,
    thinkingLevel: interactionThinkingLevel,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(prompt.systemInstruction ? { systemInstruction: prompt.systemInstruction } : {}),
  });

  let pollCount = 0;
  const polledInteraction = await pollUntilComplete(
    backgroundInteraction.id,
    getWorkSignal(ctx),
    async () => {
      pollCount += 1;
      await sendProgress(
        ctx,
        Math.min(10 + pollCount * 8, 85),
        PROGRESS_TOTAL,
        `${TOOL_LABELS.agenticSearch}: Research in progress...`,
      );
    },
  );

  if (polledInteraction.status !== 'completed') {
    return new AppError(
      'research',
      `Background research ended with unexpected status: ${polledInteraction.status}`,
      'internal',
      true,
    ).toToolResult();
  }

  await tasks.phase('finalizing');
  const streamResult = interactionToStreamResult(polledInteraction);
  const textContent = streamResult.text;
  const built = buildAgenticSearchResult(streamResult, textContent, ctx, searchDepth, searchDepth);
  const baseResult: CallToolResult = {
    content: [{ type: 'text', text: textContent }],
  };
  const overlay = built.resultMod(baseResult);
  const sharedMetadata = buildSharedStructuredMetadata({});

  return {
    ...baseResult,
    ...overlay,
    structuredContent:
      typeof built.structuredContent === 'object'
        ? {
            ...built.structuredContent,
            ...sharedMetadata,
          }
        : built.structuredContent,
  };
}

async function runQuickResearch(
  args: ResearchInput & {
    mode: 'quick';
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  return await searchWork(args, ctx);
}

async function runDeepResearch(
  args: Extract<ResearchInput, { mode: 'deep' }>,
  ctx: ServerContext,
  services: ToolServices,
): Promise<CallToolResult> {
  const searchDepth = args.searchDepth ?? 2;
  const hasExplicitThinkingLevel = Object.hasOwn(args, 'thinkingLevel');
  const thinkingLevel = hasExplicitThinkingLevel ? args.thinkingLevel : undefined;

  return await agenticSearchWork(
    {
      ...args,
      searchDepth,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    ctx,
    services,
  );
}

function isQuickResearchInput(args: ResearchInput): args is ResearchInput & {
  mode: 'quick';
} {
  return args.mode === 'quick';
}

function isDeepResearchInput(
  args: ResearchInput,
): args is Extract<ResearchInput, { mode: 'deep' }> {
  return args.mode === 'deep';
}

const SUMMARY_MAX_CHARS = 600;

function extractResearchSummary(structured: Record<string, unknown>): string {
  const full =
    typeof structured.answer === 'string'
      ? structured.answer
      : typeof structured.report === 'string'
        ? structured.report
        : '';

  const firstParagraph =
    full
      .split('\n\n')
      .find((p) => p.trim().length > 0)
      ?.trim() ?? '';
  if (firstParagraph.length > 0 && firstParagraph.length <= SUMMARY_MAX_CHARS) {
    return firstParagraph;
  }
  return full.length <= SUMMARY_MAX_CHARS ? full : `${full.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`;
}

function buildResearchStructuredContent(
  _args: ResearchInput,
  _ctx: ServerContext,
  structured: Record<string, unknown>,
): Record<string, unknown> {
  const domain = {
    status: structured.status,
    summary: extractResearchSummary(structured),
    sourceDetails: structured.sourceDetails,
    findings: structured.findings,
  };

  return buildSuccessfulStructuredContent({
    warnings: Array.isArray(structured.warnings)
      ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
      : undefined,
    domain,
    shared: structured,
  });
}

async function researchWork(
  args: ResearchInput,
  ctx: ServerContext,
  services: ToolServices,
): Promise<CallToolResult> {
  const result = isQuickResearchInput(args)
    ? await runQuickResearch(args, ctx)
    : isDeepResearchInput(args)
      ? await runDeepResearch(args, ctx, services)
      : await runQuickResearch(args, ctx);

  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent ?? {};
  const output = createToolContext('research', ctx).validateOutput(
    ResearchOutputSchema,
    buildResearchStructuredContent(args, ctx, structured),
    result,
  );
  const resourceLinks = appendResourceLinks('research');
  return {
    ...output,
    resourceLink: resourceLinks,
  };
}

export function registerResearchTool(server: McpServer, services?: ToolServices): void {
  const resolvedServices = services ?? createDefaultToolServices();
  registerWorkTool<ResearchInput>({
    server,
    tool: {
      name: 'research',
      title: 'Research',
      description: 'Quick grounded lookup or deeper multi-step research with an explicit mode.',
      inputSchema: ResearchInputSchema,
      outputSchema: ResearchOutputSchema,
      annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    },
    overrides: { defaultTtlMs: 900_000 },
    work: (args, ctx) => researchWork(args, ctx, resolvedServices),
  });
}
