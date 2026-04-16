import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';
import { InMemoryTaskMessageQueue } from '@modelcontextprotocol/server';

import { createPartFromUri, Outcome } from '@google/genai';
import type { Part } from '@google/genai';

import {
  cleanupErrorLogger,
  handleToolError,
  responseBlockedResult,
  sendProgress,
} from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { handleToolExecution } from '../lib/streaming.js';
import { MUTABLE_ANNOTATIONS, READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import {
  type AnalyzeFileInput,
  AnalyzeFileInputSchema,
  type ExecuteCodeInput,
  ExecuteCodeInputSchema,
} from '../schemas/inputs.js';
import { AnalyzeFileOutputSchema, ExecuteCodeOutputSchema } from '../schemas/outputs.js';
import { withCurrentWorkspaceRoot } from '../schemas/shared.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const ANALYZE_FILE_TOOL_LABEL = 'Analyze File';
const EXECUTE_CODE_TOOL_LABEL = 'Execute Code';
const EXECUTE_CODE_RUNTIME = 'python' as const;

const ANALYZE_FILE_SYSTEM_INSTRUCTION =
  'Answer from the file only. Cite relevant sections, lines, or elements.';

const EXECUTE_CODE_SYSTEM_INSTRUCTION =
  'Write code that runs. Comment only non-obvious logic. Handle likely edge cases. Explain the result briefly.';

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

function createAnalyzeFileWork(rootsFetcher: RootsFetcher) {
  return async function analyzeFileWork(
    { filePath, question, thinkingLevel, mediaResolution }: AnalyzeFileInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    let uploadedFileName: string | undefined;

    try {
      await sendProgress(ctx, 0, 3, `${ANALYZE_FILE_TOOL_LABEL}: Uploading to Gemini`);
      const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
      uploadedFileName = uploaded.name;

      await ctx.mcpReq.log('info', `Analyzing ${uploaded.displayPath} (${uploaded.mimeType})`);
      await sendProgress(ctx, 1, 3, `${ANALYZE_FILE_TOOL_LABEL}: Analyzing content`);

      return await handleToolExecution(
        ctx,
        'analyze_file',
        ANALYZE_FILE_TOOL_LABEL,
        () =>
          getAI().models.generateContentStream({
            model: MODEL,
            contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: question }],
            config: buildGenerateContentConfig(
              {
                systemInstruction: ANALYZE_FILE_SYSTEM_INSTRUCTION,
                thinkingLevel: thinkingLevel ?? 'LOW',
                ...(mediaResolution ? { mediaResolution } : {}),
              },
              ctx.mcpReq.signal,
            ),
          }),
        (_streamResult, textContent) => ({
          structuredContent: {
            analysis: textContent || '',
          },
        }),
      );
    } catch (err) {
      return await handleToolError(ctx, 'analyze_file', ANALYZE_FILE_TOOL_LABEL, err);
    } finally {
      await deleteUploadedFiles(
        uploadedFileName ? [uploadedFileName] : [],
        cleanupErrorLogger(ctx),
      );
    }
  };
}

async function executeCodeWork(
  { task, language, thinkingLevel }: ExecuteCodeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  await sendProgress(ctx, 0, undefined, `${EXECUTE_CODE_TOOL_LABEL}: Preparing sandbox`);
  await ctx.mcpReq.log('info', `Executing code${language ? ` [${language}]` : ''}`);
  const prompt = [
    task,
    ...(language
      ? [`Requested language (advisory only; execution runtime remains Python): ${language}`]
      : []),
  ].join('\n\n');

  return await handleToolExecution(
    ctx,
    'execute_code',
    EXECUTE_CODE_TOOL_LABEL,
    () =>
      getAI().models.generateContentStream({
        model: MODEL,
        contents: prompt,
        config: buildGenerateContentConfig(
          {
            systemInstruction: EXECUTE_CODE_SYSTEM_INSTRUCTION,
            thinkingLevel: thinkingLevel ?? 'LOW',
            ...buildOrchestrationConfig({ toolProfile: 'code' }),
          },
          ctx.mcpReq.signal,
        ),
      }),
    (streamResult) => {
      if (streamResult.parts.length === 0) {
        return {
          resultMod: () => responseBlockedResult('execute_code'),
        };
      }

      const summary = summarizeExecutionParts(streamResult.parts);

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
          runtime: EXECUTE_CODE_RUNTIME,
          ...(language ? { requestedLanguage: language } : {}),
        },
        reportMessage: summary.executionFailed ? 'execution failed' : 'completed',
      };
    },
  );
}

export function registerAnalyzeFileTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue = new InMemoryTaskMessageQueue(),
): void {
  registerTaskTool(
    server,
    'analyze_file',
    {
      title: ANALYZE_FILE_TOOL_LABEL,
      description: withCurrentWorkspaceRoot(
        'Upload a file to Gemini and ask questions about it (PDFs, images, code files, etc.).',
      ),
      inputSchema: AnalyzeFileInputSchema,
      outputSchema: AnalyzeFileOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    taskMessageQueue,
    createAnalyzeFileWork(buildServerRootsFetcher(server)),
  );
}

export function registerExecuteCodeTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue = new InMemoryTaskMessageQueue(),
): void {
  registerTaskTool(
    server,
    'execute_code',
    {
      title: EXECUTE_CODE_TOOL_LABEL,
      description:
        'Generate and execute code in a Gemini sandbox. Execution runs in Python. ' +
        'Returns code, output, explanation, and runtime metadata.',
      inputSchema: ExecuteCodeInputSchema,
      outputSchema: ExecuteCodeOutputSchema,
      annotations: { ...MUTABLE_ANNOTATIONS, openWorldHint: false },
    },
    taskMessageQueue,
    executeCodeWork,
  );
}
