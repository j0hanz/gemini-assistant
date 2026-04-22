import type { CallToolResult } from '@modelcontextprotocol/server';

import { AppError } from './errors.js';
import type { ActiveCapability } from './orchestration.js';

export interface GeminiRequestPreflight {
  hasExistingSession?: boolean | undefined;
  jsonMode?: boolean | undefined;
  responseSchema?: unknown;
  sessionId?: string | undefined;
  activeCapabilities: ReadonlySet<ActiveCapability>;
  fileSearchStoreNames?: readonly string[] | undefined;
}

export function validateGeminiRequest({
  hasExistingSession,
  jsonMode,
  responseSchema,
  sessionId,
  activeCapabilities,
  fileSearchStoreNames,
}: GeminiRequestPreflight): CallToolResult | undefined {
  const usesBuiltInTool =
    activeCapabilities.has('googleSearch') ||
    activeCapabilities.has('urlContext') ||
    activeCapabilities.has('codeExecution') ||
    activeCapabilities.has('fileSearch');

  if ((jsonMode ?? responseSchema !== undefined) && usesBuiltInTool) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be combined with built-in tools (googleSearch, urlContext, codeExecution, fileSearch)',
    ).toToolResult();
  }

  if (
    activeCapabilities.has('fileSearch') &&
    fileSearchStoreNames?.some((name) => name.trim().length === 0)
  ) {
    return new AppError(
      'chat',
      'chat: fileSearchStoreNames cannot contain empty values',
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
