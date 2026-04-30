import type {
  FunctionCallingConfigMode,
  GenerateContentConfig,
  SafetySetting,
  ToolConfig,
  ToolListUnion,
} from '@google/genai';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import type { GeminiResponseSchema } from './schemas/inputs.js';

import {
  getApiKey,
  getExposeThoughts,
  getMaxOutputTokens,
  getSafetySettings,
  getThinkingBudgetCap,
} from './config.js';
import type { AskThinkingLevel } from './public-contract.js';

// ── Config Utilities ──────────────────────────────────────────────────

const DEFAULT_TOOL_COST_PROFILES = {
  chat: { thinkingLevel: 'LOW', maxOutputTokens: 2_048 },
  'research.quick': { thinkingLevel: 'LOW', maxOutputTokens: 4_096 },
  'research.deep.plan': { thinkingLevel: 'MINIMAL', maxOutputTokens: 1_024 },
  'research.deep.retrieval': { thinkingLevel: 'LOW', maxOutputTokens: 2_048 },
  'research.deep.synthesis': { thinkingLevel: 'MEDIUM', maxOutputTokens: 6_144 },
  'research.deep.contradiction': { thinkingLevel: 'LOW', maxOutputTokens: 1_024 },
  'analyze.summary': { thinkingLevel: 'LOW', maxOutputTokens: 4_096 },
  'analyze.diagram': { thinkingLevel: 'LOW', maxOutputTokens: 8_192 },
  'review.diff': { thinkingLevel: 'LOW', maxOutputTokens: 4_096 },
  'review.comparison': { thinkingLevel: 'LOW', maxOutputTokens: 4_096 },
  'review.failure': { thinkingLevel: 'LOW', maxOutputTokens: 4_096 },
  'chat.jsonRepair': { thinkingLevel: 'MINIMAL', maxOutputTokens: 2_048 },
} as const satisfies Record<string, { thinkingLevel: AskThinkingLevel; maxOutputTokens: number }>;

type ToolCostProfileName = keyof typeof DEFAULT_TOOL_COST_PROFILES;

const THINKING_LEVEL_MAP: Record<AskThinkingLevel, ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

export const DEFAULT_SYSTEM_INSTRUCTION =
  'Use a table when content has 2+ attributes per item. Use bullets for 3–7 homogeneous items. Use prose for narrative.\n' +
  'Start sections at ##. Use ### for sub-sections. Never use #.\n' +
  'Cite web sources as [title](url). Cite code as `path:line`. Collect URLs in ## Sources when 2+ cited.\n' +
  'No opening filler. No trailing restatements. No unsolicited caveats.';

interface ConfigBuilderOptions {
  costProfile?: string | undefined;
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

const clientLog = logger.child('client');
interface SafetySettingInput {
  category: NonNullable<SafetySetting['category']>;
  method?: NonNullable<SafetySetting['method']> | undefined;
  threshold: NonNullable<SafetySetting['threshold']>;
}

function buildMergedToolConfig(
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
  const budgetCap = getThinkingBudgetCap();
  const resolvedThinkingBudget =
    thinkingBudget !== undefined && thinkingBudget > budgetCap ? budgetCap : thinkingBudget;
  if (thinkingBudget !== undefined && resolvedThinkingBudget !== thinkingBudget) {
    clientLog.warn('Clamped Gemini thinkingBudget to configured cap', {
      requestedThinkingBudget: thinkingBudget,
      thinkingBudgetCap: budgetCap,
    });
  }

  // NEW: warn when thinkingLevel wins over an explicitly supplied thinkingBudget
  if (thinkingLevel !== undefined && thinkingBudget !== undefined) {
    clientLog.warn('thinkingLevel takes precedence over thinkingBudget; budget ignored', {
      thinkingLevel,
      thinkingBudget,
    });
  }

  return {
    ...(getExposeThoughts() ? { includeThoughts: true } : {}),
    // Gemini 3 precedence: thinkingLevel wins over thinkingBudget; see .github/google-genai-api.md §7.
    ...(thinkingLevel ? { thinkingLevel: THINKING_LEVEL_MAP[thinkingLevel] } : {}),
    ...(thinkingLevel === undefined && resolvedThinkingBudget !== undefined
      ? { thinkingBudget: resolvedThinkingBudget }
      : {}),
  };
}

function normalizeSafetySettings(
  safetySettings: readonly (SafetySetting | SafetySettingInput)[] | undefined,
): SafetySetting[] | undefined {
  if (!safetySettings) {
    return undefined;
  }

  return safetySettings.map((setting) => {
    if (setting.category === undefined || setting.threshold === undefined) {
      throw new AppError(
        'client',
        'safetySettings entries require category and threshold.',
        'client',
      );
    }

    return {
      category: setting.category,
      threshold: setting.threshold,
      ...(setting.method !== undefined ? { method: setting.method } : {}),
    };
  });
}

function resolveCostProfile(costProfile: string | undefined) {
  if (costProfile === undefined) {
    return undefined;
  }
  if (costProfile in DEFAULT_TOOL_COST_PROFILES) {
    return DEFAULT_TOOL_COST_PROFILES[costProfile as ToolCostProfileName];
  }
  throw new AppError('client', `Unknown Gemini cost profile: ${costProfile}`, 'client');
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
    systemInstruction: systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION,
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
    costProfile,
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
  const profile = resolveCostProfile(costProfile);
  const resolvedThinkingLevel =
    thinkingLevel ?? (thinkingBudget === undefined ? profile?.thinkingLevel : undefined);
  const resolvedMaxOutputTokens =
    maxOutputTokens ?? profile?.maxOutputTokens ?? getMaxOutputTokens();
  const mergedToolConfig = buildMergedToolConfig(toolConfig, functionCallingMode);
  const isJson = jsonMode ?? responseSchema !== undefined;
  const resolvedSafetySettings = normalizeSafetySettings(safetySettings ?? getSafetySettings());

  return {
    ...buildResponseConfig(
      cacheName,
      systemInstruction,
      isJson,
      responseSchema,
      resolvedThinkingLevel,
      thinkingBudget,
    ),
    maxOutputTokens: resolvedMaxOutputTokens,
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

class GeminiClientHolder {
  private ai: GoogleGenAI | undefined;

  get(): GoogleGenAI {
    if (!this.ai) {
      const apiKey = getApiKey();
      this.ai = new GoogleGenAI({ apiKey });
    }

    return this.ai;
  }
}

const geminiClientHolder = new GeminiClientHolder();

/** Lazily initialized Gemini client - throws only when first accessed. */
export function getAI(): GoogleGenAI {
  return geminiClientHolder.get();
}
