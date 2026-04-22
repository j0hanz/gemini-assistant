export const DISCOVER_CATALOG_URI = 'discover://catalog';
export const DISCOVER_WORKFLOWS_URI = 'discover://workflows';
export const DISCOVER_CONTEXT_URI = 'discover://context';
export const SESSIONS_LIST_URI = 'session://';
export const WORKSPACE_CONTEXT_URI = 'workspace://context';
export const WORKSPACE_CACHE_URI = 'workspace://cache';

export function sessionDetailUri(sessionId: string): string {
  return `session://${encodeURIComponent(sessionId)}`;
}

export function sessionTranscriptUri(sessionId: string): string {
  return `${sessionDetailUri(sessionId)}/transcript`;
}

export function sessionEventsUri(sessionId: string): string {
  return `${sessionDetailUri(sessionId)}/events`;
}
