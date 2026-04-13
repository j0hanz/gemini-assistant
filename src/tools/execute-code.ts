import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Outcome } from '@google/genai';

import { AskThinkingLevel, buildGenerateContentConfig } from '../lib/config-utils.js';
import { reportCompletion } from '../lib/context.js';
import { errorResult, handleToolError } from '../lib/errors.js';
import { executeToolStream, extractUsage } from '../lib/streaming.js';
import { createToolTaskHandlers, MUTABLE_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { ExecuteCodeInputSchema } from '../schemas/inputs.js';
import { ExecuteCodeOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const EXECUTE_CODE_SYSTEM_INSTRUCTION =
  'Generate clean, working code. Include brief comments for non-obvious logic. ' +
  'Handle edge cases. Provide a concise explanation after execution.';

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

async function executeCodeWork(
  {
    task,
    language,
    thinkingLevel,
  }: { task: string; language?: string | undefined; thinkingLevel?: AskThinkingLevel | undefined },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Execute Code';
  try {
    const prompt = [task, ...(language ? [`Language: ${language}`] : [])].join('\n\n');
    const { streamResult } = await executeToolStream(ctx, 'execute_code', TOOL_LABEL, () =>
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
    );

    const { parts } = streamResult;
    if (parts.length === 0) {
      return errorResult('execute_code: prompt blocked by safety filter (unknown)');
    }

    const codeLines: string[] = [];
    const outputLines: string[] = [];
    const explanationLines: string[] = [];
    let executionFailed = false;

    for (const part of parts) {
      if (part.thought) continue;
      if (part.executableCode) {
        codeLines.push(part.executableCode.code ?? '');
      } else if (part.codeExecutionResult) {
        outputLines.push(part.codeExecutionResult.output ?? '');
        if (
          part.codeExecutionResult.outcome &&
          part.codeExecutionResult.outcome !== Outcome.OUTCOME_OK
        ) {
          executionFailed = true;
        }
      } else if (part.text) {
        explanationLines.push(part.text);
      }
    }

    // If no executable code was returned but there is an explanation, attempt to extract code from the explanation (e.g. from a fenced code block).
    if (codeLines.length === 0 && explanationLines.length > 0) {
      const extracted = extractFencedCodeBlocks(explanationLines.join('\n'));
      if (extracted.code.length > 0) {
        codeLines.push(...extracted.code);
        explanationLines.length = 0;
        if (extracted.explanation) explanationLines.push(extracted.explanation);
      }
    }

    const code = codeLines.join('\n');
    const output = outputLines.join('\n');
    const explanation = explanationLines.join('\n');

    if (executionFailed) {
      await reportCompletion(ctx, TOOL_LABEL, 'execution failed');
      const usage = extractUsage(streamResult.usageMetadata);
      const structured = {
        code,
        output,
        explanation,
        ...(streamResult.thoughtText ? { thoughts: streamResult.thoughtText } : {}),
        ...(usage ? { usage } : {}),
      };
      return {
        content: [{ type: 'text', text: formatExecuteCodeMarkdown(code, output, explanation) }],
        structuredContent: structured,
        isError: true,
      };
    }

    const usage = extractUsage(streamResult.usageMetadata);
    const structured = { code, output, explanation, ...(usage ? { usage } : {}) };

    await reportCompletion(ctx, TOOL_LABEL, 'completed');
    return {
      content: [{ type: 'text', text: formatExecuteCodeMarkdown(code, output, explanation) }],
      structuredContent: structured,
    };
  } catch (err) {
    return await handleToolError(ctx, 'execute_code', TOOL_LABEL, err);
  }
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
