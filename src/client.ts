import type {
  GenerateContentConfig,
  MediaResolution,
  ThinkingLevel,
  ToolConfig,
  ToolListUnion,
} from '@google/genai';
import type { CachedContent } from '@google/genai';
import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';

import { withRetry } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { pickDefined } from './lib/response.js';
import type { GeminiResponseSchema } from './schemas/json-schema.js';

import { getApiKey, getExposeThoughts, getGeminiModel } from './config.js';

// ── Config Utilities ──────────────────────────────────────────────────

export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export const DEFAULT_THINKING_LEVEL = 'MEDIUM' as const;
export const DEFAULT_TEMPERATURE = 1.0;
type AskThinkingLevel = (typeof THINKING_LEVELS)[number];
export const EXPOSE_THOUGHTS = getExposeThoughts();
const log = logger.child('client');

export const DEFAULT_SYSTEM_INSTRUCTION =
  'Be direct, accurate, and concise. Use Markdown when useful.';

interface ConfigBuilderOptions {
  systemInstruction?: string | undefined;
  thinkingLevel?: AskThinkingLevel | undefined;
  cacheName?: string | undefined;
  responseSchema?: GeminiResponseSchema | undefined;
  jsonMode?: boolean | undefined;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  seed?: number | undefined;
  mediaResolution?: string | undefined;
  tools?: ToolListUnion | undefined;
  toolConfig?: ToolConfig | undefined;
  functionCallingMode?: FunctionCallingConfigMode | undefined;
}

