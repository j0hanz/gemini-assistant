import type { ContextSourceReport, ContextUsed } from '../schemas/outputs.js';

import { getContextBudget } from '../config.js';
import type { PublicJobName } from '../public-contract.js';
import type { TranscriptEntry } from '../sessions.js';
import { logger } from './logger.js';
import { estimateTokens, scanRootForFiles } from './workspace-context.js';

export interface ContextRequest {
  message: string;
  sessionId?: string;
  cacheName?: string;
  tool: PublicJobName;
  roots: string[];
}

export interface ContextSource extends ContextSourceReport {
  relevanceScore: number;
}

export interface ContextPack {
  systemInstructionPrefix: string;
  sources: ContextSource[];
  totalTokens: number;
  workspaceCacheName?: string;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const STATIC_PRIORITY_FILES = new Map<string, number>([
  ['readme.md', 0.2],
  ['package.json', 0.2],
  ['agents.md', 0.15],
  ['tsconfig.json', 0.1],
  ['copilot-instructions.md', 0.15],
]);

const SESSION_SUMMARY_BUDGET = 500;
const SUMMARY_ENTRY_MAX_CHARS = 200;

const log = logger.child('context-assembler');

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_./\\:;,!?'"()[\]{}-]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

function filenameScore(fileName: string, keywords: readonly string[]): number {
  const nameLower = fileName.toLowerCase();
  const nameWithoutExt = nameLower.replace(/\.[^.]+$/, '');
  const nameParts = nameWithoutExt.split(/[-_.]/);

  let matches = 0;
  for (const keyword of keywords) {
    if (nameLower.includes(keyword) || nameParts.some((part) => part === keyword)) {
      matches += 1;
    }
  }

  return Math.min(0.4, matches * 0.2);
}

function contentKeywordScore(content: string, keywords: readonly string[]): number {
  const contentLower = content.toLowerCase();
  let matches = 0;

  for (const keyword of keywords) {
    if (contentLower.includes(keyword)) {
      matches += 1;
    }
  }

  return Math.min(0.4, (matches / Math.max(keywords.length, 1)) * 0.4);
}

function staticPriority(fileName: string): number {
  return STATIC_PRIORITY_FILES.get(fileName.toLowerCase()) ?? 0.05;
}

export function scoreFile(fileName: string, content: string, keywords: readonly string[]): number {
  return (
    filenameScore(fileName, keywords) +
    contentKeywordScore(content, keywords) +
    staticPriority(fileName)
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
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

interface ScoredFile {
  content: string;
  fileName: string;
  score: number;
  tokens: number;
}

export async function assembleContext(request: ContextRequest): Promise<ContextPack> {
  const budget = getContextBudget();
  const keywords = extractKeywords(request.message);
  const sources: ContextSource[] = [];
  const prefixParts: string[] = [];
  const scored: ScoredFile[] = [];
  let totalTokens = 0;

  for (const root of request.roots) {
    try {
      const files = await scanRootForFiles(root);
      for (const [filePath, content] of files) {
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
        const score = scoreFile(fileName, content, keywords);
        const tokens = estimateTokens(content);
        scored.push({ content, fileName, score, tokens });
      }
    } catch {
      log.warn(`Failed to scan root: ${root}`);
    }
  }

  scored.sort(
    (left, right) => right.score - left.score || left.fileName.localeCompare(right.fileName),
  );

  for (const file of scored) {
    if (totalTokens + file.tokens > budget) {
      continue;
    }
    totalTokens += file.tokens;
    sources.push({
      kind: 'workspace-file',
      name: file.fileName,
      tokens: file.tokens,
      relevanceScore: file.score,
    });
    prefixParts.push(`### ${file.fileName}\n\n${file.content}`);
  }

  return {
    systemInstructionPrefix:
      prefixParts.length > 0 ? `# Workspace Context\n\n${prefixParts.join('\n\n')}` : '',
    sources,
    totalTokens,
  };
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
