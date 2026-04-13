import type { CallToolResult } from '@modelcontextprotocol/server';

import type { GenerateContentResponse, GroundingMetadata, UrlMetadata } from '@google/genai';

import type { UrlMetadataEntry } from '../schemas/outputs.js';

import { errorResult, finishReasonError } from './errors.js';

export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
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
  if (!groundingMetadata?.groundingChunks) return [];

  const sources: string[] = [];
  for (const chunk of groundingMetadata.groundingChunks) {
    const uri = chunk.web?.uri;
    if (!uri) continue;

    const title = chunk.web?.title;
    sources.push(title ? `${title}: ${uri}` : uri);
  }

  return sources;
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
    const blockReason = response.promptFeedback?.blockReason ?? 'unknown';
    return errorResult(`${toolName}: prompt blocked by safety filter (${blockReason})`);
  }

  const text = response.text ?? '';
  const errResult = finishReasonError(candidate.finishReason, text, toolName);
  if (errResult) return errResult;

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
