import {
  type CallToolResult,
  RELATED_TASK_META_KEY as SDK_RELATED_TASK_META_KEY,
} from '@modelcontextprotocol/server';

import {
  type GenerateContentResponse,
  type GroundingMetadata,
  type UrlMetadata,
  UrlRetrievalStatus,
} from '@google/genai';
import { z } from 'zod/v4';

import type {
  Finding,
  GroundingCitation,
  GroundingSignals,
  SearchEntryPoint,
  SourceDetail,
  UrlMetadataEntry,
  UsageMetadata,
} from '../schemas/outputs.js';

import { finishReasonToError, SafetyError } from './errors.js';
import { parseJson } from './json.js';
import { logger } from './logger.js';
import type { ToolEvent } from './streaming.js';
import { isPublicHttpUrl } from './validation.js';

type PickDefined<T> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

export function pickDefined<T extends Record<string, unknown>>(obj: T): PickDefined<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as PickDefined<T>;
}

function stripEmpty(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmpty);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      result[k] = stripEmpty(v);
    }
    return result;
  }
  return obj;
}

export function readStructuredObject(
  result: Pick<CallToolResult, 'isError' | 'structuredContent'>,
): Record<string, unknown> | undefined {
  if (result.isError || !result.structuredContent || typeof result.structuredContent !== 'object') {
    return undefined;
  }

  return result.structuredContent;
}

export function mergeStructured(
  result: CallToolResult,
  patch: Record<string, unknown> | undefined,
  options?: { warnings?: readonly string[] },
): CallToolResult {
  if (result.isError) {
    return result;
  }

  const baseStructured = readStructuredObject(result);
  const incomingWarnings = options?.warnings ?? [];
  const existingWarnings = Array.isArray(baseStructured?.warnings)
    ? baseStructured.warnings.filter((value): value is string => typeof value === 'string')
    : [];

  if (!baseStructured && !patch && incomingWarnings.length === 0) {
    return result;
  }

  const baseWithoutWarnings = Object.fromEntries(
    Object.entries(baseStructured ?? {}).filter(([key]) => key !== 'warnings'),
  );
  const patchWithoutWarnings = Object.fromEntries(
    Object.entries(patch ?? {}).filter(([key]) => key !== 'warnings'),
  );
  const warnings = [...existingWarnings, ...incomingWarnings];

  return {
    ...result,
    structuredContent: {
      ...baseWithoutWarnings,
      ...patchWithoutWarnings,
      ...(warnings.length > 0
        ? { warnings }
        : existingWarnings.length > 0
          ? { warnings: existingWarnings }
          : {}),
    },
  };
}

interface CollectedItems<T> {
  items: T[];
  droppedNonPublic: number;
}

const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;

export function tryParseJsonResponse(text: string): unknown {
  const candidates = [text.trim()];
  const fencedMatch = Array.from(text.matchAll(new RegExp(JSON_CODE_BLOCK_PATTERN.source, 'gi')))
    .at(-1)?.[1]
    ?.trim();
  if (fencedMatch && fencedMatch !== candidates[0]) {
    candidates.push(fencedMatch);
  }

  return parseJson(text, { candidates });
}

// ── URL Metadata ──────────────────────────────────────────────────────

function domainFromPublicUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function collectUniquePublicEntries<S, T>(
  source: Iterable<S> | undefined,
  getUrl: (item: S) => string | undefined,
  transform: (item: S, url: string) => T,
): CollectedItems<T> {
  if (!source) return { items: [], droppedNonPublic: 0 };
  const items: T[] = [];
  const seen = new Set<string>();
  let droppedNonPublic = 0;
  for (const item of source) {
    const url = getUrl(item);
    if (!url || seen.has(url)) continue;
    if (!isPublicHttpUrl(url)) {
      droppedNonPublic += 1;
      continue;
    }
    seen.add(url);
    items.push(transform(item, url));
  }
  return { items, droppedNonPublic };
}

