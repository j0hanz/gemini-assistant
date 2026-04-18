import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { buildErrorDiagnosisPrompt } from '../lib/model-prompts.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { executor } from '../lib/tool-executor.js';
import { validateUrls } from '../lib/validation.js';
import type { ExplainErrorInput } from '../schemas/inputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Explain Error';

async function runToolStream(
  ctx: ServerContext,
  initialMsg: string,
  logMsg: string,
  startFn: () => Promise<AsyncGenerator<import('@google/genai').GenerateContentResponse>>,
  resultFn: Parameters<typeof executor.runStream>[4],
): Promise<CallToolResult> {
  const progress = new ProgressReporter(ctx, TOOL_LABEL);
  await progress.send(0, undefined, initialMsg);
  await ctx.mcpReq.log('info', logMsg);
  return executor.runStream(ctx, 'explain_error', TOOL_LABEL, startFn, resultFn);
}

export async function explainErrorWork(
  { error, codeContext, language, thinkingLevel, googleSearch, urls, cacheName }: ExplainErrorInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) return invalidUrlResult;

  const prompt = buildErrorDiagnosisPrompt({
    cacheName,
    codeContext,
    error,
    language,
    urls,
  });

  const orchestration = buildOrchestrationConfig({
    toolProfile:
      googleSearch && (urls?.length ?? 0) > 0
        ? 'search_url'
        : googleSearch
          ? 'search'
          : (urls?.length ?? 0) > 0
            ? 'url'
            : 'none',
  });

  return runToolStream(
    ctx,
    'Diagnosing',
    `Explaining error (${error.length} chars)`,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt.promptText,
        config: buildGenerateContentConfig(
          {
            systemInstruction: prompt.systemInstruction,
            thinkingLevel: thinkingLevel ?? 'MEDIUM',
            cacheName,
            ...orchestration,
          },
          ctx.mcpReq.signal,
        ),
      }),
    (_streamResult, textContent: string) => ({
      structuredContent: {
        explanation: textContent || '',
      },
    }),
  );
}
