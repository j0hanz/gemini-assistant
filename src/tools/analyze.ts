import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import type { Part } from '@google/genai';
import type { z } from 'zod/v4';

import { cleanupErrorLogger } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildFileAnalysisPrompt } from '../lib/model-prompts.js';
import { buildDiagramGenerationPrompt } from '../lib/model-prompts.js';
import { pickDefined } from '../lib/object.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { buildBaseStructuredOutput, safeValidateStructuredContent } from '../lib/response.js';
import { READONLY_NON_IDEMPOTENT_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import { type AnalyzeFileInput, type AnalyzeInput, AnalyzeInputSchema } from '../schemas/inputs.js';
import { AnalyzeOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig, DEFAULT_THINKING_LEVEL, getAI, MODEL } from '../client.js';
import { analyzeUrlWork } from './research.js';

const ANALYZE_FILE_TOOL_LABEL = 'Analyze File';
const ANALYZE_TOOL_LABEL = 'Analyze';
const ANALYZE_DIAGRAM_TOOL_LABEL = 'Analyze Diagram';

interface AnalyzeDiagramInput {
  goal: string;
  diagramType: 'mermaid' | 'plantuml';
  filePath?: string | undefined;
  filePaths?: string[] | undefined;
  maxOutputTokens?: AnalyzeInput['maxOutputTokens'];
  mediaResolution?: AnalyzeInput['mediaResolution'];
  safetySettings?: AnalyzeInput['safetySettings'];
  targetKind: AnalyzeInput['targetKind'];
  thinkingLevel?: AnalyzeInput['thinkingLevel'];
  urls?: string[] | undefined;
  validateSyntax?: boolean | undefined;
}

function requireAnalyzeFilePath(args: AnalyzeInput): string {
  if (args.filePath) {
    return args.filePath;
  }

  throw new Error('AnalyzeInput validation requires filePath when targetKind=file.');
}

function requireAnalyzeUrls(args: AnalyzeInput): string[] {
  if (args.urls) {
    return args.urls;
  }

  throw new Error('AnalyzeInput validation requires urls when targetKind=url.');
}

function requireAnalyzeFilePaths(args: AnalyzeInput): string[] {
  if (args.filePaths) {
    return args.filePaths;
  }

  throw new Error('AnalyzeInput validation requires filePaths when targetKind=multi.');
}

function requireAnalyzeDiagramType(args: AnalyzeInput): 'mermaid' | 'plantuml' {
  if (args.diagramType) {
    return args.diagramType;
  }

  throw new Error('AnalyzeInput validation requires diagramType when outputKind=diagram.');
}

const DIAGRAM_FENCED_PATTERN = /```(?:mermaid|plantuml)?\s*\n([\s\S]*?)```/;

function extractDiagram(text: string): { diagram: string; explanation: string } {
  const match = DIAGRAM_FENCED_PATTERN.exec(text);

  if (match?.[1]) {
    const diagram = match[1].trimEnd();
    const explanation = text.replace(DIAGRAM_FENCED_PATTERN, '').trim();
    return { diagram, explanation };
  }

  return { diagram: text, explanation: '' };
}

function formatAnalyzeDiagramMarkdown(
  diagram: string,
  diagramType: 'mermaid' | 'plantuml',
  explanation: string,
): string {
  const sections = [`### Diagram\n\n\`\`\`${diagramType}\n${diagram}\n\`\`\``];
  if (explanation) {
    sections.push(`### Explanation\n\n${explanation}`);
  }
  return sections.join('\n\n');
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
): Promise<{ parts: Part[]; uploadedCount: number }> {
  const contentParts: Part[] = [];
  const totalSteps = filesToUpload.length + 1;
  const progress = new ProgressReporter(ctx, ANALYZE_DIAGRAM_TOOL_LABEL);
  let uploadedCount = 0;

  for (let index = 0; index < filesToUpload.length; index++) {
    if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const filePath = filesToUpload[index];
    if (!filePath) continue;

    const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
    uploadedCount += 1;
    uploadedNames.push(uploaded.name);
    contentParts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
    contentParts.push({ text: `Source file: ${uploaded.displayPath}` });

    await progress.step(
      index + 1,
      totalSteps,
      `Uploaded ${filePath.split(/[\\/]/).pop() ?? filePath} (${String(index + 1)}/${String(filesToUpload.length)})`,
    );
  }

  return { parts: contentParts, uploadedCount };
}

function createAnalyzeFileWork(rootsFetcher: RootsFetcher) {
  return async function analyzeFileWork(
    {
      filePath,
      question,
      thinkingLevel,
      mediaResolution,
      maxOutputTokens,
      safetySettings,
    }: AnalyzeFileInput & {
      maxOutputTokens?: AnalyzeInput['maxOutputTokens'];
      safetySettings?: AnalyzeInput['safetySettings'];
    },
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    let uploadedFileName: string | undefined;

    const progress = new ProgressReporter(ctx, ANALYZE_FILE_TOOL_LABEL);

    try {
      await progress.step(0, 3, 'Uploading to Gemini');
      const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
      uploadedFileName = uploaded.name;

      await ctx.mcpReq.log('info', `Analyzing ${uploaded.displayPath} (${uploaded.mimeType})`);
      await progress.step(1, 3, 'Analyzing content');

      return await executor.runStream(
        ctx,
        'analyze_file',
        ANALYZE_FILE_TOOL_LABEL,
        () => {
          const { promptText, systemInstruction } = buildFileAnalysisPrompt({
            goal: question,
            kind: 'single',
          });

          return getAI().models.generateContentStream({
            model: MODEL,
            contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: promptText }],
            config: buildGenerateContentConfig(
              {
                systemInstruction,
                thinkingLevel,
                mediaResolution,
                maxOutputTokens,
                safetySettings,
              },
              ctx.mcpReq.signal,
            ),
          });
        },
        (_streamResult, textContent: string) => ({
          structuredContent: {
            summary: textContent || '',
          },
        }),
      );
    } finally {
      await deleteUploadedFiles(
        uploadedFileName ? [uploadedFileName] : [],
        cleanupErrorLogger(ctx),
      );
    }
  };
}

