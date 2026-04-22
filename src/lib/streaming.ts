import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { FinishReason } from '@google/genai';
import type {
  BlockedReason,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
  UrlContextMetadata,
} from '@google/genai';

import { AppError, finishReasonToError, withRetry } from './errors.js';
import { pickDefined } from './object.js';
import { advanceProgress, PROGRESS_TOTAL, sendProgress } from './progress.js';
import { promptBlockedError } from './response.js';

export { advanceProgress, PROGRESS_CAP, PROGRESS_TOTAL } from './progress.js';

export interface FunctionCallEntry {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ToolEvent {
  kind:
    | 'part'
    | 'tool_call'
    | 'tool_response'
    | 'function_call'
    | 'function_response'
    | 'thought'
    | 'model_text'
    | 'executable_code'
    | 'code_execution_result';
  args?: Record<string, unknown>;
  code?: string;
  language?: string;
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
  textByWave: string[];
  thoughtText: string;
  parts: Part[];
  toolsUsed: string[];
  toolsUsedOccurrences: string[];
  functionCalls: FunctionCallEntry[];
  toolEvents: ToolEvent[];
  hadCandidate: boolean;
  aborted?: boolean;
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

const THOUGHT_HEADER_PATTERN = /\*\*([^*]+)\*\*/;
const THOUGHT_FALLBACK_CHUNK_THRESHOLD = 5;

interface ThoughtHeaderState {
  scanIndex: number;
  currentProgress: number;
  chunksSinceLastHeader: number;
}

interface StreamProcessingState extends StreamMetadata {
  completedToolWaves: number;
  currentProgress: number;
  _fnSeen: Set<string>;
  functionCalls: FunctionCallEntry[];
  hadToolActivity: boolean;
  parts: Part[];
  phase: Phase;
  text: string;
  textByWave: string[];
  thoughtHeaderState: ThoughtHeaderState;
  thoughtText: string;
  toolEvents: ToolEvent[];
  toolsUsed: Set<string>;
  toolWaves: number;
}

type ProgressMessageFormatter = (message: string) => string;

async function emitThoughtHeaders(
  thoughtText: string,
  state: ThoughtHeaderState,
  ctx: ServerContext,
  msg: (m: string) => string,
): Promise<void> {
  const tail = thoughtText.slice(state.scanIndex);
  const pattern = new RegExp(THOUGHT_HEADER_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  let lastLocalIndex = 0;
  let foundHeader = false;
  while ((match = pattern.exec(tail)) !== null) {
    const header = match[1]?.trim();
    if (header) {
      foundHeader = true;
      state.chunksSinceLastHeader = 0;
      state.currentProgress = advanceProgress(state.currentProgress);
      await sendProgress(ctx, Math.floor(state.currentProgress), PROGRESS_TOTAL, msg(header));
    }
    lastLocalIndex = pattern.lastIndex;
  }

  if (foundHeader) {
    state.scanIndex += lastLocalIndex;
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
  aborted: boolean;
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
    aborted: false,
    completedToolWaves: 0,
    currentProgress: 0,
    _fnSeen: new Set<string>(),
    functionCalls: [],
    hadToolActivity: false,
    hadCandidate: false,
    parts: [],
    phase: Phase.Waiting,
    text: '',
    textByWave: [''],
    thoughtHeaderState: {
      scanIndex: 0,
      currentProgress: 0,
      chunksSinceLastHeader: 0,
    },
    thoughtText: '',
    toolEvents: [],
    toolsUsed: new Set<string>(),
    toolWaves: 0,
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
  if (state.text.length > 0 && state.phase >= Phase.Generating) {
    state.toolWaves += 1;
    state.phase = Phase.Thinking;
    state.textByWave.push('');
  } else if (state.toolWaves === 0) {
    state.toolWaves = 1;
  }
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

/**
 * Builds a ToolEvent by dropping only undefined fields so falsy SDK values
 * such as empty strings, 0, and false remain replay-visible.
 */
function toolEvent(
  kind: ToolEvent['kind'],
  fields: {
    [K in Exclude<keyof ToolEvent, 'kind'>]?: ToolEvent[K] | undefined;
  },
): ToolEvent {
  const ev: Record<string, unknown> = { kind };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) ev[k] = v;
  }
  return ev as unknown as ToolEvent;
}

async function maybeReportBuiltInToolProgress(
  ctx: ServerContext,
  candidate: NonNullable<GenerateContentResponse['candidates']>[number],
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
): Promise<void> {
  if (candidate.groundingMetadata && !state.toolsUsed.has('googleSearch')) {
    await recordToolActivity(ctx, state, msg, 'Searching the web', 'googleSearch');
  }
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
  if (state.hadToolActivity && state.completedToolWaves < state.toolWaves) {
    state.completedToolWaves = state.toolWaves;
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
    await ctx.mcpReq.log('debug', 'Received functionCall with missing name');
  }

  const fnName = functionCall.name ?? 'tool';
  const fnKey = functionCall.id ?? `${fnName}:${JSON.stringify(functionCall.args ?? {})}`;
  if (!state._fnSeen.has(fnKey)) {
    state._fnSeen.add(fnKey);
    state.functionCalls.push({
      name: fnName,
      ...(functionCall.id ? { id: functionCall.id } : {}),
      ...(functionCall.args ? { args: functionCall.args } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    });
  }
  appendToolEvent(
    state,
    toolEvent('function_call', {
      args: functionCall.args,
      id: functionCall.id,
      name: fnName,
      thoughtSignature: part.thoughtSignature,
    }),
  );
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
  appendToolEvent(
    state,
    toolEvent('tool_call', {
      args: toolCall.args,
      id: toolCall.id,
      thoughtSignature: part.thoughtSignature,
      toolType: toolCall.toolType,
    }),
  );
  const alreadyReported = normalizedToolName ? state.toolsUsed.has(normalizedToolName) : false;
  const toolName = normalizedToolName ?? toolCall.toolType;
  if (toolName) state.toolsUsed.add(toolName);
  if (!alreadyReported) {
    await recordToolActivity(
      ctx,
      state,
      msg,
      `Built-in tool: ${normalizedToolName ?? toolCall.toolType ?? 'unknown'}`,
      normalizedToolName,
    );
  }
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
  appendToolEvent(
    state,
    toolEvent('tool_response', {
      id: toolResponse.id,
      response: toolResponse.response,
      thoughtSignature: part.thoughtSignature,
      toolType: toolResponse.toolType,
    }),
  );
  const alreadyReported = normalizedToolName ? state.toolsUsed.has(normalizedToolName) : false;
  const toolName = normalizedToolName ?? toolResponse.toolType;
  if (toolName) state.toolsUsed.add(toolName);
  if (!alreadyReported) {
    await recordToolActivity(
      ctx,
      state,
      msg,
      `Built-in result: ${normalizedToolName ?? toolResponse.toolType ?? 'unknown'}`,
      normalizedToolName,
    );
  }
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

async function handleExecutableCodePart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<boolean> {
  if (!part.executableCode) {
    return false;
  }

  appendToolEvent(
    state,
    toolEvent('executable_code', {
      code: part.executableCode.code,
      id: part.executableCode.id,
      language: part.executableCode.language,
      thoughtSignature: part.thoughtSignature,
    }),
  );
  await recordToolActivity(ctx, state, msg, 'Executing code', 'codeExecution');
  return true;
}

async function handleCodeExecutionResultPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<boolean> {
  if (!part.codeExecutionResult) {
    return false;
  }

  appendToolEvent(
    state,
    toolEvent('code_execution_result', {
      id: part.codeExecutionResult.id,
      outcome: part.codeExecutionResult.outcome,
      output: part.codeExecutionResult.output,
      thoughtSignature: part.thoughtSignature,
    }),
  );
  await recordToolActivity(ctx, state, msg, 'Code executed');
  return true;
}

async function handleToolProtocolPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<boolean> {
  if (part.toolCall) {
    await handleToolCallPart(ctx, state, msg, part);
    return true;
  }

  if (part.toolResponse) {
    await handleToolResponsePart(ctx, state, msg, part);
    return true;
  }

  return false;
}

async function handleFunctionProtocolPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<boolean> {
  if (part.functionCall) {
    await handleFunctionCallPart(ctx, state, msg, part);
    return true;
  }

  if (!part.functionResponse) {
    return false;
  }

  appendToolEvent(
    state,
    toolEvent('function_response', {
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      response: part.functionResponse.response,
      thoughtSignature: part.thoughtSignature,
    }),
  );
  await recordToolActivity(
    ctx,
    state,
    msg,
    `Function result: ${part.functionResponse.name ?? 'tool'}`,
    part.functionResponse.name,
  );
  return true;
}

async function handleThoughtOrSignaturePart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<boolean> {
  const partText = part.text;
  if (part.thought) {
    appendToolEvent(
      state,
      toolEvent('thought', {
        text: partText,
        thoughtSignature: part.thoughtSignature,
      }),
    );
    await handleThoughtPart(ctx, state, msg, partText);
    return true;
  }

  if (!part.thoughtSignature || (typeof partText === 'string' && partText.length > 0)) {
    return false;
  }

  appendToolEvent(state, {
    kind: 'part',
    ...(partText !== undefined ? { text: partText } : {}),
    thoughtSignature: part.thoughtSignature,
  });
  return true;
}

// Streamed tool text is returned as the terminal CallToolResult (or via
// tasks/result for task-augmented calls). It MUST NOT ride the MCP logging
// channel (`notifications/message`) — clients filter logs by level and would
// either flood on `info` or silently drop streamed content.
async function handleTextPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<void> {
  const partText = part.text;
  if (partText === undefined) {
    return;
  }

  if (partText.length === 0 && part.thoughtSignature === undefined) {
    return;
  }

  if (part.thoughtSignature !== undefined) {
    appendToolEvent(
      state,
      toolEvent('model_text', {
        text: partText,
        thoughtSignature: part.thoughtSignature,
      }),
    );
  }
  await transitionToGenerating(ctx, state, msg);
  state.text += partText;
  const waveIndex = state.textByWave.length - 1;
  state.textByWave[waveIndex] = `${state.textByWave[waveIndex] ?? ''}${partText}`;
}

async function handleStreamPart(
  ctx: ServerContext,
  state: StreamProcessingState,
  msg: ProgressMessageFormatter,
  part: Part,
): Promise<void> {
  state.parts.push(part);

  if (await handleExecutableCodePart(ctx, state, msg, part)) {
    return;
  }

  if (await handleCodeExecutionResultPart(ctx, state, msg, part)) {
    return;
  }

  if (await handleToolProtocolPart(ctx, state, msg, part)) {
    return;
  }

  if (await handleFunctionProtocolPart(ctx, state, msg, part)) {
    return;
  }

  if (await handleThoughtOrSignaturePart(ctx, state, msg, part)) {
    return;
  }

  await handleTextPart(ctx, state, msg, part);
}

function toolsUsedOccurrences(toolEvents: ToolEvent[]): string[] {
  return toolEvents.flatMap((event) => {
    if (event.kind === 'function_call' || event.kind === 'function_response') {
      return event.name ? [event.name] : [];
    }
    if (event.kind === 'executable_code' || event.kind === 'code_execution_result') {
      return ['codeExecution'];
    }
    if (event.kind === 'tool_call' || event.kind === 'tool_response') {
      const normalized = normalizeToolName(event.toolType);
      return normalized ? [normalized] : [];
    }
    return [];
  });
}

function finalizeStreamResult(state: StreamProcessingState): StreamResult {
  return {
    text: state.text,
    textByWave: state.textByWave,
    thoughtText: state.thoughtText,
    parts: state.parts,
    toolsUsed: [...state.toolsUsed],
    toolsUsedOccurrences: toolsUsedOccurrences(state.toolEvents),
    functionCalls: state.functionCalls,
    toolEvents: state.toolEvents,
    hadCandidate: state.hadCandidate,
    ...pickDefined({
      aborted: state.aborted,
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
    if (ctx.mcpReq.signal.aborted) {
      state.aborted = true;
      break;
    }

    if (chunk.promptFeedback?.blockReason) {
      state.promptBlockReason = chunk.promptFeedback.blockReason;
    }

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    updateStreamMetadata(chunk, candidate, state);
    await maybeReportBuiltInToolProgress(ctx, candidate, state, msg);

    for (const part of candidate.content?.parts ?? []) {
      await handleStreamPart(ctx, state, msg, part);
    }
  }

  return finalizeStreamResult(state);
}

export function validateStreamResult(result: StreamResult, toolName: string): CallToolResult {
  if (result.aborted) {
    return new AppError(
      toolName,
      `${toolName}: aborted (aborted)`,
      'cancelled',
      false,
    ).toToolResult();
  }

  if (result.promptBlockReason) {
    return promptBlockedError(toolName, result.promptBlockReason);
  }

  if (!result.hadCandidate) {
    return new AppError(
      toolName,
      `${toolName}: empty stream from Gemini (empty_stream)`,
      'internal',
      true,
    ).toToolResult();
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
    cachedContentTokenCount: meta.cachedContentTokenCount,
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
    onRetry: async (attempt, max, delayMs) => {
      await sendProgress(
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
