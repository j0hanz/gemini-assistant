import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { AskThinkingLevel, buildGenerateContentConfig } from '../lib/config-utils.js';
import {
  appendUrlStatus,
  collectUrlMetadata,
  formatCountLabel,
  pickDefined,
} from '../lib/response.js';
import { handleToolExecution } from '../lib/streaming.js';
import { createToolTaskHandlers, READONLY_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { AnalyzeUrlInputSchema } from '../schemas/inputs.js';
import { AnalyzeUrlOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const ANALYZE_URL_SYSTEM_INSTRUCTION =
  'Structure findings with headings. Reference specific sections or data from the retrieved pages. ' +
  'Base analysis strictly on retrieved content.';

function buildPromptWithUrls(urls: string[], question: string): string {
  const urlList = urls.join('\n');
  return `Analyze the following URLs:\n${urlList}\n\n${question}`;
}

function buildAnalyzeUrlReportMessage(urlCount: number): string {
  return `${formatCountLabel(urlCount, 'URL')} retrieved`;
}

async function analyzeUrlWork(
  {
    urls,
    question,
    systemInstruction,
    thinkingLevel,
  }: {
    urls: string[];
    question: string;
    systemInstruction?: string | undefined;
    thinkingLevel?: AskThinkingLevel | undefined;
  },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Analyze URL';

  return await handleToolExecution(
    ctx,
    'analyze_url',
    TOOL_LABEL,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: buildPromptWithUrls(urls, question),
        config: {
          tools: [{ urlContext: {} }],
          ...buildGenerateContentConfig(
            {
              systemInstruction: systemInstruction ?? ANALYZE_URL_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'LOW',
            },
            ctx.mcpReq.signal,
          ),
        },
      }),
    (streamResult, textContent) => {
      const urlMetadata = collectUrlMetadata(streamResult.urlContextMetadata?.urlMetadata);

      const contentAdditions: CallToolResult['content'] = [];
      appendUrlStatus(contentAdditions, urlMetadata);

      return {
        resultMod: (r) => ({
          content: [...r.content, ...contentAdditions],
        }),
        structuredContent: pickDefined({
          answer: textContent,
          urlMetadata: urlMetadata.length > 0 ? urlMetadata : undefined,
        }),
        reportMessage: buildAnalyzeUrlReportMessage(urlMetadata.length),
      };
    },
  );
}

export function registerAnalyzeUrlTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'analyze_url',
    {
      title: 'Analyze URL',
      description:
        'Fetch and analyze one or more public URLs via Gemini URL Context (max 20). ' +
        'Supports web pages, PDFs, images, and other public content.',
      inputSchema: AnalyzeUrlInputSchema,
      outputSchema: AnalyzeUrlOutputSchema,
      annotations: READONLY_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(analyzeUrlWork),
  );
}
