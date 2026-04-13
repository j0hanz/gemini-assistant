import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';
import type {
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
  UrlContextMetadata,
} from '@google/genai';

import { reportCompletion, sendProgress } from './context.js';
import { finishReasonError, handleToolError } from './errors.js';
import { extractTextContent, pickDefined } from './response.js';
import { withRetry } from './retry.js';

export interface StreamResult {
  text: string;
  thoughtText: string;
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

interface StreamMetadata {
  finishReason?: FinishReason;
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: UrlContextMetadata;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

function updateStreamMetadata(
  chunk: GenerateContentResponse,
  candidate: NonNullable<GenerateContentResponse['candidates']>[number],
  metadata: StreamMetadata,
): void {
  if (candidate.finishReason) {
    metadata.finishReason = candidate.finishReason;
  }

  if (candidate.groundingMetadata) {
    metadata.groundingMetadata = candidate.groundingMetadata;
  }

  if (candidate.urlContextMetadata) {
    metadata.urlContextMetadata = candidate.urlContextMetadata;
  }

  if (chunk.usageMetadata) {
    metadata.usageMetadata = chunk.usageMetadata;
  }
}

export async function consumeStreamWithProgress(
  stream: AsyncGenerator<GenerateContentResponse>,
  ctx: ServerContext,
  toolLabel?: string,
): Promise<StreamResult> {
  const parts: Part[] = [];
  let text = '';
  let thoughtText = '';
  const metadata: StreamMetadata = {};
  let phase: Phase = Phase.Waiting;

  const msg = (m: string): string => (toolLabel ? `${toolLabel}: ${m}` : m);

  await sendProgress(ctx, 25, 100, msg('Evaluating prompt'));

  for await (const chunk of stream) {
    if (ctx.mcpReq.signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    updateStreamMetadata(chunk, candidate, metadata);

    const chunkParts = candidate.content?.parts ?? [];
    for (const part of chunkParts) {
      parts.push(part);

      const partText = part.text;

      if (part.thought) {
        if (phase < Phase.Thinking) {
          phase = Phase.Thinking;
          await sendProgress(ctx, 50, 100, msg('Thinking'));
        }

        if (partText !== undefined) {
          thoughtText += partText;
        }

        continue;
      }

      if (partText === undefined) {
        continue;
      }

      if (phase < Phase.Generating) {
        phase = Phase.Generating;
        await sendProgress(ctx, 75, 100, msg('Generating response'));
      }

      text += partText;
    }
  }

  return {
    text,
    thoughtText,
    parts,
    ...pickDefined({ ...metadata }),
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

export async function handleToolExecution<T extends Record<string, unknown>>(
  ctx: ServerContext,
  toolName: string,
  toolLabel: string,
  streamGenerator: () => Promise<AsyncGenerator<GenerateContentResponse>>,
  responseBuilder: (
    streamResult: StreamResult,
    text: string,
  ) => {
    resultMod?: (r: CallToolResult) => Partial<CallToolResult>;
    structuredContent?: T;
    reportMessage?: string;
  } = (s, t) => ({ structuredContent: { answer: t } as unknown as T }),
): Promise<CallToolResult> {
  try {
    const { streamResult, result } = await executeToolStream(
      ctx,
      toolName,
      toolLabel,
      streamGenerator,
    );
    if (result.isError) return result;

    const text = extractTextContent(result.content);
    const built = responseBuilder(streamResult, text);

    if (built.reportMessage) {
      await reportCompletion(ctx, toolLabel, built.reportMessage);
    } else {
      await reportCompletion(ctx, toolLabel, `responded (${text.length} chars)`);
    }

    const usage = extractUsage(streamResult.usageMetadata);

    return {
      ...result,
      ...(built.resultMod ? built.resultMod(result) : {}),
      structuredContent: {
        ...(built.structuredContent ?? {}),
        ...(streamResult.thoughtText ? { thoughts: streamResult.thoughtText } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  } catch (err) {
    return await handleToolError(ctx, toolName, toolLabel, err);
  }
}
