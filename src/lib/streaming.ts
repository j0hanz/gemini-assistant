import type {
  CallToolResult,
  QueuedMessage,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';
import type {
  BlockedReason,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
  UrlContextMetadata,
} from '@google/genai';

import { finishReasonToError, withRetry } from './errors.js';
import { advanceProgress, PROGRESS_TOTAL, sendProgress } from './progress.js';
import { pickDefined, promptBlockedError } from './response.js';

export { advanceProgress, PROGRESS_CAP, PROGRESS_TOTAL } from './progress.js';

export interface FunctionCallEntry {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface ToolEvent {
  kind:
    | 'part'
    | 'tool_call'
    | 'tool_response'
    | 'function_call'
    | 'function_response'
    | 'executable_code'
    | 'code_execution_result';
  args?: Record<string, unknown>;
  code?: string;
  id?: string;
  name?: string;
  outcome?: string;
  output?: string;
  response?: Record<string, unknown>;
  text?: string;
  thoughtSignature?: string;
  toolType?: string;
}

export interface StreamResult {
  text: string;
  thoughtText: string;
  parts: Part[];
  toolsUsed: string[];
  functionCalls: FunctionCallEntry[];
  toolEvents: ToolEvent[];
  hadCandidate: boolean;
  finishReason?: FinishReason;
  groundingMetadata?: GroundingMetadata;
  promptBlockReason?: BlockedReason;
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
  toolEvents: ToolEvent[];
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
  hadCandidate: boolean;
  promptBlockReason?: BlockedReason;
  urlContextMetadata?: UrlContextMetadata;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

function updateStreamMetadata(
  chunk: GenerateContentResponse,
  candidate: NonNullable<GenerateContentResponse['candidates']>[number],
  metadata: StreamMetadata,
): void {
  metadata.hadCandidate = true;
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
    hadCandidate: false,
    parts: [],
    phase: Phase.Waiting,
    text: '',
    thoughtHeaderState: {
      scanIndex: 0,
      currentProgress: 0,
      chunksSinceLastHeader: 0,
    },
    thoughtText: '',
    toolEvents: [],
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

function normalizeToolName(toolType: string | undefined): string | undefined {
  switch (toolType) {
    case 'GOOGLE_SEARCH':
    case 'GOOGLE_SEARCH_WEB':
      return 'googleSearch';
    case 'URL_CONTEXT':
      return 'urlContext';
    case 'FILE_SEARCH':
      return 'fileSearch';
    case 'GOOGLE_MAPS':
      return 'googleMaps';
    default:
      return toolType?.trim() ? toolType : undefined;
  }
}

function appendToolEvent(state: StreamProcessingState, event: ToolEvent): void {
  state.toolEvents.push(event);
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

async function maybeReportUrlContextProgress(
  ctx: ServerContext,
  candidate: NonNullable<GenerateContentResponse['candidates']>[number],
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
): Promise<void> {
  if (candidate.urlContextMetadata && !state.toolsUsed.has('urlContext')) {
    await recordToolActivity(ctx, state, msg, 'Retrieving URL context', 'urlContext');
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
    ...(functionCall.id ? { id: functionCall.id } : {}),
    name: fnName,
    ...(functionCall.args ? { args: functionCall.args } : {}),
  });
  appendToolEvent(state, {
    kind: 'function_call',
    ...(functionCall.args ? { args: functionCall.args } : {}),
    ...(functionCall.id ? { id: functionCall.id } : {}),
    name: fnName,
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
  });
  await recordToolActivity(ctx, state, msg, `Tool: ${fnName}`, fnName);
}

async function handleToolCallPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<void> {
  const toolCall = part.toolCall;
  if (!toolCall) {
    return;
  }

  const normalizedToolName = normalizeToolName(toolCall.toolType);
  appendToolEvent(state, {
    kind: 'tool_call',
    ...(toolCall.args ? { args: toolCall.args } : {}),
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    ...(toolCall.toolType ? { toolType: toolCall.toolType } : {}),
  });
  await recordToolActivity(
    ctx,
    state,
    msg,
    `Built-in tool: ${normalizedToolName ?? toolCall.toolType ?? 'unknown'}`,
    normalizedToolName,
  );
}

async function handleToolResponsePart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<void> {
  const toolResponse = part.toolResponse;
  if (!toolResponse) {
    return;
  }

  const normalizedToolName = normalizeToolName(toolResponse.toolType);
  appendToolEvent(state, {
    kind: 'tool_response',
    ...(toolResponse.id ? { id: toolResponse.id } : {}),
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    ...(toolResponse.response ? { response: toolResponse.response } : {}),
    ...(toolResponse.toolType ? { toolType: toolResponse.toolType } : {}),
  });
  await recordToolActivity(
    ctx,
    state,
    msg,
    `Built-in result: ${normalizedToolName ?? toolResponse.toolType ?? 'unknown'}`,
    normalizedToolName,
  );
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
    appendToolEvent(state, {
      kind: 'executable_code',
      ...(part.executableCode.code ? { code: part.executableCode.code } : {}),
      ...(part.executableCode.id ? { id: part.executableCode.id } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    });
    await recordToolActivity(ctx, state, msg, 'Executing code', 'codeExecution');
    return;
  }

  if (part.codeExecutionResult) {
    appendToolEvent(state, {
      kind: 'code_execution_result',
      ...(part.codeExecutionResult.id ? { id: part.codeExecutionResult.id } : {}),
      ...(part.codeExecutionResult.outcome ? { outcome: part.codeExecutionResult.outcome } : {}),
      ...(part.codeExecutionResult.output ? { output: part.codeExecutionResult.output } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    });
    await recordToolActivity(ctx, state, msg, 'Code executed');
    return;
  }

  if (part.toolCall) {
    await handleToolCallPart(ctx, state, msg, part);
    return;
  }

  if (part.toolResponse) {
    await handleToolResponsePart(ctx, state, msg, part);
    return;
  }

  if (part.functionCall) {
    await handleFunctionCallPart(ctx, state, msg, part);
    return;
  }

  if (part.functionResponse) {
    appendToolEvent(state, {
      kind: 'function_response',
      ...(part.functionResponse.id ? { id: part.functionResponse.id } : {}),
      ...(part.functionResponse.name ? { name: part.functionResponse.name } : {}),
      ...(part.functionResponse.response ? { response: part.functionResponse.response } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    });
    return;
  }

  const partText = part.text;
  if (part.thought) {
    await handleThoughtPart(ctx, state, msg, partText);
    return;
  }

  if (part.thoughtSignature && (partText === undefined || partText.length === 0)) {
    appendToolEvent(state, {
      kind: 'part',
      ...(partText !== undefined ? { text: partText } : {}),
      thoughtSignature: part.thoughtSignature,
    });
    if (partText === undefined) {
      return;
    }
  }

  if (partText === undefined) {
    return;
  }

  await transitionToGenerating(ctx, state, msg);
  state.text += partText;

  // Stream LLM token chunks to task-aware clients via the task message queue.
  // The SDK drains this queue and forwards each entry to `transport.send`, so the
  // `message` field must be a fully-formed JSON-RPC notification envelope;
  // otherwise `JSON.stringify(undefined)` ends up on stdout as "undefined\n".
  const taskContext = ctx.task as
    | (NonNullable<ServerContext['task']> & { queue?: TaskMessageQueue })
    | undefined;
  if (taskContext?.queue && taskContext.id) {
    try {
      void taskContext.queue.enqueue(taskContext.id, {
        type: 'notification',
        message: {
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', logger: 'stream', data: partText },
        },
        timestamp: Date.now(),
      } satisfies QueuedMessage);
    } catch {
      // Ignore queue overflow or enqueue errors
    }
  }
}

function finalizeStreamResult(state: StreamProcessingState): StreamResult {
  return {
    text: state.text,
    thoughtText: state.thoughtText,
    parts: state.parts,
    toolsUsed: [...state.toolsUsed],
    functionCalls: state.functionCalls,
    toolEvents: state.toolEvents,
    hadCandidate: state.hadCandidate,
    ...pickDefined({
      finishReason: state.finishReason,
      groundingMetadata: state.groundingMetadata,
      promptBlockReason: state.promptBlockReason,
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

    if (chunk.promptFeedback?.blockReason) {
      state.promptBlockReason = chunk.promptFeedback.blockReason;
    }

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    updateStreamMetadata(chunk, candidate, state);
    await maybeReportSearchProgress(ctx, candidate, state, msg);
    await maybeReportUrlContextProgress(ctx, candidate, state, msg);

    for (const part of candidate.content?.parts ?? []) {
      await handleStreamPart(ctx, state, msg, part);
    }
  }

  return finalizeStreamResult(state);
}

export function validateStreamResult(result: StreamResult, toolName: string): CallToolResult {
  if (result.promptBlockReason) {
    return promptBlockedError(toolName, result.promptBlockReason);
  }

  if (!result.hadCandidate) {
    return promptBlockedError(toolName);
  }

  const errResult = finishReasonToError(result.finishReason, result.text, toolName);
  if (errResult) return errResult.toToolResult();

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
