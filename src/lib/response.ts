import {
  type CallToolResult,
  RELATED_TASK_META_KEY as SDK_RELATED_TASK_META_KEY,
} from '@modelcontextprotocol/server';

import type { GenerateContentResponse, GroundingMetadata, UrlMetadata } from '@google/genai';
import { z } from 'zod/v4';

import type {
  ContextUsed,
  GroundingCitation,
  SearchEntryPoint,
  SourceDetail,
  UrlMetadataEntry,
  UsageMetadata,
} from '../schemas/outputs.js';

import { finishReasonToError, SafetyError } from './errors.js';
import { logger } from './logger.js';
import { pickDefined } from './object.js';
import { isPublicHttpUrl } from './validation.js';

export function collectUrlMetadata(urlMetadata: UrlMetadata[] | undefined): UrlMetadataEntry[] {
  if (!urlMetadata) return [];
  const entries: UrlMetadataEntry[] = [];
  const seen = new Set<string>();
  for (const meta of urlMetadata) {
    const url = meta.retrievedUrl;
    if (!url || seen.has(url) || !isPublicHttpUrl(url)) {
      continue;
    }

    seen.add(url);
    entries.push({
      url,
      status: meta.urlRetrievalStatus ?? 'UNKNOWN',
    });
  }
  return entries;
}

export function collectGroundedSources(groundingMetadata: GroundingMetadata | undefined): string[] {
  return collectGroundedSourceDetails(groundingMetadata).map((source) => source.url);
}

export function collectGroundedSourceDetails(
  groundingMetadata: GroundingMetadata | undefined,
  urlContextUrls = new Set<string>(),
): SourceDetail[] {
  if (!groundingMetadata?.groundingChunks) return [];

  const sources: SourceDetail[] = [];
  const seen = new Set<string>();
  for (const chunk of groundingMetadata.groundingChunks) {
    const uri = chunk.web?.uri;
    if (!uri || seen.has(uri) || !isPublicHttpUrl(uri)) continue;

    seen.add(uri);
    const title = chunk.web?.title;
    const origin = urlContextUrls.has(uri) ? 'both' : 'googleSearch';
    sources.push(title ? { origin, title, url: uri } : { origin, url: uri });
  }

  return sources;
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

export function collectSearchEntryPoint(
  groundingMetadata: GroundingMetadata | undefined,
): SearchEntryPoint | undefined {
  const renderedContent = groundingMetadata?.searchEntryPoint?.renderedContent;
  return renderedContent ? { renderedContent } : undefined;
}

export function promptBlockedError(toolName: string, blockReason?: string): CallToolResult {
  return new SafetyError(toolName, 'prompt_blocked', blockReason).toToolResult();
}

interface SharedStructuredMetadata<TFunctionCall, TToolEvent> {
  contextUsed?: ContextUsed;
  functionCalls?: TFunctionCall[];
  thoughts?: string;
  toolEvents?: TToolEvent[];
  usage?: UsageMetadata;
  safetyRatings?: unknown;
  finishMessage?: string | undefined;
  citationMetadata?: unknown;
}

export function buildSharedStructuredMetadata<TFunctionCall, TToolEvent>({
  contextUsed,
  functionCalls,
  includeThoughts = false,
  thoughtText,
  toolEvents,
  usage,
  safetyRatings,
  finishMessage,
  citationMetadata,
}: {
  contextUsed?: ContextUsed;
  functionCalls?: readonly TFunctionCall[];
  includeThoughts?: boolean;
  thoughtText?: string;
  toolEvents?: readonly TToolEvent[];
  usage?: UsageMetadata | undefined;
  safetyRatings?: unknown;
  finishMessage?: string | undefined;
  citationMetadata?: unknown;
}): SharedStructuredMetadata<TFunctionCall, TToolEvent> {
  return pickDefined({
    contextUsed,
    functionCalls: functionCalls && functionCalls.length > 0 ? [...functionCalls] : undefined,
    thoughts: includeThoughts && thoughtText ? thoughtText : undefined,
    toolEvents: toolEvents && toolEvents.length > 0 ? [...toolEvents] : undefined,
    usage,
    safetyRatings,
    finishMessage,
    citationMetadata,
  });
}

export function buildBaseStructuredOutput(
  requestId?: string,
  warnings?: readonly string[],
): {
  requestId?: string;
  status: 'completed';
  warnings?: string[];
} {
  return pickDefined({
    status: 'completed' as const,
    requestId,
    warnings: warnings && warnings.length > 0 ? [...warnings] : undefined,
  });
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
