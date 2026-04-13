import type { CachedContent } from '@google/genai';
import { GoogleGenAI } from '@google/genai';

import { pickDefined } from './lib/response.js';
import { withRetry } from './lib/retry.js';

const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY environment variable is required');
}

export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';

export const ai = new GoogleGenAI({ apiKey });

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
  }) as CacheSummary;
}

export async function getCacheSummary(name: string, signal?: AbortSignal): Promise<CacheSummary> {
  const cache = await withRetry(
    () =>
      ai.caches.get({
        name,
        ...(signal ? { config: { abortSignal: signal } } : {}),
      }),
    ...(signal ? [{ signal }] : []),
  );
  return toCacheSummary(cache);
}

export async function listCacheSummaries(signal?: AbortSignal): Promise<CacheSummary[]> {
  const caches: CacheSummary[] = [];
  const pager = await withRetry(() => ai.caches.list(), ...(signal ? [{ signal }] : []));
  for await (const cache of pager) {
    if (signal?.aborted) break;
    caches.push(toCacheSummary(cache));
  }
  return caches;
}

export async function listCacheNames(prefix?: string, signal?: AbortSignal): Promise<string[]> {
  return (await listCacheSummaries(signal))
    .map((cache) => cache.name)
    .filter((name): name is string => name?.startsWith(prefix ?? '') === true);
}

export async function completeCacheNames(prefix?: string): Promise<string[]> {
  try {
    return await listCacheNames(prefix);
  } catch {
    return [];
  }
}
