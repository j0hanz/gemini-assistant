import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { buildGenerateContentConfig } from '../lib/config-utils.js';
import {
  appendSources,
  collectGroundedSources,
  formatCountLabel,
  pickDefined,
} from '../lib/response.js';
import { handleToolExecution } from '../lib/streaming.js';
import { createToolTaskHandlers, READONLY_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { type AgenticSearchInput, AgenticSearchInputSchema } from '../schemas/inputs.js';
import { AgenticSearchOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const TOOL_LABEL = 'Agentic Search';

const AGENT_SYSTEM_INSTRUCTION =
  'You are a deep research agent. Given a topic, conduct thorough multi-faceted research.\n\n' +
  'Process:\n' +
  '1. Break the topic into distinct sub-questions.\n' +
  '2. Use Google Search to investigate each sub-question.\n' +
  '3. Use Code Execution to analyze data, compute comparisons, build tables, or verify calculations.\n' +
  '4. Synthesize all findings into a comprehensive, well-structured markdown report.\n' +
  '5. Use headings, bullet points, and tables where appropriate.\n' +
  '6. Be factual — only report what search results confirm.\n' +
  '7. Include specific data points, numbers, and dates when available.\n\n' +
  'IMPORTANT: Actively use code execution for any data-heavy analysis, ranking, sorting, or comparison tasks.';

function buildAgenticSearchReportMessage(sourceCount: number, responseLength: number): string {
  return sourceCount > 0
    ? `${formatCountLabel(sourceCount, 'source')} found`
    : `responded (${responseLength} chars)`;
}

async function agenticSearchWork(
  { topic, searchDepth, thinkingLevel }: AgenticSearchInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const depthInstruction =
    searchDepth <= 2
      ? 'Do a focused search covering 2-3 key aspects.'
      : searchDepth <= 3
        ? 'Do a thorough search covering 4-5 key aspects.'
        : 'Do an exhaustive search covering as many aspects as possible.';

  const prompt =
    `Research this topic comprehensively: ${topic}\n\n` +
    `${depthInstruction}\n` +
    'Search for multiple different aspects and compile a detailed report.';

  return await handleToolExecution(
    ctx,
    'agentic_search',
    TOOL_LABEL,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }, { codeExecution: {} }],
          toolConfig: { includeServerSideToolInvocations: true },
          ...buildGenerateContentConfig(
            {
              systemInstruction: AGENT_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'MEDIUM',
            },
            ctx.mcpReq.signal,
          ),
        },
      }),
    (streamResult, textContent) => {
      const sources = collectGroundedSources(streamResult.groundingMetadata);

      const contentAdditions: CallToolResult['content'] = [];
      appendSources(contentAdditions, sources);

      return {
        resultMod: (r) => ({
          content: [...r.content, ...contentAdditions],
        }),
        structuredContent: pickDefined({
          report: textContent,
          sources,
          toolsUsed: streamResult.toolsUsed.length > 0 ? streamResult.toolsUsed : undefined,
        }),
        reportMessage: buildAgenticSearchReportMessage(sources.length, textContent.length),
      };
    },
  );
}

export function registerAgenticSearchTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'agentic_search',
    {
      title: 'Agentic Search',
      description:
        'Deep research with Google Search grounding and code execution. ' +
        'Uses tool combination to let Gemini autonomously search multiple aspects ' +
        'and compile a comprehensive report. Emits progress notifications.',
      inputSchema: AgenticSearchInputSchema,
      outputSchema: AgenticSearchOutputSchema,
      annotations: READONLY_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(agenticSearchWork),
  );
}
