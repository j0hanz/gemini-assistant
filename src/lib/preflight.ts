import type { CallToolResult } from '@modelcontextprotocol/server';

import { AppError } from './errors.js';
import type { BuiltInToolName } from './orchestration.js';

export interface GeminiRequestPreflight {
  hasExistingSession?: boolean | undefined;
  jsonMode?: boolean | undefined;
  responseSchema?: unknown;
  sessionId?: string | undefined;
  activeCapabilities: Set<BuiltInToolName>;
}

export function validateGeminiRequest({
  hasExistingSession,
  jsonMode,
  responseSchema,
  sessionId,
  activeCapabilities,
}: GeminiRequestPreflight): CallToolResult | undefined {
  const usesBuiltInTool =
    activeCapabilities.has('googleSearch') ||
    activeCapabilities.has('urlContext') ||
    activeCapabilities.has('codeExecution');

  if ((jsonMode ?? responseSchema !== undefined) && usesBuiltInTool) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be combined with built-in tools (googleSearch, urlContext, codeExecution)',
    ).toToolResult();
  }

  if (responseSchema && sessionId && hasExistingSession) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    ).toToolResult();
  }

  return undefined;
}
