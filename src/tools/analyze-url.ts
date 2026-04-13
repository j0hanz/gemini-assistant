import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { reportCompletion, reportFailure } from '../lib/context.js';
import { logAndReturnError } from '../lib/errors.js';
import { extractTextContent } from '../lib/response.js';
import { executeToolStream, extractUsage } from '../lib/streaming.js';
import { createToolTaskHandlers } from '../lib/task-utils.js';
import { AnalyzeUrlInputSchema } from '../schemas/inputs.js';
import { AnalyzeUrlOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const ANALYZE_URL_SYSTEM_INSTRUCTION =
  'Analyze the content from the provided URLs thoroughly. ' +
  'Structure findings clearly with headings. ' +
  'Reference specific sections or data from the retrieved pages. ' +
  'Base analysis strictly on retrieved content. Do not speculate beyond what the pages confirm.';

interface UrlMetadataEntry {
  url: string;
  status: string;
}

function collectUrlMetadata(
  streamResult: Awaited<ReturnType<typeof executeToolStream>>['streamResult'],
): UrlMetadataEntry[] {
  const entries: UrlMetadataEntry[] = [];
  const urlMetadata = streamResult.urlContextMetadata?.urlMetadata;
  if (!urlMetadata) return entries;

  for (const meta of urlMetadata) {
    if (meta.retrievedUrl) {
      entries.push({
        url: meta.retrievedUrl,
        status: meta.urlRetrievalStatus ?? 'UNKNOWN',
      });
    }
  }

  return entries;
}

function buildPromptWithUrls(urls: string[], question: string): string {
  const urlList = urls.join('\n');
  return `Analyze the following URLs:\n${urlList}\n\n${question}`;
}

async function analyzeUrlWork(
  {
    urls,
    question,
    systemInstruction,
  }: { urls: string[]; question: string; systemInstruction?: string | undefined },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Analyze URL';
  try {
    const { streamResult, result } = await executeToolStream(ctx, 'analyze_url', TOOL_LABEL, () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: buildPromptWithUrls(urls, question),
        config: {
          tools: [{ urlContext: {} }],
          systemInstruction: systemInstruction ?? ANALYZE_URL_SYSTEM_INSTRUCTION,
          thinkingConfig: { includeThoughts: true },
          maxOutputTokens: 8192,
          abortSignal: ctx.mcpReq.signal,
        },
      }),
    );

    if (result.isError) return result;

    const answerText = extractTextContent(result.content) || '';
    const urlMetadata = collectUrlMetadata(streamResult);

    if (urlMetadata.length > 0) {
      const statusSummary = urlMetadata.map((m) => `- ${m.url}: ${m.status}`).join('\n');
      result.content.push({
        type: 'text',
        text: `\n\nURL Retrieval Status:\n${statusSummary}`,
      });
    }

    await reportCompletion(
      ctx,
      TOOL_LABEL,
      `${urlMetadata.length} URL${urlMetadata.length === 1 ? '' : 's'} retrieved`,
    );

    const usage = extractUsage(streamResult.usageMetadata);

    return {
      ...result,
      structuredContent: {
        answer: answerText,
        ...(urlMetadata.length > 0 ? { urlMetadata } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  } catch (err) {
    await reportFailure(ctx, TOOL_LABEL, err);
    return await logAndReturnError(ctx, 'analyze_url', err);
  }
}

export function registerAnalyzeUrlTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'analyze_url',
    {
      title: 'Analyze URL',
      description:
        'Fetch and analyze content from one or more public URLs using Gemini URL Context. ' +
        'Supports web pages, PDFs, images, and other public content (max 20 URLs).',
      inputSchema: AnalyzeUrlInputSchema,
      outputSchema: AnalyzeUrlOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: 'optional' },
    },
    createToolTaskHandlers(analyzeUrlWork),
  );
}
