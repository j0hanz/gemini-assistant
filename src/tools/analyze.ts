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
import { resolveOrchestration, type ToolProfile } from '../lib/orchestration.js';
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
  thinkingBudget?: AnalyzeInput['thinkingBudget'];
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

const UNLABELED_DIAGRAM_FENCED_PATTERN = /```\s*\n([\s\S]*?)```/;

export function buildDiagramFencePattern(diagramType: 'mermaid' | 'plantuml'): RegExp {
  return new RegExp(`\`\`\`${diagramType}\\s*\\n([\\s\\S]*?)\`\`\``);
}

function extractDiagram(
  text: string,
  diagramType: 'mermaid' | 'plantuml',
  ctx: ServerContext,
): { diagram: string; explanation: string } {
  const labeledPattern = buildDiagramFencePattern(diagramType);
  const match = labeledPattern.exec(text);

  if (match?.[1]) {
    const diagram = match[1].trimEnd();
    const explanation = text.replace(labeledPattern, '').trim();
    return { diagram, explanation };
  }

  const unlabeledMatch = UNLABELED_DIAGRAM_FENCED_PATTERN.exec(text);
  if (unlabeledMatch?.[1]) {
    void ctx.mcpReq.log(
      'warning',
      `analyze_diagram: Gemini returned an unlabeled diagram fence; expected ${diagramType}`,
    );
    return {
      diagram: unlabeledMatch[1].trimEnd(),
      explanation: text.replace(UNLABELED_DIAGRAM_FENCED_PATTERN, '').trim(),
    };
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
      thinkingBudget,
      mediaResolution,
      maxOutputTokens,
      safetySettings,
      googleSearch,
      urls,
    }: AnalyzeFileInput & {
      maxOutputTokens?: AnalyzeInput['maxOutputTokens'];
      safetySettings?: AnalyzeInput['safetySettings'];
      googleSearch?: boolean | undefined;
      urls?: readonly string[] | undefined;
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

      const resolved = await resolveOrchestration(
        {
          googleSearch,
          urls,
          includeServerSideToolInvocations: googleSearch === true || (urls?.length ?? 0) > 0,
        },
        ctx,
        'analyze_file',
      );
      if (resolved.error) return resolved.error;
      const { tools, toolConfig, usesUrlContext } = resolved.config;

      return await executor.runStream(
        ctx,
        'analyze_file',
        ANALYZE_FILE_TOOL_LABEL,
        () => {
          const { promptText, systemInstruction } = buildFileAnalysisPrompt({
            goal: question,
            kind: 'single',
          });
          const urlContextPart =
            urls && urls.length > 0 && !usesUrlContext
              ? [{ text: `Context URLs:\n${urls.join('\n')}` }]
              : [];

          return getAI().models.generateContentStream({
            model: MODEL,
            contents: [
              createPartFromUri(uploaded.uri, uploaded.mimeType),
              { text: promptText },
              ...urlContextPart,
            ],
            config: buildGenerateContentConfig(
              {
                systemInstruction,
                thinkingLevel,
                thinkingBudget,
                mediaResolution,
                maxOutputTokens,
                safetySettings,
                tools,
                toolConfig,
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

interface AnalyzeMultiExtra {
  googleSearch?: boolean | undefined;
  maxOutputTokens?: AnalyzeInput['maxOutputTokens'];
  safetySettings?: AnalyzeInput['safetySettings'];
  thinkingBudget?: AnalyzeInput['thinkingBudget'];
  urls?: readonly string[] | undefined;
}

async function analyzeMultiFileWork(
  rootsFetcher: RootsFetcher,
  filePaths: string[],
  goal: string,
  thinkingLevel: AnalyzeInput['thinkingLevel'],
  ctx: ServerContext,
  extra: AnalyzeMultiExtra = {},
): Promise<CallToolResult> {
  const { maxOutputTokens, safetySettings, googleSearch, urls } = extra;
  const { thinkingBudget } = extra;
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

    const resolved = await resolveOrchestration(
      {
        googleSearch,
        urls,
        includeServerSideToolInvocations: googleSearch === true || (urls?.length ?? 0) > 0,
      },
      ctx,
      'analyze',
    );
    if (resolved.error) return resolved.error;
    const { tools, toolConfig, usesUrlContext } = resolved.config;
    if (urls && urls.length > 0 && !usesUrlContext) {
      contents.push({ text: `Context URLs:\n${urls.join('\n')}` });
    }

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
              thinkingBudget,
              maxOutputTokens,
              safetySettings,
              tools,
              toolConfig,
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

function pickDiagramProfile(args: AnalyzeDiagramInput): ToolProfile {
  const isUrl = args.targetKind === 'url';
  const wantsCode = args.validateSyntax === true;
  if (isUrl && wantsCode) return 'url_code';
  if (isUrl) return 'url';
  if (wantsCode) return 'code';
  return 'none';
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

    const diagramProfile = pickDiagramProfile(args);
    const resolved = await resolveOrchestration(
      {
        toolProfile: diagramProfile,
        ...(args.targetKind === 'url' ? { urls: args.urls } : {}),
        includeServerSideToolInvocations: diagramProfile !== 'none',
      },
      ctx,
      'analyze_diagram',
    );
    if (resolved.error) return resolved.error;
    const { tools, toolConfig } = resolved.config;

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
              thinkingBudget: args.thinkingBudget,
              maxOutputTokens: args.maxOutputTokens,
              safetySettings: args.safetySettings,
              tools,
              toolConfig,
            },
            ctx.mcpReq.signal,
          ),
        }),
      (_streamResult, textContent: string) => {
        const { diagram, explanation } = extractDiagram(textContent, args.diagramType, ctx);
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
        thinkingBudget: args.thinkingBudget,
        mediaResolution: args.mediaResolution,
        maxOutputTokens: args.maxOutputTokens,
        safetySettings: args.safetySettings,
        googleSearch: args.googleSearch,
        urls: args.urls,
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
        thinkingBudget: args.thinkingBudget,
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
    {
      maxOutputTokens: args.maxOutputTokens,
      thinkingBudget: args.thinkingBudget,
      safetySettings: args.safetySettings,
      googleSearch: args.googleSearch,
      urls: args.urls,
    },
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
    safetyRatings: structured.safetyRatings,
    finishMessage: structured.finishMessage,
    citationMetadata: structured.citationMetadata,
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
