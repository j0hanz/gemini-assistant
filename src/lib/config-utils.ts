import type { GenerateContentConfig, ThinkingLevel } from '@google/genai';

export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type AskThinkingLevel = (typeof THINKING_LEVELS)[number];

const DEFAULT_SYSTEM_INSTRUCTION =
  'Provide direct, accurate answers. Use Markdown for structure. Be concise.';

export interface ConfigBuilderOptions {
  systemInstruction?: string | undefined;
  thinkingLevel?: AskThinkingLevel | undefined;
  cacheName?: string | undefined;
  responseSchema?: Record<string, unknown> | undefined;
  jsonMode?: boolean | undefined;
  maxOutputTokens?: number | undefined;
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
  } = options;
  const isJson = jsonMode ?? responseSchema !== undefined;

  return {
    ...(cacheName ? { cachedContent: cacheName } : {}),
    ...(cacheName ? {} : { systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION }),
    // Structured output (responseSchema/jsonMode) is incompatible with thinking — omit thinkingConfig when JSON mode is active
    ...(isJson
      ? {
          responseMimeType: 'application/json',
          ...(responseSchema ? { responseSchema } : {}),
        }
      : { thinkingConfig: buildThinkingConfig(thinkingLevel) }),
    maxOutputTokens,
    ...(signal ? { abortSignal: signal } : {}),
  };
}
