export const DISCOVER_CATALOG_URI = 'discover://catalog';
export const DISCOVER_WORKFLOWS_URI = 'discover://workflows';
export const DISCOVER_CONTEXT_URI = 'discover://context';
export const MEMORY_CACHES_URI = 'memory://caches';
export const MEMORY_WORKSPACE_CONTEXT_URI = 'memory://workspace/context';
export const MEMORY_WORKSPACE_CACHE_URI = 'memory://workspace/cache';

export function cacheDetailUri(cacheName: string): string {
  return `${MEMORY_CACHES_URI}/${encodeURIComponent(cacheName)}`;
}

export function sessionDetailUri(sessionId: string): string {
  return `memory://sessions/${encodeURIComponent(sessionId)}`;
}

export function sessionTranscriptUri(sessionId: string): string {
  return `${sessionDetailUri(sessionId)}/transcript`;
}

export function sessionEventsUri(sessionId: string): string {
  return `${sessionDetailUri(sessionId)}/events`;
}
