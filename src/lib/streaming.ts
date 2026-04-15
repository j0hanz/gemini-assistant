import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';
import type {
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
  UrlContextMetadata,
} from '@google/genai';

import { EXPOSE_THOUGHTS } from '../client.js';
import {
  finishReasonError,
  reportCompletion,
  reportFailure,
  sendProgress,
  withRetry,
} from './errors.js';
import { extractTextContent, pickDefined } from './response.js';

export const PROGRESS_TOTAL = 100;
export const PROGRESS_STEP_FRACTION = 0.15;
export const PROGRESS_CAP = 95;

export function advanceProgress(current: number): number {
  return Math.min(current + (PROGRESS_TOTAL - current) * PROGRESS_STEP_FRACTION, PROGRESS_CAP);
}

export interface FunctionCallEntry {
  name: string;
  args?: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  thoughtText: string;
  parts: Part[];
  toolsUsed: string[];
  functionCalls: FunctionCallEntry[];
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
  currentProgress: number;
  chunksSinceLastHeader: number;
}

interface StreamProcessingState extends StreamMetadata {
  currentProgress: number;
  emittedCompiling: boolean;
  functionCalls: FunctionCallEntry[];
  hadToolActivity: boolean;
  parts: Part[];
  phase: Phase;
  text: string;
  thoughtHeaderState: ThoughtHeaderState;
  thoughtText: string;
  toolsUsed: Set<string>;
}

