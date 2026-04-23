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

type PreflightCheck = (req: GeminiRequestPreflight) => CallToolResult | undefined;

const disallowSchemaWithCodeExecution: PreflightCheck = (req) => {
  const schemaRequested = req.jsonMode ?? req.responseSchema !== undefined;
  if (schemaRequested && req.activeCapabilities.has('codeExecution')) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be combined with codeExecution',
    ).toToolResult();
  }
  return undefined;
};

const disallowEmptyFileSearchStore: PreflightCheck = (req) => {
  if (
    req.activeCapabilities.has('fileSearch') &&
    req.fileSearchStoreNames?.some((name) => name.trim().length === 0)
  ) {
    return new AppError(
      'chat',
      'chat: fileSearchStoreNames cannot contain empty values',
    ).toToolResult();
  }
  return undefined;
};

const disallowSchemaInExistingSession: PreflightCheck = (req) => {
  if (req.responseSchema && req.sessionId && req.hasExistingSession) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    ).toToolResult();
  }
  return undefined;
};

const CHECKS: readonly PreflightCheck[] = [
  disallowSchemaWithCodeExecution,
  disallowEmptyFileSearchStore,
  disallowSchemaInExistingSession,
];

export function validateGeminiRequest(req: GeminiRequestPreflight): CallToolResult | undefined {
  for (const check of CHECKS) {
    const result = check(req);
    if (result) return result;
  }
  return undefined;
}
