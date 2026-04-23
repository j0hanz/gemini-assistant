import type { ContentEntry } from '../sessions.js';

export interface ReplayWindowSelection {
  dropped: number;
  kept: ContentEntry[];
}

function entryBytes(entry: ContentEntry): number {
  return JSON.stringify(entry.parts).length;
}

export function selectReplayWindow(
  contents: readonly ContentEntry[],
  maxBytes: number,
): ReplayWindowSelection {
  if (contents.length === 0) {
    return { kept: [], dropped: 0 };
  }

  const kept: ContentEntry[] = [];
  let totalBytes = 0;

  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const entry = contents[index];
    if (!entry) continue;

    const nextBytes = totalBytes + entryBytes(entry);
    if (nextBytes > maxBytes) {
      break;
    }

    kept.unshift(entry);
    totalBytes = nextBytes;
  }

  return {
    kept,
    dropped: contents.length - kept.length,
  };
}
