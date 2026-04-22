import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import type { ContextSourceReport, ContextUsed } from '../schemas/outputs.js';

import { DEFAULT_SYSTEM_INSTRUCTION, getAI, MODEL } from '../client.js';
import {
  getWorkspaceAutoScan,
  getWorkspaceCacheEnabled,
  getWorkspaceCacheTtl,
  getWorkspaceContextFile,
} from '../config.js';
import type { TranscriptEntry } from '../sessions.js';
import { isAbortError, withRetry } from './errors.js';
import { logger } from './logger.js';
import { isPathWithinRoot, normalizePathForComparison } from './validation.js';

const TOKENS_PER_CHAR = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKENS_PER_CHAR);
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

// ── Constants ─────────────────────────────────────────────────────────

export const MIN_CACHE_TOKENS = 32_000;
const MAX_SCAN_FILE_SIZE = 512 * 1024;
const MAX_TOTAL_CONTEXT_SIZE = 2 * 1024 * 1024;
const WORKSPACE_CACHE_DISPLAY = 'gemini-assistant-workspace';
const HASH_CHECK_INTERVAL_MS = 30_000;
const log = logger.child('workspace');

const SCAN_FILE_NAMES = new Set([
  'readme.md',
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'agents.md',
  'claude.md',
  '.cursorrules',
  'copilot-instructions.md',
]);

// ── Types ─────────────────────────────────────────────────────────────

interface WorkspaceContextResult {
  content: string;
  fileCount: number;
  estimatedTokens: number;
  sources: string[];
}

interface WorkspaceDashboardRootSummary {
  fileCount: number;
  fileNames: string[];
}

interface WorkspaceCacheStatus {
  enabled: boolean;
  cacheName: string | undefined;
  contentHash: string | undefined;
  estimatedTokens: number | undefined;
  sources: string[];
  createdAt: number | undefined;
  ttl: string;
}

function normalizeRootsKey(roots: readonly string[]): string {
  const key = [
    ...new Set(roots.filter((root) => root && isAbsolute(root)).map(normalizePathForComparison)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .join('\n');

  if (key.length === 0 && roots.length > 0) {
    log.warn('Workspace roots were filtered out while building the cache key');
  }

  return key;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function tryReadFile(filePath: string): Promise<string | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SCAN_FILE_SIZE) return undefined;
    return await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

// ── Context Assembly ──────────────────────────────────────────────────

async function listScanFileNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && SCAN_FILE_NAMES.has(entry.name.toLowerCase()))
      .map((entry) => entry.name);
  } catch {
    log.warn(`Failed to scan root: ${root}`);
    return [];
  }
}

async function scanRootForFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await listScanFileNames(root)) {
    const filePath = join(root, name);
    const content = await tryReadFile(filePath);
    if (content) {
      files.set(filePath, content);
    }
  }
  return files;
}

export async function summarizeRootForDashboard(
  root: string,
): Promise<WorkspaceDashboardRootSummary> {
  const fileNames = (await listScanFileNames(root)).sort((a, b) => a.localeCompare(b));
  return {
    fileCount: fileNames.length,
    fileNames,
  };
}