export function collectUrlMetadataWithCounts(
  urlMetadata: UrlMetadata[] | undefined,
): CollectedItems<UrlMetadataEntry> {
  const knownStatuses = new Set<string>(Object.values(UrlRetrievalStatus));
  return collectUniquePublicEntries(
    urlMetadata,
    (meta) => meta.retrievedUrl,
    (meta, url) => {
      const raw = meta.urlRetrievalStatus;
      const status =
        typeof raw === 'string' && knownStatuses.has(raw)
          ? raw
          : UrlRetrievalStatus.URL_RETRIEVAL_STATUS_UNSPECIFIED;
      return { url, status };
    },
  );
}

export function collectUrlMetadata(urlMetadata: UrlMetadata[] | undefined): UrlMetadataEntry[] {
  return collectUrlMetadataWithCounts(urlMetadata).items;
}

// ── Grounding Sources ─────────────────────────────────────────────────

export function collectGroundedSourcesWithCounts(
  groundingMetadata: GroundingMetadata | undefined,
): CollectedItems<string> {
  const collected = collectGroundedSourceDetailsWithCounts(groundingMetadata);
  return {
    items: collected.items.map((source) => source.url),
    droppedNonPublic: collected.droppedNonPublic,
  };
}

export function collectGroundedSources(groundingMetadata: GroundingMetadata | undefined): string[] {
  return collectGroundedSourcesWithCounts(groundingMetadata).items;
}

export function collectGroundedSourceDetailsWithCounts(
  groundingMetadata: GroundingMetadata | undefined,
  urlContextUrls = new Set<string>(),
): CollectedItems<SourceDetail> {
  return collectUniquePublicEntries(
    groundingMetadata?.groundingChunks,
    (chunk) => chunk.web?.uri,
    (chunk, url) => {
      const title = chunk.web?.title;
      const origin = urlContextUrls.has(url) ? ('both' as const) : ('googleSearch' as const);
      return pickDefined({ domain: domainFromPublicUrl(url), origin, title, url });
    },
  );
}

export function collectGroundedSourceDetails(
  groundingMetadata: GroundingMetadata | undefined,
  urlContextUrls = new Set<string>(),
): SourceDetail[] {
  return collectGroundedSourceDetailsWithCounts(groundingMetadata, urlContextUrls).items;
}

export function mergeSourceDetails(
  grounding: readonly SourceDetail[],
  urlContext: readonly SourceDetail[],
): SourceDetail[] {
  const merged = new Map<string, SourceDetail>();

  for (const source of grounding) {
    merged.set(source.url, source);
  }

  for (const source of urlContext) {
    const existing = merged.get(source.url);
    if (existing) {
      merged.set(source.url, {
        ...existing,
        title: existing.title ?? source.title,
        origin: 'both',
      });
      continue;
    }

    merged.set(source.url, source);
  }

  return [...merged.values()];
}

// ── Grounding Citations & Signals ─────────────────────────────────────

export function collectGroundingCitations(groundingMetadata: GroundingMetadata | undefined): {
  citations: GroundingCitation[];
  droppedSupportCount: number;
} {
  if (!groundingMetadata?.groundingSupports || !groundingMetadata.groundingChunks) {
    return { citations: [], droppedSupportCount: 0 };
  }

  const citations: GroundingCitation[] = [];
  let droppedSupportCount = 0;
  for (const support of groundingMetadata.groundingSupports) {
    const text = support.segment?.text;
    if (!text) continue;

    const sourceUrls: string[] = [];
    const seen = new Set<string>();
    for (const index of support.groundingChunkIndices ?? []) {
      const url = groundingMetadata.groundingChunks[index]?.web?.uri;
      if (!url || seen.has(url) || !isPublicHttpUrl(url)) continue;

      seen.add(url);
      sourceUrls.push(url);
    }

    if (sourceUrls.length === 0) {
      droppedSupportCount += 1;
      continue;
    }

    citations.push(
      pickDefined({
        text,
        startIndex: support.segment?.startIndex,
        endIndex: support.segment?.endIndex,
        sourceUrls,
      }),
    );
  }

  return { citations, droppedSupportCount };
}

export function deriveFindingsFromCitations(citations: readonly GroundingCitation[]): Finding[] {
  const findings = new Map<string, Finding>();

  for (const citation of citations) {
    if (findings.has(citation.text)) continue;
    findings.set(citation.text, {
      claim: citation.text,
      supportingSourceUrls: [...citation.sourceUrls],
      verificationStatus: 'cited',
    });
  }

  return [...findings.values()];
}

