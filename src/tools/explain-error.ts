import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { buildErrorDiagnosisPrompt } from '../lib/model-prompts.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { validateUrls } from '../lib/validation.js';
import { type ExplainErrorInput, ExplainErrorInputSchema } from '../schemas/inputs.js';
import { ExplainErrorOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Explain Error';

export async function explainErrorWork(
  { error, codeContext, language, thinkingLevel, googleSearch, urls, cacheName }: ExplainErrorInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) return invalidUrlResult;

  const progress = new ProgressReporter(ctx, TOOL_LABEL);
  await progress.send(0, undefined, 'Diagnosing');
  await ctx.mcpReq.log('info', `Explaining error (${error.length} chars)`);

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

  return await executor.runStream(
    ctx,
    'explain_error',
    TOOL_LABEL,
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

export function registerExplainErrorTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
): void {
  registerTaskTool(
    server,
    'explain_error',
    {
      title: TOOL_LABEL,
      description:
        'Diagnose an error from a stack trace, log output, or error message. ' +
        'Returns root cause, explanation, and suggested fix. ' +
        'Optionally uses Google Search for docs/issues and URL Context for reference links.',
      inputSchema: ExplainErrorInputSchema,
      outputSchema: ExplainErrorOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    taskMessageQueue,
    explainErrorWork,
  );
}
