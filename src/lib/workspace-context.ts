import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { DEFAULT_SYSTEM_INSTRUCTION, getAI, MODEL } from '../client.js';
import {
  getWorkspaceAutoScan,
  getWorkspaceCacheEnabled,
  getWorkspaceCacheTtl,
  getWorkspaceContextFile,
} from '../config.js';
import { withRetry } from './errors.js';
import { logger } from './logger.js';

// ── Constants ─────────────────────────────────────────────────────────

export const MIN_CACHE_TOKENS = 32_000;
const TOKENS_PER_CHAR = 4;
const MAX_SCAN_FILE_SIZE = 512 * 1024;
const MAX_TOTAL_CONTEXT_SIZE = 2 * 1024 * 1024;
const WORKSPACE_CACHE_DISPLAY = 'gemini-assistant-workspace';
const HASH_CHECK_INTERVAL_MS = 30_000;

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

export interface WorkspaceContextResult {
  content: string;
  fileCount: number;
  estimatedTokens: number;
  sources: string[];
}

export interface WorkspaceCacheStatus {
  enabled: boolean;
  cacheName: string | undefined;
  contentHash: string | undefined;
  estimatedTokens: number | undefined;
  sources: string[];
  createdAt: number | undefined;
  ttl: string;
}

type CacheChangeCallback = (status: WorkspaceCacheStatus) => void;

// ── Utilities ─────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKENS_PER_CHAR);
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

async function scanRootForFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!SCAN_FILE_NAMES.has(entry.name.toLowerCase())) continue;
      const filePath = join(root, entry.name);
      const content = await tryReadFile(filePath);
      if (content) {
        files.set(filePath, content);
      }
    }
  } catch {
    logger.warn('workspace', `Failed to scan root: ${root}`);
  }
  return files;
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

export async function assembleWorkspaceContext(roots: string[]): Promise<WorkspaceContextResult> {
  const validRoots = roots.filter((r) => r && isAbsolute(r));
  const sources: string[] = [];
  let totalSize = 0;
  let contextFileContent: string | undefined;

  const contextFilePath = getWorkspaceContextFile();
  if (contextFilePath && isAbsolute(contextFilePath)) {
    contextFileContent = await tryReadFile(contextFilePath);
    if (contextFileContent) {
      totalSize += contextFileContent.length;
      sources.push(contextFilePath);
    }
  }

  const scannedFiles = new Map<string, string>();
  if (getWorkspaceAutoScan()) {
    for (const root of validRoots) {
      const files = await scanRootForFiles(root);
      for (const [filePath, content] of files) {
        if (totalSize + content.length > MAX_TOTAL_CONTEXT_SIZE) {
          logger.warn(
            'workspace',
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

let onChangeCallback: CacheChangeCallback | undefined;

export function onWorkspaceCacheChange(callback: CacheChangeCallback): void {
  onChangeCallback = callback;
}

class WorkspaceCacheManagerImpl {
  private cacheName: string | undefined;
  private contentHash: string | undefined;
  private estimatedTokens: number | undefined;
  private sources: string[] = [];
  private createdAt: number | undefined;
  private creating = false;
  private lastHashCheck: number | undefined;

  async getOrCreateCache(roots: string[], signal?: AbortSignal): Promise<string | undefined> {
    if (!getWorkspaceCacheEnabled()) return undefined;

    if (this.cacheName) {
      if (this.lastHashCheck && Date.now() - this.lastHashCheck < HASH_CHECK_INTERVAL_MS) {
        return this.cacheName;
      }
      const ctx = await assembleWorkspaceContext(roots);
      const newHash = hashContent(ctx.content);
      this.lastHashCheck = Date.now();
      if (newHash === this.contentHash) {
        return this.cacheName;
      }
      logger.info('workspace', 'Workspace content changed, recreating cache');
      this.invalidate();
    }

    if (this.creating) return undefined;

    return this.createCache(roots, signal);
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
    this.cacheName = undefined;
    this.contentHash = undefined;
    this.estimatedTokens = undefined;
    this.sources = [];
    this.createdAt = undefined;
    this.lastHashCheck = undefined;
    this.emitChange();
  }

  private async createCache(roots: string[], signal?: AbortSignal): Promise<string | undefined> {
    this.creating = true;
    try {
      const ctx = await assembleWorkspaceContext(roots);

      if (ctx.estimatedTokens < MIN_CACHE_TOKENS) {
        logger.warn(
          'workspace',
          `Workspace context too small for caching (${ctx.estimatedTokens} tokens, need ${MIN_CACHE_TOKENS})`,
        );
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

      this.cacheName = cache.name;
      this.contentHash = hashContent(ctx.content);
      this.estimatedTokens = ctx.estimatedTokens;
      this.sources = ctx.sources;
      this.createdAt = Date.now();

      logger.info('workspace', `Workspace cache created: ${cache.name}`);
      this.emitChange();

      return this.cacheName;
    } catch (err) {
      logger.error('workspace', `Failed to create workspace cache: ${String(err)}`);
      return undefined;
    } finally {
      this.creating = false;
    }
  }

  private emitChange(): void {
    onChangeCallback?.(this.getCacheStatus());
  }
}

export const workspaceCacheManager = new WorkspaceCacheManagerImpl();
