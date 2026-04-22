import {
  type CallToolResult,
  RELATED_TASK_META_KEY as SDK_RELATED_TASK_META_KEY,
} from '@modelcontextprotocol/server';

import type { GenerateContentResponse, GroundingMetadata, UrlMetadata } from '@google/genai';
import { z } from 'zod/v4';

import type {
  ContextUsed,
  SourceDetail,
  UrlMetadataEntry,
  UsageMetadata,
} from '../schemas/outputs.js';

import { finishReasonToError, SafetyError } from './errors.js';
import { isPublicHttpUrl } from './validation.js';

type PickDefined<T> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

export function pickDefined<T extends Record<string, unknown>>(obj: T): PickDefined<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as PickDefined<T>;
}

export function collectUrlMetadata(urlMetadata: UrlMetadata[] | undefined): UrlMetadataEntry[] {
  if (!urlMetadata) return [];
  const entries: UrlMetadataEntry[] = [];
  for (const meta of urlMetadata) {
    if (meta.retrievedUrl) {
      entries.push({
        url: meta.retrievedUrl,
        status: meta.urlRetrievalStatus ?? 'UNKNOWN',
      });
    }
  }
  return entries;
}

export function collectGroundedSources(groundingMetadata: GroundingMetadata | undefined): string[] {
  return collectGroundedSourceDetails(groundingMetadata)
    .map((source) => source.url)
    .filter((url) => isPublicHttpUrl(url));
}

export function collectGroundedSourceDetails(
  groundingMetadata: GroundingMetadata | undefined,
): SourceDetail[] {
  if (!groundingMetadata?.groundingChunks) return [];

  const sources: SourceDetail[] = [];
  for (const chunk of groundingMetadata.groundingChunks) {
    const uri = chunk.web?.uri;
    if (!uri) continue;

    const title = chunk.web?.title;
    sources.push(title ? { title, url: uri } : { url: uri });
  }

  return sources;
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
}

export function buildSharedStructuredMetadata<TFunctionCall, TToolEvent>({
  contextUsed,
  functionCalls,
  includeThoughts = false,
  thoughtText,
  toolEvents,
  usage,
}: {
  contextUsed?: ContextUsed;
  functionCalls?: readonly TFunctionCall[];
  includeThoughts?: boolean;
  thoughtText?: string;
  toolEvents?: readonly TToolEvent[];
  usage?: UsageMetadata | undefined;
}): SharedStructuredMetadata<TFunctionCall, TToolEvent> {
  return pickDefined({
    contextUsed,
    functionCalls: functionCalls && functionCalls.length > 0 ? [...functionCalls] : undefined,
    thoughts: includeThoughts && thoughtText ? thoughtText : undefined,
    toolEvents: toolEvents && toolEvents.length > 0 ? [...toolEvents] : undefined,
    usage,
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

interface SafeParseSchema {
  safeParse: (input: unknown) => { success: true; data: unknown } | { success: false };
}

function hasSafeParse(outputSchema: unknown): outputSchema is SafeParseSchema {
  return (
    typeof outputSchema === 'object' &&
    outputSchema !== null &&
    'safeParse' in outputSchema &&
    typeof outputSchema.safeParse === 'function'
  );
}

export function validateStructuredToolResult(
  toolName: string,
  outputSchema: unknown,
  result: CallToolResult,
): CallToolResult {
  if (result.isError || result.structuredContent === undefined || !hasSafeParse(outputSchema)) {
    return result;
  }

  const parsed = outputSchema.safeParse(result.structuredContent);
  if (parsed.success) {
    return {
      ...result,
      structuredContent: parsed.data as CallToolResult['structuredContent'],
    };
  }

  return {
    content: [
      ...result.content,
      {
        type: 'text',
        text: `Internal ${toolName} output validation failed: structuredContent did not match outputSchema.`,
      },
    ],
    isError: true,
  };
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

export const RELATED_TASK_META_KEY = SDK_RELATED_TASK_META_KEY;

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
