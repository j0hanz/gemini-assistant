import type { Interactions, Part } from '@google/genai';

import { getAI } from '../client.js';
import { AppError } from './errors.js';
import type { StreamResult } from './streaming.js';

const BUILT_IN_TO_INTERACTION_TOOL: Readonly<Record<string, Interactions.Tool>> = {
  googleSearch: { type: 'google_search' },
  urlContext: { type: 'url_context' },
  codeExecution: { type: 'code_execution' },
};

const POLL_INTERVAL_MS = 3_000;

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
      await interruptibleDelay(POLL_INTERVAL_MS, signal);
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

function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

export function extractTextFromInteraction(interaction: Interactions.Interaction): string {
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
