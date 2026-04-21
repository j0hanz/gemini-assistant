import type { ContextSourceReport, ContextUsed } from '../schemas/outputs.js';

import type { TranscriptEntry } from '../sessions.js';
import { estimateTokens } from './tokens.js';

const SESSION_SUMMARY_BUDGET = 500;
const SUMMARY_ENTRY_MAX_CHARS = 200;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

interface ContextSource extends ContextSourceReport {
  relevanceScore: number;
}

export function buildSessionSummary(
  transcript: readonly TranscriptEntry[],
  maxTokens = SESSION_SUMMARY_BUDGET,
): string | undefined {
  if (transcript.length < 2) {
    return undefined;
  }

  const lines: string[] = [];
  let tokenEstimate = 0;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (!entry) {
      continue;
    }
    const line = `[${entry.role}]: ${truncate(entry.text, SUMMARY_ENTRY_MAX_CHARS)}`;
    const lineTokens = estimateTokens(line);
    if (tokenEstimate + lineTokens > maxTokens) {
      break;
    }
    lines.unshift(line);
    tokenEstimate += lineTokens;
  }

  if (lines.length === 0) {
    return undefined;
  }

  return `<prior_conversation>\n${lines.join('\n')}\n</prior_conversation>`;
}

export function buildContextUsed(
  sources: readonly ContextSource[],
  totalTokens: number,
  workspaceCacheApplied: boolean,
): ContextUsed {
  return {
    sources: sources.map(({ kind, name, tokens }) => ({ kind, name, tokens })),
    totalTokens,
    workspaceCacheApplied,
  };
}

export function emptyContextUsed(): ContextUsed {
  return {
    sources: [],
    totalTokens: 0,
    workspaceCacheApplied: false,
  };
}