type ProgressMessageFormatter = (message: string) => string;

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
      state.currentProgress = advanceProgress(state.currentProgress);
      await sendProgress(ctx, Math.floor(state.currentProgress), PROGRESS_TOTAL, msg(header));
    }
    state.scanIndex = THOUGHT_HEADER_PATTERN.lastIndex;
  }

  if (!foundHeader) {
    state.chunksSinceLastHeader++;
    if (state.chunksSinceLastHeader >= THOUGHT_FALLBACK_CHUNK_THRESHOLD) {
      state.chunksSinceLastHeader = 0;
      state.currentProgress = advanceProgress(state.currentProgress);
      await sendProgress(
        ctx,
        Math.floor(state.currentProgress),
        PROGRESS_TOTAL,
        msg('Still thinking\u2026'),
      );
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

function createStreamProcessingState(): StreamProcessingState {
  return {
    currentProgress: 0,
    emittedCompiling: false,
    functionCalls: [],
    hadToolActivity: false,
    parts: [],
    phase: Phase.Waiting,
    text: '',
    thoughtHeaderState: {
      scanIndex: 0,
      currentProgress: 0,
      chunksSinceLastHeader: 0,
    },
    thoughtText: '',
    toolsUsed: new Set<string>(),
  };
}

async function advanceAndSendProgress(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  message: string,
): Promise<void> {
  state.currentProgress = advanceProgress(state.currentProgress);
  await sendProgress(ctx, Math.floor(state.currentProgress), PROGRESS_TOTAL, msg(message));
}

async function recordToolActivity(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  progressMessage: string,
  toolName?: string,
): Promise<void> {
  if (toolName) {
    state.toolsUsed.add(toolName);
  }
  state.hadToolActivity = true;
  await advanceAndSendProgress(ctx, state, msg, progressMessage);
}

async function maybeReportSearchProgress(
  ctx: ServerContext,
  candidate: NonNullable<GenerateContentResponse['candidates']>[number],
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
): Promise<void> {
  if (candidate.groundingMetadata && !state.toolsUsed.has('googleSearch')) {
    await recordToolActivity(ctx, state, msg, 'Searching the web', 'googleSearch');
  }
}

async function transitionToThinking(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
): Promise<void> {
  if (state.phase >= Phase.Thinking) {
    return;
  }

  state.phase = Phase.Thinking;
  await advanceAndSendProgress(ctx, state, msg, 'Thinking');
}

async function transitionToGenerating(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
): Promise<void> {
  if (state.hadToolActivity && !state.emittedCompiling) {
    state.emittedCompiling = true;
    state.phase = Phase.Generating;
    await advanceAndSendProgress(ctx, state, msg, 'Compiling results');
    return;
  }

  if (state.phase >= Phase.Generating) {
    return;
  }

  state.phase = Phase.Generating;
  await advanceAndSendProgress(ctx, state, msg, 'Generating response');
}

async function handleFunctionCallPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<void> {
  const functionCall = part.functionCall;
  if (!functionCall) {
    return;
  }

  if (!functionCall.name) {
    await ctx.mcpReq.log('warning', 'Received functionCall with missing name');
  }

  const fnName = functionCall.name ?? 'tool';
  state.functionCalls.push({
    name: fnName,
    ...(functionCall.args ? { args: functionCall.args } : {}),
  });
  await recordToolActivity(ctx, state, msg, `Tool: ${fnName}`, fnName);
}

async function handleThoughtPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  partText: string | undefined,
): Promise<void> {
  await transitionToThinking(ctx, state, msg);

  if (partText === undefined) {
    return;
  }

  state.thoughtText += partText;
  state.thoughtHeaderState.currentProgress = state.currentProgress;
  await emitThoughtHeaders(state.thoughtText, state.thoughtHeaderState, ctx, msg);
  state.currentProgress = state.thoughtHeaderState.currentProgress;
}

async function handleStreamPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<void> {
  state.parts.push(part);

  if (part.executableCode) {
    await recordToolActivity(ctx, state, msg, 'Executing code', 'codeExecution');
    return;
  }

  if (part.codeExecutionResult) {
    await recordToolActivity(ctx, state, msg, 'Code executed');
    return;
  }

  if (part.functionCall) {
    await handleFunctionCallPart(ctx, state, msg, part);
    return;
  }

  const partText = part.text;
  if (part.thought) {
    await handleThoughtPart(ctx, state, msg, partText);
    return;
  }

  if (partText === undefined) {
    return;
  }

  await transitionToGenerating(ctx, state, msg);
  state.text += partText;
}

function finalizeStreamResult(state: StreamProcessingState): StreamResult {
  return {
    text: state.text,
    thoughtText: state.thoughtText,
    parts: state.parts,
    toolsUsed: [...state.toolsUsed],
    functionCalls: state.functionCalls,
    ...pickDefined({
      finishReason: state.finishReason,
      groundingMetadata: state.groundingMetadata,
      urlContextMetadata: state.urlContextMetadata,
      usageMetadata: state.usageMetadata,
    }),
  };
}

export async function consumeStreamWithProgress(
  stream: AsyncGenerator<GenerateContentResponse>,
  ctx: ServerContext,
  toolLabel?: string,
): Promise<StreamResult> {
  const state = createStreamProcessingState();
  const msg = (message: string): string => (toolLabel ? `${toolLabel}: ${message}` : message);

  await advanceAndSendProgress(ctx, state, msg, 'Evaluating prompt');

  for await (const chunk of stream) {
    if (ctx.mcpReq.signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    updateStreamMetadata(chunk, candidate, state);
    await maybeReportSearchProgress(ctx, candidate, state, msg);

    for (const part of candidate.content?.parts ?? []) {
      await handleStreamPart(ctx, state, msg, part);
    }
  }

  return finalizeStreamResult(state);
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
  const { streamResult, result } = await executeToolStream(
    ctx,
    toolName,
    toolLabel,
    streamGenerator,
  );
  if (result.isError) {
    await reportFailure(ctx, toolLabel, extractTextContent(result.content));
    return result;
  }

  const text = extractTextContent(result.content);
  const built = responseBuilder(streamResult, text);
  const finalResult: CallToolResult = {
    ...result,
    ...(built.resultMod ? built.resultMod(result) : {}),
  };

  if (finalResult.isError) {
    await reportFailure(ctx, toolLabel, extractTextContent(finalResult.content));
  } else {
    if (built.reportMessage) {
      await reportCompletion(ctx, toolLabel, built.reportMessage);
    } else {
      await reportCompletion(ctx, toolLabel, 'completed');
    }
  }

  const usage = extractUsage(streamResult.usageMetadata);

  return {
    ...finalResult,
    structuredContent: {
      ...(built.structuredContent ?? {}),
      ...(EXPOSE_THOUGHTS && streamResult.thoughtText
        ? { thoughts: streamResult.thoughtText }
        : {}),
      ...(usage ? { usage } : {}),
    },
  };
}
