import type { McpServer } from '@modelcontextprotocol/server';

import { errorResult } from '../lib/errors.js';
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
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ task, language }) => {
      try {
        const prompt = language ? `${task}\n\nPreferred language: ${language}` : task;

        const response = await ai.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: {
            tools: [{ codeExecution: {} }],
          },
        });

        let code = '';
        let output = '';
        let explanation = '';

        const parts = response.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.executableCode) {
            code += (code ? '\n' : '') + (part.executableCode.code ?? '');
          } else if (part.codeExecutionResult) {
            output += (output ? '\n' : '') + (part.codeExecutionResult.output ?? '');
          } else if (part.text) {
            explanation += (explanation ? '\n' : '') + part.text;
          }
        }

        const structured = { code, output, explanation };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `execute_code failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
