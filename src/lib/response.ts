import type { CallToolResult } from '@modelcontextprotocol/server';

import { FinishReason, type GenerateContentResponse } from '@google/genai';

import { errorResult } from './errors.js';

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

  const { finishReason } = candidate;

  if (finishReason === FinishReason.SAFETY) {
    return errorResult(`${toolName}: response blocked by safety filter`);
  }

  if (finishReason === FinishReason.RECITATION) {
    return errorResult(`${toolName}: response blocked due to recitation policy`);
  }

  const text = response.text ?? '';

  if (!text && finishReason === FinishReason.MAX_TOKENS) {
    return errorResult(`${toolName}: response truncated — max tokens reached with no output`);
  }

  return {
    content: [{ type: 'text', text }],
  };
}
