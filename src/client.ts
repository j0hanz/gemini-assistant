import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY environment variable is required');
  process.exit(1);
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
  return {
    ...(cache.name !== undefined ? { name: cache.name } : {}),
    ...(cache.displayName !== undefined ? { displayName: cache.displayName } : {}),
    ...(cache.model !== undefined ? { model: cache.model } : {}),
    ...(cache.expireTime !== undefined ? { expireTime: cache.expireTime } : {}),
  };
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

export async function listCacheNames(prefix?: string): Promise<string[]> {
  return (await listCacheSummaries())
    .map((cache) => cache.name)
    .filter((name): name is string => name?.startsWith(prefix ?? '') === true);
}
