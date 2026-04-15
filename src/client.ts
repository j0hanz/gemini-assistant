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
import type { GeminiResponseSchema } from './schemas/json-schema.js';

import { getExposeThoughts, getGeminiModel } from './config.js';

// ── Config Utilities ──────────────────────────────────────────────────

export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
type AskThinkingLevel = (typeof THINKING_LEVELS)[number];
export const EXPOSE_THOUGHTS = getExposeThoughts();

const DEFAULT_SYSTEM_INSTRUCTION = 'Be direct, accurate, and concise. Use Markdown when useful.';

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
  return {
    ...(cacheName ? { cachedContent: cacheName } : {}),
    ...(cacheName ? {} : { systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION }),
    ...(isJson
      ? {
          responseMimeType: 'application/json',
          ...(responseSchema ? { responseSchema } : {}),
        }
      : { thinkingConfig: buildThinkingConfig(thinkingLevel) }),
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

async function listCacheNames(prefix?: string, signal?: AbortSignal): Promise<string[]> {
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
