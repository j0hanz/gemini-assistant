import type { ContentEntry } from '../sessions.js';

type PairKind = 'function' | 'tool';

interface PairEndpoint {
  descriptor: string;
  entryIndex: number;
  id?: string;
  key: string;
  kind: PairKind;
  type: 'call' | 'response';
}

function entryBytes(entry: ContentEntry): number {
  return JSON.stringify(entry.parts).length;
}

function endpointDescriptor(kind: PairKind, value: string | undefined): string {
  return `${kind}:${value ?? ''}`;
}

function collectEndpoints(contents: readonly ContentEntry[], end: number): PairEndpoint[] {
  const endpoints: Omit<PairEndpoint, 'key'>[] = [];
  for (let entryIndex = 0; entryIndex < end; entryIndex += 1) {
    const entry = contents[entryIndex];
    if (!entry) continue;

    for (const part of entry.parts) {
      if (part.functionCall?.name) {
        endpoints.push({
          descriptor: endpointDescriptor('function', part.functionCall.name),
          entryIndex,
          ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
          kind: 'function',
          type: 'call',
        });
      }
      if (part.functionResponse) {
        endpoints.push({
          descriptor: endpointDescriptor('function', part.functionResponse.name),
          entryIndex,
          ...(part.functionResponse.id ? { id: part.functionResponse.id } : {}),
          kind: 'function',
          type: 'response',
        });
      }
      if (part.toolCall) {
        endpoints.push({
          descriptor: endpointDescriptor('tool', part.toolCall.toolType),
          entryIndex,
          ...(part.toolCall.id ? { id: part.toolCall.id } : {}),
          kind: 'tool',
          type: 'call',
        });
      }
      if (part.toolResponse) {
        endpoints.push({
          descriptor: endpointDescriptor('tool', part.toolResponse.toolType),
          entryIndex,
          ...(part.toolResponse.id ? { id: part.toolResponse.id } : {}),
          kind: 'tool',
          type: 'response',
        });
      }
    }
  }

  const idlessCounts = new Map<string, number>();
  return endpoints.map((endpoint) => {
    if (endpoint.id) {
      return { ...endpoint, key: `${endpoint.kind}:id:${endpoint.id}` };
    }

    const countKey = `${endpoint.type}:${endpoint.descriptor}`;
    const ordinal = idlessCounts.get(countKey) ?? 0;
    idlessCounts.set(countKey, ordinal + 1);
    return { ...endpoint, key: `${endpoint.descriptor}:pos:${String(ordinal)}` };
  });
}

function initialWindowStart(
  contents: readonly ContentEntry[],
  end: number,
  maxBytes: number,
): number {
  let totalBytes = 0;
  let start = end;

  for (let index = end - 1; index >= 0; index -= 1) {
    const entry = contents[index];
    if (!entry) continue;

    const nextBytes = totalBytes + entryBytes(entry);
    if (start < end && nextBytes > maxBytes) {
      break;
    }

    start = index;
    totalBytes = nextBytes;
  }

  return start;
}

function windowBytes(contents: readonly ContentEntry[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    const entry = contents[index];
    if (entry) total += entryBytes(entry);
  }
  return total;
}

function extendStartForResponses(
  contents: readonly ContentEntry[],
  start: number,
  end: number,
): number {
  const endpoints = collectEndpoints(contents, end);
  const selectedCalls = new Set(
    endpoints
      .filter((endpoint) => endpoint.type === 'call' && endpoint.entryIndex >= start)
      .map((endpoint) => endpoint.key),
  );
  const callsByKey = new Map(
    endpoints
      .filter((endpoint) => endpoint.type === 'call')
      .map((endpoint) => [endpoint.key, endpoint] as const),
  );

  let extendedStart = start;
  for (const response of endpoints) {
    if (response.entryIndex < start || selectedCalls.has(response.key)) continue;
    const call = callsByKey.get(response.key);
    if (call && call.entryIndex < extendedStart) {
      extendedStart = call.entryIndex;
    }
  }

  return extendedStart;
}

function hasUnansweredCallInEntry(
  contents: readonly ContentEntry[],
  entryIndex: number,
  start: number,
  end: number,
): boolean {
  const entry = contents[entryIndex];
  if (entry?.role !== 'model') return false;

  const endpoints = collectEndpoints(contents, end);
  const laterResponses = new Set(
    endpoints
      .filter((endpoint) => endpoint.type === 'response' && endpoint.entryIndex > entryIndex)
      .map((endpoint) => endpoint.key),
  );

  return endpoints.some(
    (endpoint) =>
      endpoint.type === 'call' &&
      endpoint.entryIndex === entryIndex &&
      endpoint.entryIndex >= start &&
      !laterResponses.has(endpoint.key),
  );
}

function enforceHardCeiling(
  contents: readonly ContentEntry[],
  start: number,
  end: number,
  maxBytes: number,
): number {
  const hardMaxBytes = maxBytes * 2;
  let trimmedStart = start;

  while (trimmedStart < end && windowBytes(contents, trimmedStart, end) > hardMaxBytes) {
    trimmedStart += 1;
  }

  return trimmedStart;
}

export function selectReplayWindow(contents: ContentEntry[], maxBytes: number): ContentEntry[] {
  if (contents.length === 0) return [];

  let end = contents.length;
  while (end > 0) {
    let start = initialWindowStart(contents, end, maxBytes);
    start = extendStartForResponses(contents, start, end);
    start = enforceHardCeiling(contents, start, end, maxBytes);

    if (hasUnansweredCallInEntry(contents, end - 1, start, end)) {
      end -= 1;
      continue;
    }

    return contents.slice(start, end);
  }

  return [];
}