async function analyzeMultiFileWork(
  rootsFetcher: RootsFetcher,
  filePaths: string[],
  goal: string,
  thinkingLevel: AnalyzeInput['thinkingLevel'],
  ctx: ServerContext,
  maxOutputTokens?: AnalyzeInput['maxOutputTokens'],
  safetySettings?: AnalyzeInput['safetySettings'],
): Promise<CallToolResult> {
  const uploadedNames: string[] = [];
  const progress = new ProgressReporter(ctx, ANALYZE_TOOL_LABEL);
  const totalSteps = filePaths.length + 1;

  try {
    const contents: ({ text: string } | ReturnType<typeof createPartFromUri>)[] = [];
    for (const [index, filePath] of filePaths.entries()) {
      await progress.step(
        index,
        totalSteps,
        `Uploading ${filePath.split(/[\\/]/).pop() ?? filePath}`,
      );
      const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
      uploadedNames.push(uploaded.name);
      contents.push({ text: `File: ${uploaded.displayPath}` });
      contents.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
    }

    await progress.step(filePaths.length, totalSteps, 'Analyzing content');

    return await executor.runStream(
      ctx,
      'analyze',
      ANALYZE_TOOL_LABEL,
      () => {
        const prompt = buildFileAnalysisPrompt({
          attachedParts: contents,
          goal,
          kind: 'multi',
        });

        return getAI().models.generateContentStream({
          model: MODEL,
          contents: prompt.promptParts,
          config: buildGenerateContentConfig(
            {
              systemInstruction: prompt.systemInstruction,
              thinkingLevel,
              maxOutputTokens,
              safetySettings,
            },
            ctx.mcpReq.signal,
          ),
        });
      },
      (_streamResult, textContent: string) => ({
        structuredContent: {
          summary: textContent || '',
          targetKind: 'multi',
          analyzedPaths: filePaths,
        },
      }),
    );
  } finally {
    await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx));
  }
}

