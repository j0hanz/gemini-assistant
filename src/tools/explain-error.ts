import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { sendProgress } from '../lib/errors.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { validateUrls } from '../lib/validation.js';
import { type ExplainErrorInput, ExplainErrorInputSchema } from '../schemas/inputs.js';
import { ExplainErrorOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Explain Error';

const SYSTEM_INSTRUCTION =
  'You are an expert debugging assistant. Diagnose the provided error.\n\n' +
  'RESEARCH & SEARCH STRATEGY:\n' +
  '1. If Google Search is available, DO NOT search the entire stack trace or combined text.\n' +
  '2. Extract specific, distinct error codes, exception names, or key error messages.\n' +
  '3. Output these extracted targets inside <search_queries> tags (e.g., `<search_queries>\\n- ENOSPC\\n- "No space left on device"\\n</search_queries>`).\n' +
  '4. Use the Google Search tool to search for EACH of these targets individually to find the most relevant documentation, issues, or solutions.\n\n' +
  'Base your conclusions on the provided context and grounded tool results. ' +
  'Reference relevant symbols, files, lines, or snippets. If a language is given, use its norms.\n\n' +
  'Output:\n' +
  '## Cause\n' +
  '## Fix\n' +
  '## Notes';

function buildPrompt(
  error: string,
  codeContext?: string,
  language?: string,
  urls?: readonly string[],
): string {
  const sections: string[] = [`## Error\n\n\`\`\`\n${error}\n\`\`\``];

  if (codeContext) {
    sections.push(`## Code\n\n\`\`\`${language ?? ''}\n${codeContext}\n\`\`\``);
  }

  if (language) {
    sections.push(`## Language\n\n${language}`);
  }

  if (urls && urls.length > 0) {
    sections.push(`## URLs\n\n${urls.join('\n')}`);
  }

  sections.push('## Task\n\nDiagnose the error and propose the most likely fix.');

  return sections.join('\n\n');
}

export async function explainErrorWork(
  { error, codeContext, language, thinkingLevel, googleSearch, urls, cacheName }: ExplainErrorInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) return invalidUrlResult;

  await sendProgress(ctx, 0, undefined, `${TOOL_LABEL}: Diagnosing`);
  await ctx.mcpReq.log('info', `Explaining error (${error.length} chars)`);

  const prompt = buildPrompt(error, codeContext, language, urls);

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

  const effectiveSystemInstruction = cacheName ? undefined : SYSTEM_INSTRUCTION;
  const effectivePrompt = cacheName ? `${SYSTEM_INSTRUCTION}\n\n${prompt}` : prompt;

  return await handleToolExecution(
    ctx,
    'explain_error',
    TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: effectivePrompt,
        config: buildGenerateContentConfig(
          {
            systemInstruction: effectiveSystemInstruction,
            thinkingLevel: thinkingLevel ?? 'MEDIUM',
            cacheName,
            ...orchestration,
          },
          ctx.mcpReq.signal,
        ),
      }),
    (_streamResult, textContent) => ({
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