function dynamicFence(content: string): string {
  const matches = content.match(/`+/g);
  const maxLen = matches ? Math.max(...matches.map((m) => m.length)) : 0;
  return '`'.repeat(Math.max(3, maxLen + 1));
}

function formatContextMarkdown(
  contextFileContent: string | undefined,
  scannedFiles: Map<string, string>,
): string {
  const sections: string[] = ['# Workspace Context\n'];

  if (contextFileContent) {
    sections.push('## Project Context\n');
    const fence = dynamicFence(contextFileContent);
    sections.push(fence);
    sections.push(contextFileContent);
    sections.push(`${fence}\n`);
  }

  if (scannedFiles.size > 0) {
    sections.push('## Workspace Files\n');
    for (const [filePath, content] of scannedFiles) {
      const name = basename(filePath);
      const fence = dynamicFence(content);
      sections.push(`### ${name}\n`);
      sections.push(fence);
      sections.push(content);
      sections.push(`${fence}\n`);
    }
  }

  return sections.join('\n');
}

async function tryLoadContextFile(
  contextFilePath: string | undefined,
  validRoots: string[],
): Promise<{ content?: string; path?: string }> {
  if (
    contextFilePath &&
    isAbsolute(contextFilePath) &&
    validRoots.some((root) => isPathWithinRoot(contextFilePath, root))
  ) {
    const content = await tryReadFile(contextFilePath);
    if (content) return { content, path: contextFilePath };
  }
  return {};
}

export async function assembleWorkspaceContext(
  roots: string[],
  focusText?: string,
): Promise<WorkspaceContextResult> {
  const validRoots = roots.filter((r) => r && isAbsolute(r));
  const keywords = focusText ? extractKeywords(focusText) : [];
  const sources: string[] = [];
  let totalSize = 0;

  const { content: contextFileContent, path: loadedContextPath } = await tryLoadContextFile(
    getWorkspaceContextFile(),
    validRoots,
  );

  if (contextFileContent && loadedContextPath) {
    totalSize += contextFileContent.length;
    sources.push(loadedContextPath);
  }

  const scannedFiles = new Map<string, string>();
  if (getWorkspaceAutoScan()) {
    for (const root of validRoots) {
      const files = await scanRootForFiles(root);
      const candidates =
        keywords.length > 0
          ? [...files.entries()].sort(
              ([leftPath, leftContent], [rightPath, rightContent]) =>
                scoreFile(basename(rightPath), rightContent, keywords) -
                scoreFile(basename(leftPath), leftContent, keywords),
            )
          : files.entries();

      for (const [filePath, content] of candidates) {
        if (totalSize + content.length > MAX_TOTAL_CONTEXT_SIZE) {
          log.warn(
            `Total context size limit reached (${MAX_TOTAL_CONTEXT_SIZE} bytes), skipping remaining files`,
          );
          break;
        }
        scannedFiles.set(filePath, content);
        sources.push(filePath);
        totalSize += content.length;
      }
    }
  }

  const content = formatContextMarkdown(contextFileContent, scannedFiles);
  const estimatedTokensCount = estimateTokens(content);

  return {
    content,
    fileCount: sources.length,
    estimatedTokens: estimatedTokensCount,
    sources,
  };
}

// ── Cache Lifecycle Manager ───────────────────────────────────────────

export class WorkspaceCacheManagerImpl {
  private activeRootsKey: string | undefined;
  private cacheName: string | undefined;
  private contentHash: string | undefined;
  private estimatedTokens: number | undefined;
  private sources: string[] = [];
  private createdAt: number | undefined;
  private inflightCreation: Promise<string | undefined> | undefined;
  private lastHashCheck: number | undefined;
  private generation = 0;

  private async checkAndRefreshExistingCache(
    rootsKey: string,
    roots: string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (this.lastHashCheck && Date.now() - this.lastHashCheck < HASH_CHECK_INTERVAL_MS) {
      return this.cacheName;
    }
    const ctx = await assembleWorkspaceContext(roots);
    const newHash = hashContent(ctx.content);
    this.lastHashCheck = Date.now();
    if (newHash === this.contentHash) {
      return this.cacheName;
    }
    log.info('Workspace content changed, recreating cache');
    return await this.refreshCache(ctx, rootsKey, signal);
  }

  async getOrCreateCache(roots: string[], signal?: AbortSignal): Promise<string | undefined> {
    if (!getWorkspaceCacheEnabled()) return undefined;

    const rootsKey = normalizeRootsKey(roots);

    if (this.cacheName && this.activeRootsKey !== rootsKey) {
      const previousCacheName = this.cacheName;
      this.invalidate();
      await this.deleteCacheBestEffort(previousCacheName, signal);
    }

    if (this.cacheName) {
      return await this.checkAndRefreshExistingCache(rootsKey, roots, signal);
    }

    if (this.inflightCreation) {
      return await this.inflightCreation;
    }

    const creation = this.createCache(roots, rootsKey, signal);
    this.inflightCreation = creation;
    try {
      return await creation;
    } finally {
      if (this.inflightCreation === creation) {
        this.inflightCreation = undefined;
      }
    }
  }

  async close(): Promise<void> {
    try {
      if (this.inflightCreation) {
        await this.inflightCreation.catch(() => undefined);
      }
    } finally {
      this.invalidate();
    }
  }

  getCacheStatus(): WorkspaceCacheStatus {
    return {
      enabled: getWorkspaceCacheEnabled(),
      cacheName: this.cacheName,
      contentHash: this.contentHash,
      estimatedTokens: this.estimatedTokens,
      sources: [...this.sources],
      createdAt: this.createdAt,
      ttl: getWorkspaceCacheTtl(),
    };
  }

  invalidate(): void {
    this.generation++;
    this.activeRootsKey = undefined;
    this.cacheName = undefined;
    this.contentHash = undefined;
    this.estimatedTokens = undefined;
    this.sources = [];
    this.createdAt = undefined;
    this.lastHashCheck = undefined;
  }

  private isBelowCacheThreshold(estimatedTokens: number): boolean {
    if (estimatedTokens >= MIN_CACHE_TOKENS) {
      return false;
    }
    log.warn(
      `Workspace context too small for caching (${estimatedTokens} tokens, need ${MIN_CACHE_TOKENS})`,
    );
    return true;
  }

  private async createCache(
    roots: string[],
    rootsKey: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const ctx = await assembleWorkspaceContext(roots);
    return await this.createCacheFromContext(ctx, rootsKey, signal);
  }

  private async refreshCache(
    ctx: WorkspaceContextResult,
    rootsKey: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (this.inflightCreation) {
      return await this.inflightCreation;
    }

    const refresh = (async () => {
      const previousCacheName = this.cacheName;

      if (this.isBelowCacheThreshold(ctx.estimatedTokens)) {
        this.invalidate();
        if (previousCacheName) {
          await this.deleteCacheBestEffort(previousCacheName, signal);
        }
        return undefined;
      }

      const replacementCacheName = await this.createCacheFromContext(ctx, rootsKey, signal);
      if (!replacementCacheName) {
        return previousCacheName;
      }
      if (replacementCacheName && previousCacheName && previousCacheName !== replacementCacheName) {
        await this.deleteCacheBestEffort(previousCacheName, signal);
      }
      return replacementCacheName;
    })();

    this.inflightCreation = refresh;
    try {
      return await refresh;
    } finally {
      if (this.inflightCreation === refresh) {
        this.inflightCreation = undefined;
      }
    }
  }

  private async createCacheFromContext(
    ctx: WorkspaceContextResult,
    rootsKey: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const gen = this.generation;
    try {
      if (this.isBelowCacheThreshold(ctx.estimatedTokens)) {
        return undefined;
      }

      const ttl = getWorkspaceCacheTtl();

      const cache = await withRetry(
        () =>
          getAI().caches.create({
            model: MODEL,
            config: {
              contents: [{ role: 'user' as const, parts: [{ text: ctx.content }] }],
              systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
              displayName: WORKSPACE_CACHE_DISPLAY,
              ttl,
              ...(signal ? { abortSignal: signal } : {}),
            },
          }),
        ...(signal ? [{ signal }] : []),
      );

      if (gen !== this.generation) {
        log.info('Cache creation completed but invalidated mid-flight, discarding');
        if (cache.name) {
          await this.deleteCacheBestEffort(cache.name, signal);
        }
        return undefined;
      }

      this.cacheName = cache.name;
      this.activeRootsKey = rootsKey;
      this.contentHash = hashContent(ctx.content);
      this.estimatedTokens = ctx.estimatedTokens;
      this.sources = ctx.sources;
      this.createdAt = Date.now();

      log.info(`Workspace cache created: ${cache.name}`);

      return this.cacheName;
    } catch (err) {
      if (isAbortError(err, signal)) {
        throw err;
      }

      log.error(`Failed to create workspace cache: ${String(err)}`);
      return undefined;
    }
  }

  private async deleteCacheBestEffort(cacheName: string, signal?: AbortSignal): Promise<void> {
    if (!cacheName) {
      return;
    }

    try {
      await getAI().caches.delete({
        name: cacheName,
        ...(signal ? { config: { abortSignal: signal } } : {}),
      });
    } catch (err) {
      log.warn(`Failed to delete workspace cache ${cacheName}: ${String(err)}`);
    }
  }
}

export function createWorkspaceCacheManager(): WorkspaceCacheManagerImpl {
  return new WorkspaceCacheManagerImpl();
}

export const workspaceCacheManager = createWorkspaceCacheManager();
