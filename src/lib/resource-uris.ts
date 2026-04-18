export function sessionDetailUri(sessionId: string): string {
  return `memory://sessions/${encodeURIComponent(sessionId)}`;
}

export function sessionTranscriptUri(sessionId: string): string {
  return `${sessionDetailUri(sessionId)}/transcript`;
}

export function sessionEventsUri(sessionId: string): string {
  return `${sessionDetailUri(sessionId)}/events`;
}
