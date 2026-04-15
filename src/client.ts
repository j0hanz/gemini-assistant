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
import { pickDefined } from './lib/response.js';

// ── Config Utilities ──────────────────────────────────────────────────

export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type AskThinkingLevel = (typeof THINKING_LEVELS)[number];

export function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const DEFAULT_SYSTEM_INSTRUCTION =
  'Provide direct, accurate answers. Use Markdown for structure. Be concise.';

export interface ConfigBuilderOptions {
  systemInstruction?: string | undefined;
  thinkingLevel?: AskThinkingLevel | undefined;
  cacheName?: string | undefined;
  responseSchema?: Record<string, unknown> | undefined;
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
    includeThoughts: true,
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
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

  // functionCallingMode intentionally overrides toolConfig.functionCallingConfig.mode
  const mergedToolConfig: ToolConfig | undefined =
    (toolConfig ?? functionCallingMode)
      ? {
          ...toolConfig,
          ...(functionCallingMode
            ? {
                functionCallingConfig: {
                  ...toolConfig?.functionCallingConfig,
                  mode: functionCallingMode,
                },
              }
            : {}),
        }
      : undefined;

  return {
    ...(cacheName ? { cachedContent: cacheName } : {}),
    ...(cacheName ? {} : { systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION }),
    ...(isJson
      ? {
          responseMimeType: 'application/json',
          ...(responseSchema ? { responseSchema } : {}),
        }
      : { thinkingConfig: buildThinkingConfig(thinkingLevel) }),
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

export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';

let _ai: GoogleGenAI | undefined;

/** Lazily initialised Gemini client – throws only when first accessed. */
export function getAI(): GoogleGenAI {
  if (!_ai) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      throw new Error('API_KEY environment variable is required');
    }
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
