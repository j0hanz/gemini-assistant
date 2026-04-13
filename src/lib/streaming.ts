import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';
import type {
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
  UrlContextMetadata,
} from '@google/genai';

import { sendProgress } from './context.js';
import { finishReasonError } from './errors.js';
import { pickDefined } from './response.js';
import { withRetry } from './retry.js';

export interface StreamResult {
  text: string;
  parts: Part[];
  finishReason?: FinishReason;
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: UrlContextMetadata;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

const enum Phase {
  Waiting = 0,
  Thinking = 1,
  Generating = 2,
}

export async function consumeStreamWithProgress(
  stream: AsyncGenerator<GenerateContentResponse>,
  ctx: ServerContext,
  toolLabel?: string,
): Promise<StreamResult> {
  const parts: Part[] = [];
  let text = '';
  let finishReason: FinishReason | undefined;
  let groundingMetadata: GroundingMetadata | undefined;
  let urlContextMetadata: UrlContextMetadata | undefined;
  let usageMetadata: GenerateContentResponseUsageMetadata | undefined;
  let phase: Phase = Phase.Waiting;

  const msg = (m: string): string => (toolLabel ? `${toolLabel}: ${m}` : m);

  await sendProgress(ctx, 25, 100, msg('Evaluating prompt'));

  for await (const chunk of stream) {
    if (ctx.mcpReq.signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    if (candidate.finishReason) {
      finishReason = candidate.finishReason;
    }

    if (candidate.groundingMetadata) {
      groundingMetadata = candidate.groundingMetadata;
    }

    if (candidate.urlContextMetadata) {
      urlContextMetadata = candidate.urlContextMetadata;
    }

    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata;
    }

    const chunkParts = candidate.content?.parts ?? [];
    for (const part of chunkParts) {
      parts.push(part);

      if (part.thought && phase < Phase.Thinking) {
        phase = Phase.Thinking;
        await sendProgress(ctx, 50, 100, msg('Thinking'));
      }

      if (!part.thought && part.text !== undefined && phase < Phase.Generating) {
        phase = Phase.Generating;
        await sendProgress(ctx, 75, 100, msg('Generating response'));
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
    ...(urlContextMetadata ? { urlContextMetadata } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

export function validateStreamResult(result: StreamResult, toolName: string): CallToolResult {
  const errResult = finishReasonError(result.finishReason, result.text, toolName);
  if (errResult) return errResult;

  return {
    content: [{ type: 'text', text: result.text }],
  };
}

export function extractUsage(meta?: GenerateContentResponseUsageMetadata) {
  if (!meta) return undefined;
  return pickDefined({
    promptTokenCount: meta.promptTokenCount,
    candidatesTokenCount: meta.candidatesTokenCount,
    thoughtsTokenCount: meta.thoughtsTokenCount,
    totalTokenCount: meta.totalTokenCount,
  });
}

export async function executeToolStream(
  ctx: ServerContext,
  toolName: string,
  toolLabel: string,
  streamGenerator: () => Promise<AsyncGenerator<GenerateContentResponse>>,
): Promise<{ streamResult: StreamResult; result: CallToolResult }> {
  const stream = await withRetry(streamGenerator, { signal: ctx.mcpReq.signal });
  const streamResult = await consumeStreamWithProgress(stream, ctx, toolLabel);
  const result = validateStreamResult(streamResult, toolName);
  return { streamResult, result };
}
