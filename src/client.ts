import type {
  GenerateContentConfig,
  MediaResolution,
  ToolConfig,
  ToolListUnion,
} from '@google/genai';
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel } from '@google/genai';

import type { GeminiResponseSchema } from './schemas/json-schema.js';

import { getApiKey, getExposeThoughts, getGeminiModel } from './config.js';

// ── Config Utilities ──────────────────────────────────────────────────

export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export const DEFAULT_THINKING_LEVEL = 'MEDIUM' as const;
export const DEFAULT_TEMPERATURE = 1.0;
type AskThinkingLevel = (typeof THINKING_LEVELS)[number];
export const EXPOSE_THOUGHTS = getExposeThoughts();

const THINKING_LEVEL_MAP: Record<AskThinkingLevel, ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

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
    ...(thinkingLevel ? { thinkingLevel: THINKING_LEVEL_MAP[thinkingLevel] } : {}),
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
