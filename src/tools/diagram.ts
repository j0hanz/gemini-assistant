import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri, Outcome } from '@google/genai';
import type { Part } from '@google/genai';

import { cleanupErrorLogger, SafetyError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildDiagramGenerationPrompt } from '../lib/model-prompts.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { MUTABLE_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { type RootsFetcher } from '../lib/validation.js';
import {
  type ExecuteCodeInput,
  ExecuteCodeInputSchema,
  type GenerateDiagramInput,
} from '../schemas/inputs.js';
import { ExecuteCodeOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const DIAGRAM_TOOL_LABEL = 'Generate Diagram';
const EXECUTE_CODE_TOOL_LABEL = 'Execute Code';
const EXECUTE_CODE_RUNTIME = 'python' as const;

const DIAGRAM_FENCED_PATTERN = /```(?:mermaid|plantuml)?\s*\n([\s\S]*?)```/;

const EXECUTE_CODE_SYSTEM_INSTRUCTION =
  'Write code that runs. Comment only non-obvious logic. Handle likely edge cases. Explain the result briefly.';

function extractDiagram(text: string): { diagram: string; explanation: string } {
  const match = DIAGRAM_FENCED_PATTERN.exec(text);

  if (match?.[1]) {
    const diagram = match[1].trimEnd();
    const explanation = text.replace(DIAGRAM_FENCED_PATTERN, '').trim();
    return { diagram, explanation };
  }

  return { diagram: text, explanation: '' };
}

function collectDiagramSourceFiles(
  sourceFilePath: string | undefined,
  sourceFilePaths: string[] | undefined,
): string[] {
  return [...(sourceFilePath ? [sourceFilePath] : []), ...(sourceFilePaths ?? [])];
}

async function uploadDiagramSourceFiles(
  filesToUpload: string[],
  ctx: ServerContext,
  rootsFetcher: RootsFetcher,
  uploadedNames: string[],
): Promise<Part[]> {
  const contentParts: Part[] = [];
  const totalSteps = filesToUpload.length + 1;
  const progress = new ProgressReporter(ctx, DIAGRAM_TOOL_LABEL);

  for (let index = 0; index < filesToUpload.length; index++) {
    if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const filePath = filesToUpload[index];
    if (!filePath) continue;

    await progress.step(
      index,
      totalSteps,
      `Uploading ${filePath.split(/[\\/]/).pop() ?? filePath} (${String(index + 1)}/${String(filesToUpload.length)})`,
    );
    const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
    uploadedNames.push(uploaded.name);
    contentParts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
    contentParts.push({ text: `Source file: ${uploaded.displayPath}` });
  }

  return contentParts;
}

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

export function createDiagramWork(rootsFetcher: RootsFetcher) {
  return async function diagramWork(
    args: GenerateDiagramInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const { description, diagramType, thinkingLevel, googleSearch, cacheName, validateSyntax } =
      args;
    const sourceFilePath = 'sourceFilePath' in args ? args.sourceFilePath : undefined;
    const sourceFilePaths = 'sourceFilePaths' in args ? args.sourceFilePaths : undefined;
    const uploadedNames: string[] = [];

    try {
      const filesToUpload = collectDiagramSourceFiles(sourceFilePath, sourceFilePaths);
      const contentParts =
        filesToUpload.length > 0
          ? await uploadDiagramSourceFiles(filesToUpload, ctx, rootsFetcher, uploadedNames)
          : [];

      const hasFiles = filesToUpload.length > 0;
      const progress = new ProgressReporter(ctx, DIAGRAM_TOOL_LABEL);
      await progress.send(
        hasFiles ? filesToUpload.length : 0,
        hasFiles ? filesToUpload.length + 1 : undefined,
        `Generating ${diagramType} diagram`,
      );
      await ctx.mcpReq.log('info', `Generating ${diagramType} diagram`);

      const prompt = buildDiagramGenerationPrompt({
        attachedParts: contentParts,
        cacheName,
        description,
        diagramType,
        validateSyntax,
      });

      return await executor.runStream(
        ctx,
        'generate_diagram',
        DIAGRAM_TOOL_LABEL,
        () =>
          getAI().models.generateContentStream({
            model: MODEL,
            contents: prompt.promptParts,
            config: buildGenerateContentConfig(
              {
                systemInstruction: prompt.systemInstruction,
                thinkingLevel: thinkingLevel ?? 'LOW',
                cacheName,
                ...buildOrchestrationConfig({
                  toolProfile:
                    googleSearch && validateSyntax
                      ? 'search_code'
                      : googleSearch
                        ? 'search'
                        : validateSyntax
                          ? 'code'
                          : 'none',
                }),
              },
              ctx.mcpReq.signal,
            ),
          }),
        (_streamResult, textContent: string) => {
          const { diagram, explanation } = extractDiagram(textContent);

          return {
            structuredContent: {
              diagram,
              diagramType,
              ...(explanation ? { explanation } : {}),
            },
          };
        },
      );
    } finally {
      await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx));
    }
  };
}

async function executeCodeWork(
  { task, language, thinkingLevel }: ExecuteCodeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const progress = new ProgressReporter(ctx, EXECUTE_CODE_TOOL_LABEL);
  await progress.send(0, undefined, 'Preparing sandbox');
  await ctx.mcpReq.log('info', `Executing code${language ? ` [${language}]` : ''}`);
  const prompt = [
    task,
    ...(language
      ? [`Requested language (advisory only; execution runtime remains Python): ${language}`]
      : []),
  ].join('\n\n');

  return await executor.runStream(
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
          resultMod: () => new SafetyError('execute_code', 'response_blocked').toToolResult(),
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

export function registerExecuteCodeTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
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
