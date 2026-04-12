import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { Outcome } from '@google/genai';

import { extractToolContext } from '../lib/context.js';
import { errorResult, geminiErrorResult } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
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

        const response = await withRetry(
          () =>
            ai.models.generateContent({
              model: MODEL,
              contents: prompt,
              config: {
                tools: [{ codeExecution: {} }],
                abortSignal: tc.signal,
              },
            }),
          { signal: tc.signal },
        );

        const candidate = response.candidates?.[0];
        if (!candidate) {
          const blockReason = response.promptFeedback?.blockReason ?? 'unknown';
          return errorResult(`execute_code: prompt blocked by safety filter (${blockReason})`);
        }

        let code = '';
        let output = '';
        let explanation = '';
        let executionFailed = false;

        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          if (part.executableCode) {
            code += (code ? '\n' : '') + (part.executableCode.code ?? '');
          } else if (part.codeExecutionResult) {
            output += (output ? '\n' : '') + (part.codeExecutionResult.output ?? '');
            if (
              part.codeExecutionResult.outcome &&
              part.codeExecutionResult.outcome !== Outcome.OUTCOME_OK
            ) {
              executionFailed = true;
            }
          } else if (part.text) {
            explanation += (explanation ? '\n' : '') + part.text;
          }
        }

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
        return geminiErrorResult('execute_code', err);
      }
    },
  );
}
