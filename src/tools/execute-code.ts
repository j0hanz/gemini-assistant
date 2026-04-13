import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Outcome } from '@google/genai';

import { extractToolContext } from '../lib/context.js';
import { errorResult, logAndReturnError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import { consumeStreamWithProgress } from '../lib/streaming.js';
import { ExecuteCodeInputSchema } from '../schemas/inputs.js';
import { ExecuteCodeOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

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
      try {
        const prompt = language ? `${task}\n\nPreferred language: ${language}` : task;

        const stream = await withRetry(
          () =>
            ai.models.generateContentStream({
              model: MODEL,
              contents: prompt,
              config: {
                tools: [{ codeExecution: {} }],
                thinkingConfig: { includeThoughts: true },
                abortSignal: tc.signal,
              },
            }),
          { signal: tc.signal },
        );

        const streamResult = await consumeStreamWithProgress(stream, tc.reportProgress, tc.signal);

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
          return errorResult(
            `execute_code: code execution failed.\nCode:\n${code}\nOutput:\n${output}`,
          );
        }

        const structured = { code, output, explanation };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (err) {
        return await logAndReturnError(tc.log, 'execute_code', err);
      }
    },
  );
}