async function analyzeDiagramWork(
  rootsFetcher: RootsFetcher,
  args: AnalyzeDiagramInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const uploadedNames: string[] = [];
  const progress = new ProgressReporter(ctx, ANALYZE_DIAGRAM_TOOL_LABEL);

  try {
    let attachedParts: Part[] = [];
    let uploadedCount = 0;

    if (args.targetKind === 'file' || args.targetKind === 'multi') {
      const filesToUpload = collectDiagramSourceFiles(
        args.targetKind === 'file' ? args.filePath : undefined,
        args.targetKind === 'multi' ? args.filePaths : undefined,
      );
      const uploaded = await uploadDiagramSourceFiles(
        filesToUpload,
        ctx,
        rootsFetcher,
        uploadedNames,
      );
      attachedParts = uploaded.parts;
      uploadedCount = uploaded.uploadedCount;
    } else {
      attachedParts = [
        {
          text: `URLs:\n${args.urls?.join('\n') ?? ''}`,
        },
      ];
    }

    const totalSteps = uploadedCount > 0 ? uploadedCount + 1 : 1;
    await progress.step(uploadedCount, totalSteps, `Generating ${args.diagramType} diagram`);
    await ctx.mcpReq.log('info', `Generating ${args.diagramType} diagram`);

    const prompt = buildDiagramGenerationPrompt({
      attachedParts,
      description: args.goal,
      diagramType: args.diagramType,
      validateSyntax: args.validateSyntax,
    });

    return await executor.runStream(
      ctx,
      'analyze_diagram',
      ANALYZE_DIAGRAM_TOOL_LABEL,
      () =>
        getAI().models.generateContentStream({
          model: MODEL,
          contents: prompt.promptParts,
          config: buildGenerateContentConfig(
            {
              systemInstruction: prompt.systemInstruction,
              thinkingLevel: args.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
              maxOutputTokens: args.maxOutputTokens,
              safetySettings: args.safetySettings,
              ...buildOrchestrationConfig({
                toolProfile:
                  args.targetKind === 'url' ? 'url' : args.validateSyntax ? 'code' : 'none',
              }),
            },
            ctx.mcpReq.signal,
          ),
        }),
      (_streamResult, textContent: string) => {
        const { diagram, explanation } = extractDiagram(textContent);
        const diagramType = args.diagramType;
        const formatted = formatAnalyzeDiagramMarkdown(diagram, diagramType, explanation);

        return {
          resultMod: () => ({
            content: [{ type: 'text' as const, text: formatted }],
          }),
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
}

async function analyzeWork(
  rootsFetcher: RootsFetcher,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result =
    args.outputKind === 'diagram'
      ? await analyzeDiagramWork(rootsFetcher, args as AnalyzeDiagramInput, ctx)
      : await runAnalyzeTarget(rootsFetcher, fileWork, args, ctx);

  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent ?? {};
  return safeValidateStructuredContent(
    'analyze',
    AnalyzeOutputSchema,
    buildAnalyzeStructuredContent(args, ctx, structured),
    result,
  );
}

async function runAnalyzeTarget(
  rootsFetcher: RootsFetcher,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (args.targetKind === 'file') {
    return await fileWork(
      {
        filePath: requireAnalyzeFilePath(args),
        question: args.goal,
        thinkingLevel: args.thinkingLevel,
        mediaResolution: args.mediaResolution,
        maxOutputTokens: args.maxOutputTokens,
        safetySettings: args.safetySettings,
      },
      ctx,
    );
  }

  if (args.targetKind === 'url') {
    return await analyzeUrlWork(
      {
        urls: requireAnalyzeUrls(args),
        question: args.goal,
        thinkingLevel: args.thinkingLevel,
        maxOutputTokens: args.maxOutputTokens,
        safetySettings: args.safetySettings,
      },
      ctx,
    );
  }

  return await analyzeMultiFileWork(
    rootsFetcher,
    requireAnalyzeFilePaths(args),
    args.goal,
    args.thinkingLevel,
    ctx,
    args.maxOutputTokens,
    args.safetySettings,
  );
}

function getDiagramString(diagram: unknown): string {
  return typeof diagram === 'string' && diagram ? diagram : '';
}

function getExplanationString(explanation: unknown): string | undefined {
  return typeof explanation === 'string' && explanation ? explanation : undefined;
}

function getAnalyzedPaths(args: AnalyzeInput): string[] | undefined {
  if (args.targetKind === 'file') return [requireAnalyzeFilePath(args)];
  if (args.targetKind === 'multi') return requireAnalyzeFilePaths(args);
  return undefined;
}

function buildAnalyzeStructuredContent(
  args: AnalyzeInput,
  ctx: ServerContext,
  structured: Record<string, unknown>,
): z.infer<typeof AnalyzeOutputSchema> {
  const base = {
    ...buildBaseStructuredOutput(ctx.task?.id),
    functionCalls: structured.functionCalls,
    thoughts: structured.thoughts,
    toolEvents: structured.toolEvents,
    usage: structured.usage,
  };

  if (args.outputKind === 'diagram') {
    const diagramType = requireAnalyzeDiagramType(args);

    return pickDefined({
      ...base,
      kind: 'diagram' as const,
      targetKind: args.targetKind,
      diagramType,
      diagram: getDiagramString(structured.diagram),
      explanation: getExplanationString(structured.explanation),
      urlMetadata: structured.urlMetadata,
      analyzedPaths: getAnalyzedPaths(args),
    }) as unknown as z.infer<typeof AnalyzeOutputSchema>;
  }

  return pickDefined({
    ...base,
    kind: 'summary' as const,
    targetKind: args.targetKind,
    summary: typeof structured.summary === 'string' ? structured.summary : '',
    urlMetadata: structured.urlMetadata,
    analyzedPaths: args.targetKind === 'multi' ? requireAnalyzeFilePaths(args) : undefined,
  }) as unknown as z.infer<typeof AnalyzeOutputSchema>;
}

export function registerAnalyzeTool(server: McpServer, taskMessageQueue: TaskMessageQueue): void {
  const rootsFetcher = buildServerRootsFetcher(server);
  const fileWork = createAnalyzeFileWork(rootsFetcher);

  registerTaskTool(
    server,
    'analyze',
    {
      title: 'Analyze',
      description:
        'Analyze one file, one or more public URLs, a small file set, or generate a diagram.',
      inputSchema: AnalyzeInputSchema,
      outputSchema: AnalyzeOutputSchema,
      annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: AnalyzeInput, ctx: ServerContext) => analyzeWork(rootsFetcher, fileWork, args, ctx),
  );
}
