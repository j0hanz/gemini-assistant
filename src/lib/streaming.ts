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
  toolsUsed: string[];
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

const THOUGHT_HEADER_PATTERN = /\*\*([^*]+)\*\*/g;
const THOUGHT_FALLBACK_CHUNK_THRESHOLD = 5;

interface ThoughtHeaderState {
  scanIndex: number;
  progressStep: number;
  chunksSinceLastHeader: number;
}

async function emitThoughtHeaders(
  thoughtText: string,
  state: ThoughtHeaderState,
  ctx: ServerContext,
  msg: (m: string) => string,
): Promise<void> {
  THOUGHT_HEADER_PATTERN.lastIndex = state.scanIndex;
  let match: RegExpExecArray | null;
  let foundHeader = false;
  while ((match = THOUGHT_HEADER_PATTERN.exec(thoughtText)) !== null) {
    const header = match[1]?.trim();
    if (header) {
      foundHeader = true;
      state.chunksSinceLastHeader = 0;
      await sendProgress(ctx, ++state.progressStep, undefined, msg(header));
    }
    state.scanIndex = THOUGHT_HEADER_PATTERN.lastIndex;
  }

  if (!foundHeader) {
    state.chunksSinceLastHeader++;
    if (state.chunksSinceLastHeader >= THOUGHT_FALLBACK_CHUNK_THRESHOLD) {
      state.chunksSinceLastHeader = 0;
      await sendProgress(ctx, ++state.progressStep, undefined, msg('Still thinking\u2026'));
    }
  }
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
  let progressStep = 0;
  const toolsUsed = new Set<string>();
  let hadToolActivity = false;
  let emittedCompiling = false;
  const thoughtHeaderState: ThoughtHeaderState = {
    scanIndex: 0,
    progressStep: 0,
    chunksSinceLastHeader: 0,
  };

  const msg = (m: string): string => (toolLabel ? `${toolLabel}: ${m}` : m);

  await sendProgress(ctx, ++progressStep, undefined, msg('Evaluating prompt'));

  for await (const chunk of stream) {
    if (ctx.mcpReq.signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    updateStreamMetadata(chunk, candidate, metadata);

    if (candidate.groundingMetadata && !toolsUsed.has('googleSearch')) {
      toolsUsed.add('googleSearch');
      hadToolActivity = true;
      await sendProgress(ctx, ++progressStep, undefined, msg('Searching the web'));
    }

    const chunkParts = candidate.content?.parts ?? [];
    for (const part of chunkParts) {
      parts.push(part);

      if (part.executableCode) {
        toolsUsed.add('codeExecution');
        hadToolActivity = true;
        await sendProgress(ctx, ++progressStep, undefined, msg('Executing code'));
        continue;
      }

      if (part.codeExecutionResult) {
        hadToolActivity = true;
        await sendProgress(ctx, ++progressStep, undefined, msg('Code executed'));
        continue;
      }

      if (part.functionCall) {
        const fnName = part.functionCall.name ?? 'tool';
        toolsUsed.add(fnName);
        hadToolActivity = true;
        await sendProgress(ctx, ++progressStep, undefined, msg(`Tool: ${fnName}`));
        continue;
      }

      const partText = part.text;

      if (part.thought) {
        if (phase < Phase.Thinking) {
          phase = Phase.Thinking;
          await sendProgress(ctx, ++progressStep, undefined, msg('Thinking'));
        }

        if (partText !== undefined) {
          thoughtText += partText;
          thoughtHeaderState.progressStep = progressStep;
          await emitThoughtHeaders(thoughtText, thoughtHeaderState, ctx, msg);
          progressStep = thoughtHeaderState.progressStep;
        }

        continue;
      }

      if (partText === undefined) {
        continue;
      }

      if (hadToolActivity && !emittedCompiling) {
        emittedCompiling = true;
        phase = Phase.Generating;
        await sendProgress(ctx, ++progressStep, undefined, msg('Compiling results'));
      } else if (phase < Phase.Generating) {
        phase = Phase.Generating;
        await sendProgress(ctx, ++progressStep, undefined, msg('Generating response'));
      }

      text += partText;
    }
  }

  return {
    text,
    thoughtText,
    parts,
    toolsUsed: [...toolsUsed],
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
  const stream = await withRetry(streamGenerator, {
    signal: ctx.mcpReq.signal,
    onRetry: (attempt, max, delayMs) => {
      void sendProgress(
        ctx,
        0,
        undefined,
        `${toolLabel}: Retrying (${attempt}/${max}, ~${Math.round(delayMs / 1000)}s)`,
      );
    },
  });
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
      await reportCompletion(ctx, toolLabel, 'completed');
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