const GROUNDING_MEDIUM_CONFIDENCE_SUPPORTS = 1;
const GROUNDING_HIGH_CONFIDENCE_SUPPORTS = 3;

export function deriveDiagramSyntaxValidation(toolEvents: readonly ToolEvent[]): {
  syntaxValid?: boolean;
  syntaxErrors?: string[];
} {
  const result = [...toolEvents].reverse().find((event) => event.kind === 'code_execution_result');
  if (!result) {
    return {};
  }

  if (result.outcome === 'OUTCOME_OK') {
    return { syntaxValid: true };
  }

  return {
    syntaxValid: false,
    syntaxErrors: [result.output ?? result.outcome ?? 'unknown error'],
  };
}

export function auditClaimedToolUsage(text: string, toolsUsed: readonly string[]): string[] {
  const toolsUsedSet = new Set(toolsUsed);
  const capabilityMatchers = new Map<string, RegExp>([
    ['googleSearch', /\b(searched|google search|found via search)\b/i],
    ['codeExecution', /\b(i (?:ran|executed)|computed|verified by running)\b/i],
    ['urlContext', /\b(i retrieved|fetched the page|from the url)\b/i],
  ]);

  const warnings: string[] = [];
  for (const [capability, pattern] of capabilityMatchers) {
    if (pattern.test(text) && !toolsUsedSet.has(capability)) {
      warnings.push(`prose claims ${capability} but it was not invoked this turn`);
    }
  }

  return warnings;
}

export function computeGroundingSignals(
  _streamResult: unknown,
  citations: readonly GroundingCitation[],
  urlMetadata: readonly UrlMetadataEntry[],
  sourceDetails: readonly SourceDetail[],
): GroundingSignals {
  const retrievalPerformed = sourceDetails.length > 0 || urlMetadata.length > 0;
  const urlContextUsed = sourceDetails.some(
    (source) => source.origin === 'urlContext' || source.origin === 'both',
  );
  const confidence =
    citations.length >= GROUNDING_HIGH_CONFIDENCE_SUPPORTS
      ? 'high'
      : citations.length >= GROUNDING_MEDIUM_CONFIDENCE_SUPPORTS
        ? 'medium'
        : retrievalPerformed
          ? 'low'
          : 'none';

  return {
    retrievalPerformed,
    urlContextUsed,
    groundingSupportsCount: citations.length,
    confidence,
  };
}

export function deriveOverallStatus(
  signals: GroundingSignals,
): 'grounded' | 'partially_grounded' | 'ungrounded' {
  if (signals.confidence === 'high') return 'grounded';
  if (signals.confidence === 'medium' || signals.confidence === 'low') {
    return 'partially_grounded';
  }
  return 'ungrounded';
}

export function collectSearchEntryPoint(
  groundingMetadata: GroundingMetadata | undefined,
): SearchEntryPoint | undefined {
  const renderedContent = groundingMetadata?.searchEntryPoint?.renderedContent;
  return renderedContent ? { renderedContent } : undefined;
}

export function promptBlockedError(toolName: string, blockReason?: string): CallToolResult {
  return new SafetyError(toolName, 'prompt_blocked', blockReason).toToolResult();
}

interface SharedStructuredMetadata {
  warnings?: string[];
}

// ── Structured Content ────────────────────────────────────────────────

export function buildSharedStructuredMetadata({
  warnings,
}: {
  warnings?: readonly string[];
}): SharedStructuredMetadata {
  return pickDefined({
    warnings: warnings && warnings.length > 0 ? [...warnings] : undefined,
  });
}

export function buildBaseStructuredOutput(warnings?: readonly string[]): {
  status: 'completed';
  warnings?: string[];
} {
  return pickDefined({
    status: 'completed' as const,
    warnings: warnings && warnings.length > 0 ? [...warnings] : undefined,
  });
}

const SHARED_STRUCTURED_RESULT_KEYS = ['warnings'] as const;

type SharedStructuredResultKey = (typeof SHARED_STRUCTURED_RESULT_KEYS)[number];

