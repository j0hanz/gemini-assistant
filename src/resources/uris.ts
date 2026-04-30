import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

// ============================== assistant:// ==============================

export const ASSISTANT_CATALOG_URI = 'assistant://discover/catalog' as const;
export const ASSISTANT_WORKFLOWS_URI = 'assistant://discover/workflows' as const;
export const ASSISTANT_CONTEXT_URI = 'assistant://discover/context' as const;
export const ASSISTANT_PROFILES_URI = 'assistant://profiles' as const;
export const ASSISTANT_INSTRUCTIONS_URI = 'assistant://instructions' as const;

// ============================== gemini:// ==================================

export const SESSIONS_LIST_URI = 'gemini://sessions' as const;
export const WORKSPACE_CACHE_URI = 'gemini://workspace/cache' as const;
export const WORKSPACE_CACHE_CONTENTS_URI = 'gemini://workspace/cache/contents' as const;
export const WORKSPACE_FILES_URI = 'gemini://workspace/files' as const;

// ============================== Template Strings ============================

export const SESSION_DETAIL_TEMPLATE = 'gemini://session/{sessionId}' as const;
export const SESSION_TRANSCRIPT_TEMPLATE = 'gemini://session/{sessionId}/transcript' as const;
export const SESSION_EVENTS_TEMPLATE = 'gemini://session/{sessionId}/events' as const;
export const TURN_PARTS_TEMPLATE = 'gemini://session/{sessionId}/turn/{turnIndex}/parts' as const;
export const TURN_GROUNDING_TEMPLATE =
  'gemini://session/{sessionId}/turn/{turnIndex}/grounding' as const;
export const FILE_RESOURCE_TEMPLATE = 'gemini://workspace/files/{path}' as const;

// ============================== Builder Functions ============================

/**
 * Build a session resource URI for the given session ID.
 * Encodes the session ID using encodeURIComponent.
 */
export function sessionResourceUri(sessionId: string): string {
  return `gemini://session/${encodeURIComponent(sessionId)}`;
}

/**
 * Build a session transcript URI for the given session ID.
 * Encodes the session ID using encodeURIComponent.
 */
export function sessionTranscriptUri(sessionId: string): string {
  return `${sessionResourceUri(sessionId)}/transcript`;
}

/**
 * Build a session events URI for the given session ID.
 * Encodes the session ID using encodeURIComponent.
 */
export function sessionEventsUri(sessionId: string): string {
  return `${sessionResourceUri(sessionId)}/events`;
}

/**
 * Build a turn parts URI for the given session ID and turn index.
 * Encodes the session ID using encodeURIComponent.
 */
export function turnPartsUri(sessionId: string, turnIndex: number): string {
  return `gemini://session/${encodeURIComponent(sessionId)}/turn/${String(turnIndex)}/parts`;
}

/**
 * Build a turn grounding URI for the given session ID and turn index.
 * Encodes the session ID using encodeURIComponent.
 */
export function turnGroundingUri(sessionId: string, turnIndex: number): string {
  return `gemini://session/${encodeURIComponent(sessionId)}/turn/${String(turnIndex)}/grounding`;
}

/**
 * Build a file resource URI for the given path.
 * Encodes path segments individually to preserve the directory structure.
 */
export function fileResourceUri(path: string): string {
  const segments = path.split('/');
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `gemini://workspace/files/${encoded}`;
}

// ============================== Template Param Helpers =======================

/**
 * Normalize a template parameter value by handling arrays and falsy values.
 * Returns the value as-is if it's a non-empty string, the first element if it's
 * a non-empty array, or undefined if falsy.
 */
export function normalizeTemplateParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  // Return the string if truthy, otherwise undefined
  return value && value.length > 0 ? value : undefined;
}

/**
 * Decode a template parameter value with percent-encoding handling.
 * Returns undefined if the value is falsy.
 * Handles arrays by taking the first element.
 * Throws ProtocolError if the value contains invalid percent-encoding.
 */
export function decodeTemplateParam(value: string | string[] | undefined): string | undefined {
  const normalized = normalizeTemplateParam(value);
  if (!normalized) {
    return normalized;
  }

  try {
    return decodeURIComponent(normalized);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Invalid percent-encoding in resource URI parameter',
    );
  }
}

/**
 * Require and decode a template parameter value.
 * Throws ProtocolError with the provided label if the value is falsy or invalid.
 */
export function requireTemplateParam(value: string | string[] | undefined, label: string): string {
  const decoded = decodeTemplateParam(value);
  if (!decoded) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${label} required`);
  }
  return decoded;
}
