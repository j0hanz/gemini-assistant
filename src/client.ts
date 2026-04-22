import type {
  FunctionCallingConfigMode,
  GenerateContentConfig,
  SafetySetting,
  ToolConfig,
  ToolListUnion,
} from '@google/genai';
import { GoogleGenAI, HarmBlockThreshold, ThinkingLevel } from '@google/genai';

import type { SafetySettingInput } from './schemas/fragments.js';
import type { GeminiResponseSchema } from './schemas/json-schema.js';

import {
  getApiKey,
  getExposeThoughts,
  getGeminiModel,
  getMaxOutputTokens,
  getSafetySettings,
} from './config.js';

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
  thinkingBudget?: number | undefined;
  cacheName?: string | undefined;
  responseSchema?: GeminiResponseSchema | undefined;
  jsonMode?: boolean | undefined;
  maxOutputTokens?: number | undefined;
  safetySettings?: SafetySettingInput[] | undefined;
  temperature?: number | undefined;
  seed?: number | undefined;
  mediaResolution?: GenerateContentConfig['mediaResolution'] | undefined;
  tools?: ToolListUnion | undefined;
  toolConfig?: ToolConfig | undefined;
  functionCallingMode?: FunctionCallingConfigMode | undefined;
}

export function buildMergedToolConfig(
  toolConfig: ToolConfig | undefined,
  functionCallingMode: FunctionCallingConfigMode | undefined,
): ToolConfig | undefined {
  if (functionCallingMode === undefined) {
    return toolConfig;
  }
  return {
    ...(toolConfig ?? {}),
    functionCallingConfig: {
      ...(toolConfig?.functionCallingConfig ?? {}),
      mode: functionCallingMode,
    },
  };
}

function buildThinkingConfig(thinkingLevel?: AskThinkingLevel, thinkingBudget?: number) {
  return {
    ...(EXPOSE_THOUGHTS ? { includeThoughts: true } : {}),
    ...(thinkingLevel ? { thinkingLevel: THINKING_LEVEL_MAP[thinkingLevel] } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
  };
}

function normalizeSafetySettings(
  safetySettings: readonly SafetySettingInput[] | readonly SafetySetting[] | undefined,
): SafetySetting[] | undefined {
  if (!safetySettings) {
    return undefined;
  }

  return safetySettings.map((setting) => ({
    ...(setting.category !== undefined ? { category: setting.category } : {}),
    ...(setting.method !== undefined ? { method: setting.method } : {}),
    threshold: setting.threshold ?? HarmBlockThreshold.BLOCK_ONLY_HIGH,
  })) as SafetySetting[];
}

function buildResponseConfig(
  cacheName: string | undefined,
  systemInstruction: string | undefined,
  isJson: boolean,
  responseSchema: GeminiResponseSchema | undefined,
  thinkingLevel: AskThinkingLevel | undefined,
  thinkingBudget: number | undefined,
) {
  const thinkingConfig = buildThinkingConfig(thinkingLevel, thinkingBudget);
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
    thinkingBudget,
    cacheName,
    responseSchema,
    jsonMode,
    maxOutputTokens,
    safetySettings,
    temperature,
    seed,
    mediaResolution,
    tools,
    toolConfig,
    functionCallingMode,
  } = options;
  const mergedToolConfig = buildMergedToolConfig(toolConfig, functionCallingMode);
  const isJson = jsonMode ?? responseSchema !== undefined;
  const resolvedSafetySettings = normalizeSafetySettings(safetySettings ?? getSafetySettings());

  return {
    ...buildResponseConfig(
      cacheName,
      systemInstruction,
      isJson,
      responseSchema,
      thinkingLevel,
      thinkingBudget,
    ),
    maxOutputTokens: maxOutputTokens ?? getMaxOutputTokens(),
    ...(resolvedSafetySettings ? { safetySettings: resolvedSafetySettings } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(mediaResolution ? { mediaResolution } : {}),
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