function pickSharedStructuredResultFields(
  structured: Record<string, unknown>,
): Partial<Record<SharedStructuredResultKey, unknown>> {
  return pickDefined(
    Object.fromEntries(
      SHARED_STRUCTURED_RESULT_KEYS.map((key) => [key, structured[key]]),
    ) as Record<SharedStructuredResultKey, unknown>,
  );
}

export function buildStructuredResponse<T extends Record<string, unknown>>(
  domain: T,
  shared?: {
    warnings?: readonly string[];
    functionCalls?: readonly unknown[];
    includeThoughts?: boolean;
    thoughtText?: string;
    toolEvents?: readonly unknown[];
    usage?: UsageMetadata | undefined;
    safetyRatings?: unknown;
    finishMessage?: string | undefined;
    citationMetadata?: unknown;
    groundingMetadata?: unknown;
    urlContextMetadata?: unknown;
  },
): T & SharedStructuredMetadata & Record<string, unknown> {
  return {
    ...domain,
    ...(shared ? buildSharedStructuredMetadata(shared) : {}),
  };
}

export function buildSuccessfulStructuredContent<TDomain extends Record<string, unknown>>({
  warnings,
  domain,
  shared,
}: {
  warnings?: readonly string[] | undefined;
  domain: TDomain;
  shared?: Record<string, unknown> | undefined;
}): TDomain & ReturnType<typeof buildBaseStructuredOutput> & Record<string, unknown> {
  const merged = pickDefined({
    ...buildBaseStructuredOutput(warnings),
    ...domain,
    ...(shared ? pickSharedStructuredResultFields(shared) : {}),
  });
  return stripEmpty(merged) as TDomain &
    ReturnType<typeof buildBaseStructuredOutput> &
    Record<string, unknown>;
}

export function validateStructuredContent<TSchema extends z.ZodType>(
  toolName: string,
  outputSchema: TSchema,
  structuredContent: unknown,
): z.infer<TSchema> {
  const parsed = outputSchema.safeParse(structuredContent);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(
    `${toolName} produced structuredContent that does not match outputSchema.\n` +
      z.prettifyError(parsed.error),
  );
}

const responseLog = logger.child('response');

function hasSafeParse(outputSchema: unknown): outputSchema is z.ZodType {
  return (
    typeof outputSchema === 'object' &&
    outputSchema !== null &&
    'safeParse' in outputSchema &&
    typeof (outputSchema as { safeParse?: unknown }).safeParse === 'function'
  );
}

function buildStructuredValidationErrorResult(
  toolName: string,
  result: CallToolResult,
  error: z.ZodError,
): CallToolResult {
  const diagnostic = `Internal ${toolName} output validation failed: structuredContent did not match outputSchema.\n${z.prettifyError(error)}`;
  return {
    content: [
      ...result.content,
      {
        type: 'text',
        text: diagnostic,
      },
    ],
    isError: true,
  };
}

function buildStructuredValidationWarningResult(
  toolName: string,
  result: CallToolResult,
  error: z.ZodError,
): CallToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: 'text',
        text:
          `Warning: ${toolName} structuredContent did not match outputSchema and was omitted.\n` +
          z.prettifyError(error),
      },
    ],
    structuredContent: undefined,
  };
}

function hasVisibleToolContent(result: CallToolResult): boolean {
  return result.content.some((entry) => {
    if (entry.type !== 'text') {
      return true;
    }

    return typeof entry.text === 'string' && entry.text.trim().length > 0;
  });
}

function attachValidatedStructuredContent(
  toolName: string,
  outputSchema: unknown,
  candidate: unknown,
  result: CallToolResult,
  logOnMismatch: boolean,
): CallToolResult {
  if (result.isError || result.structuredContent === undefined || !hasSafeParse(outputSchema)) {
    return result;
  }

  const parsed = outputSchema.safeParse(candidate);
  if (parsed.success) {
    return {
      ...result,
      structuredContent: parsed.data as CallToolResult['structuredContent'],
    };
  }

  if (logOnMismatch) {
    responseLog.error('structuredContent validation failed', {
      toolName,
      error: z.prettifyError(parsed.error),
    });
  }

  if (hasVisibleToolContent(result)) {
    return buildStructuredValidationWarningResult(toolName, result, parsed.error);
  }

  return buildStructuredValidationErrorResult(toolName, result, parsed.error);
}

