import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import type { Part } from '@google/genai';

import { cleanupErrorLogger } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildFileAnalysisPrompt } from '../lib/model-prompts.js';
import { buildDiagramGenerationPrompt } from '../lib/model-prompts.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { buildBaseStructuredOutput, validateStructuredContent } from '../lib/response.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
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
  mediaResolution?: AnalyzeInput['mediaResolution'];
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
): Promise<Part[]> {
  const contentParts: Part[] = [];
  const totalSteps = filesToUpload.length + 1;
  const progress = new ProgressReporter(ctx, ANALYZE_DIAGRAM_TOOL_LABEL);

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

function createAnalyzeFileWork(rootsFetcher: RootsFetcher) {
  return async function analyzeFileWork(
    { filePath, question, thinkingLevel, mediaResolution }: AnalyzeFileInput,
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
              },
              ctx.mcpReq.signal,
            ),
          });
        },
        (_streamResult, textContent: string) => ({
          structuredContent: {
            analysis: textContent || '',
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
): Promise<CallToolResult> {
  const uploadedNames: string[] = [];

  try {
    return await executor.runStream(
      ctx,
      'analyze',
      ANALYZE_TOOL_LABEL,
      async () => {
        const contents: ({ text: string } | ReturnType<typeof createPartFromUri>)[] = [];
        for (const filePath of filePaths) {
          const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
          uploadedNames.push(uploaded.name);
          contents.push({ text: `File: ${uploaded.displayPath}` });
          contents.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
        }
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

    if (args.targetKind === 'file' || args.targetKind === 'multi') {
      const filesToUpload = collectDiagramSourceFiles(
        args.targetKind === 'file' ? args.filePath : undefined,
        args.targetKind === 'multi' ? args.filePaths : undefined,
      );
      attachedParts = await uploadDiagramSourceFiles(
        filesToUpload,
        ctx,
        rootsFetcher,
        uploadedNames,
      );
    } else {
      attachedParts = [
        {
          text: `URLs:\n${args.urls?.join('\n') ?? ''}`,
        },
      ];
    }

    const totalSteps = attachedParts.length > 0 ? attachedParts.length + 1 : 1;
    await progress.send(attachedParts.length, totalSteps, `Generating ${args.diagramType} diagram`);
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

        return {
          content: [
            {
              type: 'text' as const,
              text: formatAnalyzeDiagramMarkdown(diagram, diagramType, explanation),
            },
          ],
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
  const structuredContent = validateStructuredContent(
    'analyze',
    AnalyzeOutputSchema,
    buildAnalyzeStructuredContent(args, ctx, structured),
  );

  return {
    ...result,
    structuredContent,
  };
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
  );
}

function extractAnalyzeSummary(structured: Record<string, unknown>): string {
  if (typeof structured.analysis === 'string') {
    return structured.analysis;
  }

  if (typeof structured.answer === 'string') {
    return structured.answer;
  }

  return typeof structured.summary === 'string' ? structured.summary : '';
}

function buildAnalyzeStructuredContent(
  args: AnalyzeInput,
  ctx: ServerContext,
  structured: Record<string, unknown>,
): Record<string, unknown> {
  const base = {
    ...buildBaseStructuredOutput(ctx.task?.id),
    ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
    ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
    ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
    ...(structured.usage ? { usage: structured.usage } : {}),
  };

  if (args.outputKind === 'diagram') {
    const diagramType = requireAnalyzeDiagramType(args);

    return {
      ...base,
      kind: 'diagram',
      targetKind: args.targetKind,
      diagramType,
      diagram:
        typeof structured.diagram === 'string' && structured.diagram
          ? structured.diagram
          : extractAnalyzeSummary(structured),
      ...(typeof structured.explanation === 'string' && structured.explanation
        ? { explanation: structured.explanation }
        : {}),
      ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
      ...(args.targetKind === 'file'
        ? { analyzedPaths: [requireAnalyzeFilePath(args)] }
        : args.targetKind === 'multi'
          ? { analyzedPaths: requireAnalyzeFilePaths(args) }
          : {}),
    };
  }

  return {
    ...base,
    kind: 'summary',
    targetKind: args.targetKind,
    summary: extractAnalyzeSummary(structured),
    ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
    ...(args.targetKind === 'multi' ? { analyzedPaths: requireAnalyzeFilePaths(args) } : {}),
  };
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
      annotations: READONLY_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: AnalyzeInput, ctx: ServerContext) => analyzeWork(rootsFetcher, fileWork, args, ctx),
  );
}
