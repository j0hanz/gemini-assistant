import { setTimeout as delayAsync } from 'node:timers/promises';

import type { Interactions, Part } from '@google/genai';

import {
  DEFAULT_SYSTEM_INSTRUCTION,
  getAI,
  GROUNDING_SUFFIX,
  THINKING_LEVEL_MAP,
} from '../client.js';
import type { AskThinkingLevel } from '../public-contract.js';
import { AppError } from './errors.js';
import type { StreamResult } from './streaming.js';
import type { ResolvedProfile } from './tool-profiles.js';

const BUILT_IN_TO_INTERACTION_TOOL: Readonly<Record<string, Interactions.Tool>> = {
  googleSearch: { type: 'google_search' },
  urlContext: { type: 'url_context' },
  codeExecution: { type: 'code_execution' },
};

const POLL_INTERVAL_MS = 3_000;

// ── buildInteractionParams ────────────────────────────────────────────────────

interface BuildInteractionParamsOptions {
  profile: ResolvedProfile;
  model: string;
  prompt: string;
  thinkingLevel?: AskThinkingLevel | undefined;
  maxOutputTokens?: number | undefined;
  systemInstruction?: string | undefined;
  previousInteractionId?: string | undefined;
}

/**
 * Builds Interactions API parameters for session turns (both model and agent modes).
 * Converts from camelCase API config to snake_case Interactions API format.
 */
export function buildInteractionParams(
  options: BuildInteractionParamsOptions,
): Interactions.InteractionCreateParams {
  const {
    profile,
    model,
    prompt,
    thinkingLevel,
    maxOutputTokens = 2048,
    systemInstruction,
    previousInteractionId,
  } = options;

  // Build system instruction with optional grounding suffix
  const resolvedInstruction = systemInstruction
    ? `${systemInstruction}\n\n${GROUNDING_SUFFIX}`
    : DEFAULT_SYSTEM_INSTRUCTION;

  // Build generation_config with snake_case fields
  const generationConfig: Record<string, unknown> = {
    max_output_tokens: maxOutputTokens,
  };

  if (thinkingLevel) {
    // Convert camelCase thinkingLevel (e.g., 'HIGH') to snake_case string (e.g., 'high')
    const level = THINKING_LEVEL_MAP[thinkingLevel];
    // ThinkingLevel enum values are MINIMAL, LOW, MEDIUM, HIGH; convert to lowercase
    generationConfig.thinking_level = level.toLowerCase();
  }

  // Build tools array from builtIns
  const tools = builtInsToInteractionTools(profile.builtIns);

  // Build the final params object with conditional spreads for optional fields
  return {
    model,
    input: prompt,
    system_instruction: resolvedInstruction,
    generation_config: generationConfig,
    ...(tools.length > 0 ? { tools } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
  };
}

interface BackgroundInteractionParams {
  model: string;
  input: string;
  tools?: Interactions.Tool[];
  thinkingLevel?: Interactions.ThinkingLevel;
  maxOutputTokens?: number;
  systemInstruction?: string;
}

export function builtInsToInteractionTools(builtIns: readonly string[]): Interactions.Tool[] {
  return builtIns.flatMap((builtIn): Interactions.Tool[] => {
    const tool = BUILT_IN_TO_INTERACTION_TOOL[builtIn];
    return tool ? [tool] : [];
  });
}

export async function createBackgroundInteraction(
  params: BackgroundInteractionParams,
): Promise<Interactions.Interaction> {
  return getAI().interactions.create({
    model: params.model,
    input: params.input,
    background: true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    generation_config: {
      ...(params.thinkingLevel ? { thinking_level: params.thinkingLevel } : {}),
      ...(params.maxOutputTokens !== undefined
        ? { max_output_tokens: params.maxOutputTokens }
        : {}),
    },
    ...(params.systemInstruction ? { system_instruction: params.systemInstruction } : {}),
  });
}

export async function pollUntilComplete(
  interactionId: string,
  signal?: AbortSignal,
  onPoll?: () => Promise<void>,
): Promise<Interactions.Interaction> {
  const ai = getAI();
  let current = await ai.interactions.get(interactionId);

  while (current.status === 'in_progress') {
    if (signal?.aborted) {
      return cancelAndThrow(ai, interactionId);
    }

    try {
      await delayAsync(POLL_INTERVAL_MS, undefined, signal ? { signal } : undefined);
    } catch {
      return cancelAndThrow(ai, interactionId);
    }

    if (onPoll) {
      await onPoll();
    }

    current = await ai.interactions.get(interactionId);
  }

  return current;
}

async function cancelAndThrow(ai: ReturnType<typeof getAI>, interactionId: string): Promise<never> {
  await ai.interactions.cancel(interactionId).catch(() => undefined);
  throw new AppError(
    'interactions',
    'Background interaction cancelled by abort signal',
    'cancelled',
    false,
  );
}

function extractTextFromInteraction(interaction: Interactions.Interaction): string {
  return (interaction.outputs ?? [])
    .filter((output): output is Interactions.TextContent => output.type === 'text')
    .map((output) => output.text)
    .join('');
}

export function interactionToStreamResult(interaction: Interactions.Interaction): StreamResult {
  const text = extractTextFromInteraction(interaction);

  return {
    text,
    textByWave: [text],
    thoughtText: '',
    parts: text ? ([{ text }] as Part[]) : [],
    toolsUsed: [],
    toolsUsedOccurrences: [],
    functionCalls: [],
    toolEvents: [],
    hadCandidate: true,
  };
}
