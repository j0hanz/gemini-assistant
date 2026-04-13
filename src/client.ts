import { GoogleGenAI } from '@google/genai';

import { pickDefined } from './lib/response.js';

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
}

function toCacheSummary(cache: CacheSummary): CacheSummary {
  return pickDefined({
    name: cache.name,
    displayName: cache.displayName,
    model: cache.model,
    expireTime: cache.expireTime,
  }) as CacheSummary;
}

export async function listCacheSummaries(signal?: AbortSignal): Promise<CacheSummary[]> {
  const caches: CacheSummary[] = [];
  const pager = await ai.caches.list();
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
