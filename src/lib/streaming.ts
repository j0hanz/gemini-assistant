import type { CallToolResult } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, GroundingMetadata, Part } from '@google/genai';

import type { ReportProgress } from './context.js';
import { finishReasonError } from './errors.js';

export interface StreamResult {
  text: string;
  parts: Part[];
  finishReason?: FinishReason;
  groundingMetadata?: GroundingMetadata;
}

const enum Phase {
  Waiting = 0,
  Thinking = 1,
  Generating = 2,
}

export async function consumeStreamWithProgress(
  stream: AsyncGenerator<GenerateContentResponse>,
  reportProgress: ReportProgress,
  signal?: AbortSignal,
  toolLabel?: string,
): Promise<StreamResult> {
  const parts: Part[] = [];
  let text = '';
  let finishReason: FinishReason | undefined;
  let groundingMetadata: GroundingMetadata | undefined;
  let phase: Phase = Phase.Waiting;

  const msg = (m: string): string => (toolLabel ? `${toolLabel}: ${m}` : m);

  await reportProgress(0, 100, msg('Evaluating prompt'));

  for await (const chunk of stream) {
    if (signal?.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    if (candidate.finishReason) {
      finishReason = candidate.finishReason;
    }

    if (candidate.groundingMetadata) {
      groundingMetadata = candidate.groundingMetadata;
    }

    const chunkParts = candidate.content?.parts ?? [];
    for (const part of chunkParts) {
      parts.push(part);

      if (part.thought && phase < Phase.Thinking) {
        phase = Phase.Thinking;
        await reportProgress(20, 100, msg('Thinking'));
      }

      if (!part.thought && part.text !== undefined && phase < Phase.Generating) {
        phase = Phase.Generating;
        await reportProgress(60, 100, msg('Generating response'));
      }

      if (!part.thought && part.text !== undefined) {
        text += part.text;
      }
    }
  }

  return {
    text,
    parts,
    ...(finishReason ? { finishReason } : {}),
    ...(groundingMetadata ? { groundingMetadata } : {}),
  };
}

export function validateStreamResult(result: StreamResult, toolName: string): CallToolResult {
  const errResult = finishReasonError(result.finishReason, result.text, toolName);
  if (errResult) return errResult;

  return {
    content: [{ type: 'text', text: result.text }],
  };
}