function buildThinkingConfig(thinkingLevel?: AskThinkingLevel) {
  return {
    ...(EXPOSE_THOUGHTS ? { includeThoughts: true } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
  };
}

function buildMergedToolConfig(
  toolConfig: ToolConfig | undefined,
  functionCallingMode: FunctionCallingConfigMode | undefined,
): ToolConfig | undefined {
  if (!toolConfig && !functionCallingMode) {
    return undefined;
  }

  return {
    ...toolConfig,
    ...(functionCallingMode
      ? {
          functionCallingConfig: {
            ...toolConfig?.functionCallingConfig,
            mode: functionCallingMode,
          },
        }
      : {}),
  };
}

function buildResponseConfig(
  cacheName: string | undefined,
  systemInstruction: string | undefined,
  isJson: boolean,
  responseSchema: GeminiResponseSchema | undefined,
  thinkingLevel: AskThinkingLevel | undefined,
) {
  const thinkingConfig = buildThinkingConfig(thinkingLevel);
  return {
    ...(cacheName ? { cachedContent: cacheName } : {}),
    ...(cacheName ? {} : { systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION }),
    ...(Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {}),
    ...(isJson
      ? {
          responseMimeType: 'application/json',
          ...(responseSchema ? { responseJsonSchema: responseSchema } : {}),
        }
      : {}),
  };
}

export function buildGenerateContentConfig(
  options: ConfigBuilderOptions,
  signal?: AbortSignal,
): GenerateContentConfig {
  const {
    systemInstruction,
    thinkingLevel,
    cacheName,
    responseSchema,
    jsonMode,
    maxOutputTokens = 8192,
    temperature,
    seed,
    mediaResolution,
    tools,
    toolConfig,
    functionCallingMode,
  } = options;
  const isJson = jsonMode ?? responseSchema !== undefined;
  const mergedToolConfig = buildMergedToolConfig(toolConfig, functionCallingMode);

  return {
    ...buildResponseConfig(cacheName, systemInstruction, isJson, responseSchema, thinkingLevel),
    maxOutputTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(mediaResolution ? { mediaResolution: mediaResolution as MediaResolution } : {}),
    ...(tools ? { tools } : {}),
    ...(mergedToolConfig ? { toolConfig: mergedToolConfig } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  };
}

// ── Client ────────────────────────────────────────────────────────────

export const MODEL = getGeminiModel();

let _ai: GoogleGenAI | undefined;

/** Lazily initialized Gemini client - throws only when first accessed. */
export function getAI(): GoogleGenAI {
  if (!_ai) {
    const apiKey = getApiKey();
    _ai = new GoogleGenAI({ apiKey });
  }
  return _ai;
}

export interface CacheSummary {
  name?: string;
  displayName?: string;
  model?: string;
  expireTime?: string;
  createTime?: string;
  updateTime?: string;
  totalTokenCount?: number;
}

function toCacheSummary(cache: CachedContent): CacheSummary {
  return pickDefined({
    name: cache.name,
    displayName: cache.displayName,
    model: cache.model,
    expireTime: cache.expireTime,
    createTime: cache.createTime,
    updateTime: cache.updateTime,
    totalTokenCount: cache.usageMetadata?.totalTokenCount,
  });
}

export async function getCacheSummary(name: string, signal?: AbortSignal): Promise<CacheSummary> {
  const cache = await withRetry(
    () =>
      getAI().caches.get({
        name,
        ...(signal ? { config: { abortSignal: signal } } : {}),
      }),
    ...(signal ? [{ signal }] : []),
  );
  return toCacheSummary(cache);
}

export async function listCacheSummaries(signal?: AbortSignal): Promise<CacheSummary[]> {
  const caches: CacheSummary[] = [];
  const pager = await withRetry(() => getAI().caches.list(), ...(signal ? [{ signal }] : []));
  for await (const cache of pager) {
    if (signal?.aborted) break;
    caches.push(toCacheSummary(cache));
  }
  return caches;
}

async function listCacheNames(prefix?: string, signal?: AbortSignal): Promise<string[]> {
  const normalizedPrefix = prefix?.trim().toLowerCase() ?? '';
  const now = Date.now();

  return (await listCacheSummaries(signal))
    .filter((cache): cache is CacheSummary & { name: string } => typeof cache.name === 'string')
    .map((cache) => ({
      cache,
      freshnessRank: cacheFreshnessRank(cache.expireTime, now),
      matchRank: cacheMatchRank(cache, normalizedPrefix),
    }))
    .filter((entry) => normalizedPrefix === '' || entry.matchRank !== Number.POSITIVE_INFINITY)
    .sort((left, right) => {
      if (left.matchRank !== right.matchRank) {
        return left.matchRank - right.matchRank;
      }

      if (left.freshnessRank !== right.freshnessRank) {
        return left.freshnessRank - right.freshnessRank;
      }

      const leftLabel = cacheSortLabel(left.cache);
      const rightLabel = cacheSortLabel(right.cache);
      return leftLabel.localeCompare(rightLabel);
    })
    .map(({ cache }) => cache.name);
}

export async function completeCacheNames(prefix?: string): Promise<string[]> {
  try {
    return await listCacheNames(prefix);
  } catch (error) {
    log.debug('Failed to complete cache names', {
      error: error instanceof Error ? error.message : String(error),
      prefix,
    });
    return [];
  }
}

function cacheFreshnessRank(expireTime: string | undefined, now: number): number {
  if (!expireTime) {
    return 1;
  }

  const expiresAt = Date.parse(expireTime);
  if (Number.isNaN(expiresAt)) {
    return 1;
  }

  return expiresAt >= now ? 0 : 2;
}

function cacheSortLabel(cache: CacheSummary): string {
  return (cache.displayName ?? cache.name ?? '').toLowerCase();
}

function cacheMatchRank(cache: CacheSummary, normalizedPrefix: string): number {
  if (normalizedPrefix === '') {
    return 0;
  }

  const shortName = cache.name?.replace(/^cachedContents\//i, '') ?? '';
  const name = cache.name ?? '';
  const displayName = cache.displayName ?? '';
  const directCandidates = [name.toLowerCase(), shortName.toLowerCase()].filter(
    (value) => value.length > 0,
  );
  const labelCandidates = [displayName.toLowerCase()].filter((value) => value.length > 0);

  if (directCandidates.some((value) => value === normalizedPrefix)) {
    return 0;
  }

  if (directCandidates.some((value) => value.startsWith(normalizedPrefix))) {
    return 1;
  }

  if (labelCandidates.some((value) => value === normalizedPrefix)) {
    return 2;
  }

  if (labelCandidates.some((value) => value.startsWith(normalizedPrefix))) {
    return 3;
  }

  return Number.POSITIVE_INFINITY;
}
