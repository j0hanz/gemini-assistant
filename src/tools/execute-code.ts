import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Outcome } from '@google/genai';

import { extractToolContext, reportCompletion, reportFailure } from '../lib/context.js';
import { errorResult, logAndReturnError } from '../lib/errors.js';
import { executeToolStream } from '../lib/streaming.js';
import { ExecuteCodeInputSchema } from '../schemas/inputs.js';
import { ExecuteCodeOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const EXECUTE_CODE_SYSTEM_INSTRUCTION =
  'Generate clean, working code that solves the task. Include brief comments for non-obvious logic. ' +
  'Handle edge cases. Provide a concise explanation of the approach after execution.';

export function registerExecuteCodeTool(server: McpServer): void {
  server.registerTool(
    'execute_code',
    {
      title: 'Execute Code',
      description:
        'Have Gemini generate and execute code in a sandbox. Returns the code, output, and explanation.',
      inputSchema: ExecuteCodeInputSchema,
      outputSchema: ExecuteCodeOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ task, language }, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      const TOOL_LABEL = 'Execute Code';
      try {
        const prompt = [
          task,
          ...(language ? [`Preferred language: ${language}`] : []),
          'Return working code. Handle edge cases. Keep output concise.',
        ].join('\n\n');

        const { streamResult } = await executeToolStream(tc, 'execute_code', TOOL_LABEL, () =>
          ai.models.generateContentStream({
            model: MODEL,
            contents: prompt,
            config: {
              tools: [{ codeExecution: {} }],
              systemInstruction: EXECUTE_CODE_SYSTEM_INSTRUCTION,
              thinkingConfig: { includeThoughts: true },
              maxOutputTokens: 8192,
              abortSignal: tc.signal,
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

        const code = codeLines.join('\n');
        const output = outputLines.join('\n');
        const explanation = explanationLines.join('\n');

        if (executionFailed) {
          await reportCompletion(tc.reportProgress, TOOL_LABEL, 'execution failed');
          const structured = { code, output, explanation };
          return {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError: true,
          };
        }

        const structured = { code, output, explanation };

        await reportCompletion(tc.reportProgress, TOOL_LABEL, 'completed');
        return {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (err) {
        await reportFailure(tc.reportProgress, TOOL_LABEL, err);
        return await logAndReturnError(tc.log, 'execute_code', err);
      }
    },
  );
}
