import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getAI, MODEL } from '../client.js';
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
const WORKSPACE_CACHE_DISPLAY = 'gemini-assistant-workspace';

const SCAN_FILE_NAMES = new Set([
  'readme.md',
  'readme.txt',
  'readme',
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
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
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_SCAN_FILE_SIZE) return undefined;
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

function formatContextMarkdown(
  contextFileContent: string | undefined,
  scannedFiles: Map<string, string>,
): string {
  const sections: string[] = ['# Workspace Context\n'];

  if (contextFileContent) {
    sections.push('## Project Context\n');
    sections.push(contextFileContent);
    sections.push('');
  }

  if (scannedFiles.size > 0) {
    sections.push('## Workspace Files\n');
    for (const [filePath, content] of scannedFiles) {
      const name = basename(filePath);
      sections.push(`### ${name}\n`);
      sections.push('```');
      sections.push(content);
      sections.push('```\n');
    }
  }

  return sections.join('\n');
}

export async function assembleWorkspaceContext(roots: string[]): Promise<WorkspaceContextResult> {
  const sources: string[] = [];
  let contextFileContent: string | undefined;

  const contextFilePath = getWorkspaceContextFile();
  if (contextFilePath) {
    contextFileContent = await tryReadFile(contextFilePath);
    if (contextFileContent) {
      sources.push(contextFilePath);
    }
  }

  const scannedFiles = new Map<string, string>();
  if (getWorkspaceAutoScan()) {
    for (const root of roots) {
      const files = await scanRootForFiles(root);
      for (const [filePath, content] of files) {
        scannedFiles.set(filePath, content);
        sources.push(filePath);
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

  async getOrCreateCache(roots: string[], signal?: AbortSignal): Promise<string | undefined> {
    if (!getWorkspaceCacheEnabled()) return undefined;

    if (this.cacheName) {
      const ctx = await assembleWorkspaceContext(roots);
      const newHash = hashContent(ctx.content);
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
              systemInstruction:
                'You have workspace context loaded. Use it to inform your responses about the project.',
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
