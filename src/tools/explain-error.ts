import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import type { ToolListUnion } from '@google/genai';

import { sendProgress } from '../lib/errors.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { validateUrls } from '../lib/validation.js';
import { type ExplainErrorInput, ExplainErrorInputSchema } from '../schemas/inputs.js';
import { ExplainErrorOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Explain Error';

const SYSTEM_INSTRUCTION =
  'You are an expert debugger. Given an error (stack trace, log output, or error message), ' +
  'diagnose the root cause and provide a fix.\n\n' +
  'Structure your response with these markdown sections:\n' +
  '## Root Cause\nWhat specifically caused the error.\n\n' +
  '## Explanation\nDetailed explanation of why the error occurred and the underlying mechanism.\n\n' +
  '## Suggested Fix\nConcrete, actionable steps or code changes to resolve the error.\n\n' +
  'Be precise. Reference specific lines, symbols, or patterns from the provided context. ' +
  'If the language is specified, tailor advice to its idioms and ecosystem.';

function buildPrompt(
  error: string,
  codeContext?: string,
  language?: string,
  urls?: readonly string[],
): string {
  const sections: string[] = [`### Error\n\n\`\`\`\n${error}\n\`\`\``];

  if (codeContext) {
    sections.push(`### Code Context\n\n\`\`\`${language ?? ''}\n${codeContext}\n\`\`\``);
  }

  if (language) {
    sections.push(`### Language\n\n${language}`);
  }

  if (urls && urls.length > 0) {
    sections.push(`### Reference URLs\n\n${urls.join('\n')}`);
  }

  return sections.join('\n\n');
}

async function explainErrorWork(
  { error, codeContext, language, thinkingLevel, googleSearch, urls, cacheName }: ExplainErrorInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const invalidUrlResult = validateUrls(urls);
  if (invalidUrlResult) return invalidUrlResult;

  await sendProgress(ctx, 0, undefined, `${TOOL_LABEL}: Diagnosing`);
  await ctx.mcpReq.log('info', `Explaining error (${error.length} chars)`);

  const prompt = buildPrompt(error, codeContext, language, urls);

  const tools: ToolListUnion = [
    ...(googleSearch ? [{ googleSearch: {} }] : []),
    ...((urls?.length ?? 0) > 0 ? [{ urlContext: {} }] : []),
  ];

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
            ...(tools.length > 0 ? { tools } : {}),
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

export function registerExplainErrorTool(server: McpServer): void {
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
    explainErrorWork,
  );
}
