import type { CallToolResult } from '@modelcontextprotocol/server';

import type { GenerateContentResponse } from '@google/genai';

import { errorResult, finishReasonError } from './errors.js';

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
