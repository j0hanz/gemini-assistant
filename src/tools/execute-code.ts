import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Outcome } from '@google/genai';
import type { Part } from '@google/genai';

import { AskThinkingLevel, buildGenerateContentConfig } from '../lib/config-utils.js';
import { errorResult } from '../lib/errors.js';
import { handleToolExecution } from '../lib/streaming.js';
import { createToolTaskHandlers, MUTABLE_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { ExecuteCodeInputSchema } from '../schemas/inputs.js';
import { ExecuteCodeOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const EXECUTE_CODE_SYSTEM_INSTRUCTION =
  'Generate clean, working code. Include brief comments for non-obvious logic. ' +
  'Handle edge cases. Provide a concise explanation after execution.';

interface ExecutionSummary {
  code: string;
  output: string;
  explanation: string;
  executionFailed: boolean;
}

function formatExecuteCodeMarkdown(code: string, output: string, explanation: string): string {
  const sections: string[] = [];
  if (code) sections.push(`### Code\n\n\`\`\`\n${code}\n\`\`\``);
  if (output) sections.push(`### Output\n\n\`\`\`\n${output}\n\`\`\``);
  if (explanation) sections.push(`### Explanation\n\n${explanation}`);
  return sections.join('\n\n') || 'No output generated.';
}

function extractFencedCodeBlocks(text: string): { code: string[]; explanation: string } {
  const fenced = /```[\w]*\n([\s\S]*?)```/g;
  const code: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fenced.exec(text)) !== null) {
    const block = match[1];
    if (block !== undefined) code.push(block.trimEnd());
  }

  return {
    code,
    explanation: text.replace(/```[\w]*\n[\s\S]*?```/g, '').trim(),
  };
}

function recoverCodeFromExplanation(
  codeLines: string[],
  explanationLines: string[],
): { codeLines: string[]; explanationLines: string[] } {
  if (codeLines.length > 0 || explanationLines.length === 0) {
    return { codeLines, explanationLines };
  }

  const extracted = extractFencedCodeBlocks(explanationLines.join('\n'));
  if (extracted.code.length === 0) {
    return { codeLines, explanationLines };
  }

  return {
    codeLines: extracted.code,
    explanationLines: extracted.explanation ? [extracted.explanation] : [],
  };
}

function summarizeExecutionParts(parts: readonly Part[]): ExecutionSummary {
  const codeLines: string[] = [];
  const outputLines: string[] = [];
  const explanationLines: string[] = [];
  let executionFailed = false;

  for (const part of parts) {
    if (part.thought) continue;

    if (part.executableCode) {
      codeLines.push(part.executableCode.code ?? '');
      continue;
    }

    if (part.codeExecutionResult) {
      outputLines.push(part.codeExecutionResult.output ?? '');
      if (
        part.codeExecutionResult.outcome &&
        part.codeExecutionResult.outcome !== Outcome.OUTCOME_OK
      ) {
        executionFailed = true;
      }
      continue;
    }

    if (part.text) {
      explanationLines.push(part.text);
    }
  }

  const recovered = recoverCodeFromExplanation(codeLines, explanationLines);

  return {
    code: recovered.codeLines.join('\n'),
    output: outputLines.join('\n'),
    explanation: recovered.explanationLines.join('\n'),
    executionFailed,
  };
}

async function executeCodeWork(
  {
    task,
    language,
    thinkingLevel,
  }: { task: string; language?: string | undefined; thinkingLevel?: AskThinkingLevel | undefined },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Execute Code';
  const prompt = [task, ...(language ? [`Language: ${language}`] : [])].join('\n\n');

  return await handleToolExecution(
    ctx,
    'execute_code',
    TOOL_LABEL,
    () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: prompt,
        config: {
          tools: [{ codeExecution: {} }],
          ...buildGenerateContentConfig(
            {
              systemInstruction: EXECUTE_CODE_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'LOW',
            },
            ctx.mcpReq.signal,
          ),
        },
      }),
    (streamResult) => {
      const { parts } = streamResult;
      if (parts.length === 0) {
        return {
          resultMod: () => errorResult('execute_code: prompt blocked by safety filter (unknown)'),
        };
      }

      const summary = summarizeExecutionParts(parts);

      return {
        resultMod: () => ({
          isError: summary.executionFailed ? true : undefined,
          content: [
            {
              type: 'text',
              text: formatExecuteCodeMarkdown(summary.code, summary.output, summary.explanation),
            },
          ],
        }),
        structuredContent: {
          code: summary.code,
          output: summary.output,
          explanation: summary.explanation,
        },
        reportMessage: summary.executionFailed ? 'execution failed' : 'completed',
      };
    },
  );
}

export function registerExecuteCodeTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'execute_code',
    {
      title: 'Execute Code',
      description:
        'Generate and execute code in a Gemini sandbox. Returns code, output, and explanation.',
      inputSchema: ExecuteCodeInputSchema,
      outputSchema: ExecuteCodeOutputSchema,
      annotations: { ...MUTABLE_ANNOTATIONS, openWorldHint: false },
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(executeCodeWork),
  );
}
