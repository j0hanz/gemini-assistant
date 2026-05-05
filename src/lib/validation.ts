import type { CallToolResult } from '@modelcontextprotocol/server';

import { AppError } from './errors.js';

// Re-export validation modules for backward compatibility and barrel pattern
export { parseAllowedHosts, validateHostHeader } from './host-guard.js';
export { isPathWithinRoot, validateScanPath, normalizeWorkspacePath } from './path-guard.js';
export { isPublicHttpUrl } from './url-guard.js';

// ── Gemini Request Preflight ──────────────────────────────────────────────

// Local mirror of orchestration.ActiveCapability to avoid type-import cycle with orchestration.ts.
type PreflightCapability =
  | 'googleSearch'
  | 'urlContext'
  | 'codeExecution'
  | 'fileSearch'
  | 'functions';

export interface GeminiRequestPreflight {
  allowExistingSessionSchema?: boolean | undefined;
  hasExistingSession?: boolean | undefined;
  jsonMode?: boolean | undefined;
  responseSchema?: unknown;
  sessionId?: string | undefined;
  activeCapabilities: ReadonlySet<PreflightCapability>;
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
  if (
    req.responseSchema &&
    req.sessionId &&
    req.hasExistingSession &&
    req.allowExistingSessionSchema !== true
  ) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    ).toToolResult();
  }
  return undefined;
};

const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  disallowSchemaWithCodeExecution,
  disallowEmptyFileSearchStore,
  disallowSchemaInExistingSession,
];

export function validateGeminiRequest(req: GeminiRequestPreflight): CallToolResult | undefined {
  for (const check of PREFLIGHT_CHECKS) {
    const result = check(req);
    if (result) return result;
  }
  return undefined;
}