export function safeValidateStructuredContent(
  toolName: string,
  outputSchema: unknown,
  structuredContent: unknown,
  result: CallToolResult,
): CallToolResult {
  return attachValidatedStructuredContent(toolName, outputSchema, structuredContent, result, true);
}

export function validateStructuredToolResult(
  toolName: string,
  outputSchema: unknown,
  result: CallToolResult,
): CallToolResult {
  return attachValidatedStructuredContent(
    toolName,
    outputSchema,
    result.structuredContent,
    result,
    false,
  );
}

// ── Content Builders ──────────────────────────────────────────────────

function appendBulletListSection(
  content: CallToolResult['content'],
  heading: string,
  entries: readonly string[],
): void {
  if (entries.length === 0) return;

  content.push({
    type: 'text',
    text: `\n\n${heading}:\n${entries.map((entry) => `- ${entry}`).join('\n')}`,
  });
}

export function appendSources(
  content: CallToolResult['content'],
  sources: readonly string[],
): void {
  appendBulletListSection(content, 'Sources', sources);
}

export function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function appendUrlStatus(
  content: CallToolResult['content'],
  urlMetadata: UrlMetadataEntry[],
): void {
  appendBulletListSection(
    content,
    'URL Retrieval Status',
    urlMetadata.map((meta) => `${meta.url}: ${meta.status}`),
  );
}

export function createResourceLink(
  uri: string,
  name: string,
  mimeType = 'application/json',
): Extract<CallToolResult['content'][number], { type: 'resource_link' }> {
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
  };
}

const RELATED_TASK_META_KEY = SDK_RELATED_TASK_META_KEY;

export function withRelatedTaskMeta<T extends Record<string, unknown>>(
  value: T,
  taskId?: string,
): T & { _meta?: Record<string, unknown> } {
  const existingMeta =
    typeof value._meta === 'object' && value._meta !== null
      ? (value._meta as Record<string, unknown>)
      : undefined;

  return {
    ...value,
    ...(taskId
      ? {
          _meta: {
            ...(existingMeta ?? {}),
            [RELATED_TASK_META_KEY]: { taskId },
          },
        }
      : {}),
  };
}

/**
 * Extracts text from a Gemini response, returning an errorResult if the
 * response was blocked, empty, or truncated by safety/recitation filters.
 */
export function extractTextOrError(
  response: GenerateContentResponse,
  toolName: string,
): CallToolResult {
  const candidate = response.candidates?.[0];

  // No candidates at all — prompt-level block
  if (!candidate) {
    return promptBlockedError(toolName, response.promptFeedback?.blockReason);
  }

  const text = response.text ?? '';
  const errResult = finishReasonToError(candidate.finishReason, text, toolName);
  if (errResult) return errResult.toToolResult();

  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Helper to extract text from a CallToolResult's content array.
 */
export function extractTextContent(
  content: { type: string; text?: string; [key: string]: unknown }[],
): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

// ── Grounding Presentation ───
export function buildSourceReportMessage(sourceCount: number): string {
  return sourceCount > 0
    ? `${formatCountLabel(sourceCount, 'source')} found`
    : 'completed with no grounded sources surfaced';
}

export function formatSourceLabels(
  sourceDetails: readonly { title?: string | undefined; url: string }[],
): string[] {
  return sourceDetails.map((source) =>
    source.title ? `${source.title}: ${source.url}` : source.url,
  );
}

export function collectUrlContextSources(
  urlMetadata: readonly { status: string; url: string }[],
): string[] {
  return urlMetadata
    .filter((entry) => entry.status === 'URL_RETRIEVAL_STATUS_SUCCESS')
    .map((entry) => entry.url);
}

export function buildUrlContextSourceDetails(
  urls: readonly string[],
): { domain?: string; origin: 'urlContext'; url: string }[] {
  return urls.map((url) =>
    pickDefined({ domain: new URL(url).hostname, origin: 'urlContext' as const, url }),
  );
}

export function buildDroppedSupportWarnings({
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

export function extractSampledText(content: unknown): string {
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

export function countOccurrences(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
