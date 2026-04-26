import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import type { Part } from '@google/genai';
import type { z } from 'zod/v4';

import { withUploadsAndPipeline } from '../lib/file.js';
import { mcpLog } from '../lib/logger.js';
import { buildFileAnalysisPrompt } from '../lib/model-prompts.js';
import { buildDiagramGenerationPrompt } from '../lib/model-prompts.js';
import {
  type BuiltInToolName,
  type ServerSideToolInvocationsPolicy,
} from '../lib/orchestration.js';
import { ProgressReporter } from '../lib/progress.js';
import { pickDefined } from '../lib/response.js';
import {
  buildSuccessfulStructuredContent,
  safeValidateStructuredContent,
} from '../lib/response.js';
import { READONLY_NON_IDEMPOTENT_ANNOTATIONS, registerWorkTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import { type WorkspaceCacheManagerImpl } from '../lib/workspace-context.js';
import { type AnalyzeFileInput, type AnalyzeInput, AnalyzeInputSchema } from '../schemas/inputs.js';
import { AnalyzeOutputSchema } from '../schemas/outputs.js';

import { TOOL_LABELS } from '../public-contract.js';
import { analyzeUrlWork } from './research.js';

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

function createAnalyzeFileWork(
  rootsFetcher: RootsFetcher,
  workspaceCacheManager: WorkspaceCacheManagerImpl,
) {
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
    const progress = new ProgressReporter(ctx, TOOL_LABELS.analyzeFile);

    return await withUploadsAndPipeline(
      ctx,
      rootsFetcher,
      [filePath],
      progress,
      (fp) => `Uploading ${fp.split(/[\\/]/).pop() ?? fp}`,
      async (contents) => {
        await mcpLog(ctx, 'info', `Analyzing file content`);
        await progress.step(1, 2, 'Analyzing content');

        return await executor.executeGeminiPipeline(ctx, {
          toolName: 'analyze_file',
          label: TOOL_LABELS.analyzeFile,
          googleSearch,
          urls,
          workspaceCacheManager,
          buildContents: (activeCaps) => {
            const { promptText, systemInstruction } = buildFileAnalysisPrompt({
              goal: question,
              kind: 'single',
            });
            const urlContextPart =
              urls && urls.length > 0 && !activeCaps.has('urlContext')
                ? [{ text: `Context URLs:\n${urls.join('\n')}` }]
                : [];
            return {
              contents: [...contents, { text: promptText }, ...urlContextPart],
              systemInstruction,
            };
          },
          config: {
            costProfile: 'analyze.summary',
            thinkingLevel,
            thinkingBudget,
            mediaResolution,
            maxOutputTokens,
            safetySettings,
          },
          responseBuilder: (_streamResult, textContent: string) => ({
            structuredContent: {
              summary: textContent || '',
            },
          }),
        });
      },
      0, // indexOffset
    );
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
  workspaceCacheManager: WorkspaceCacheManagerImpl,
  filePaths: string[],
  goal: string,
  thinkingLevel: AnalyzeInput['thinkingLevel'],
  ctx: ServerContext,
  extra: AnalyzeMultiExtra = {},
): Promise<CallToolResult> {
  const { maxOutputTokens, safetySettings, googleSearch, urls, thinkingBudget } = extra;
  const progress = new ProgressReporter(ctx, TOOL_LABELS.analyze);

  return await withUploadsAndPipeline(
    ctx,
    rootsFetcher,
    filePaths,
    progress,
    (filePath) => `Uploading ${filePath.split(/[\\/]/).pop() ?? filePath}`,
    async (contents) => {
      await progress.step(filePaths.length, filePaths.length + 1, 'Analyzing content');

      return await executor.executeGeminiPipeline(ctx, {
        toolName: 'analyze',
        label: TOOL_LABELS.analyze,
        googleSearch,
        urls,
        workspaceCacheManager,
        buildContents: (activeCaps) => {
          const prompt = buildFileAnalysisPrompt({
            attachedParts: contents,
            goal,
            kind: 'multi',
          });
          const finalParts = [...prompt.promptParts];
          if (urls && urls.length > 0 && !activeCaps.has('urlContext')) {
            finalParts.push({ text: `Context URLs:\n${urls.join('\n')}` });
          }
          return { contents: finalParts, systemInstruction: prompt.systemInstruction };
        },
        config: {
          costProfile: 'analyze.summary',
          thinkingLevel,
          thinkingBudget,
          maxOutputTokens,
          safetySettings,
        },
        responseBuilder: (_streamResult, textContent: string) => ({
          structuredContent: {
            summary: textContent || '',
            targetKind: 'multi',
            analyzedPaths: filePaths,
          },
        }),
      });
    },
    0, // indexOffset
  );
}

function pickDiagramBuiltInTools(args: AnalyzeDiagramInput): BuiltInToolName[] {
  const names: BuiltInToolName[] = [];
  if (args.targetKind === 'url') names.push('urlContext');
  if (args.validateSyntax === true) names.push('codeExecution');
  return names;
}

async function analyzeDiagramWork(
  rootsFetcher: RootsFetcher,
  workspaceCacheManager: WorkspaceCacheManagerImpl,
  args: AnalyzeDiagramInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const progress = new ProgressReporter(ctx, TOOL_LABELS.analyzeDiagram);

  const filesToUpload =
    args.targetKind === 'file' || args.targetKind === 'multi'
      ? collectDiagramSourceFiles(
          args.targetKind === 'file' ? args.filePath : undefined,
          args.targetKind === 'multi' ? args.filePaths : undefined,
        )
      : [];

  return await withUploadsAndPipeline(
    ctx,
    rootsFetcher,
    filesToUpload,
    progress,
    (filePath, index, total) =>
      `Uploaded ${filePath.split(/[\\/]/).pop() ?? filePath} (${index + 1}/${total})`,
    async (uploadedParts, uploadedCount) => {
      let attachedParts: Part[] = [];

      if (args.targetKind === 'file' || args.targetKind === 'multi') {
        attachedParts = uploadedParts;
      } else {
        attachedParts = [
          {
            text: `URLs:\n${args.urls?.join('\n') ?? ''}`,
          },
        ];
      }

      const totalSteps = uploadedCount > 0 ? uploadedCount + 1 : 1;
      await progress.step(uploadedCount, totalSteps, `Generating ${args.diagramType} diagram`);
      await mcpLog(ctx, 'info', `Generating ${args.diagramType} diagram`);

      const diagramBuiltInTools = pickDiagramBuiltInTools(args);

      return await executor.executeGeminiPipeline(ctx, {
        toolName: 'analyze_diagram',
        label: TOOL_LABELS.analyzeDiagram,
        urls: args.targetKind === 'url' ? args.urls : undefined,
        serverSideToolInvocations: (diagramBuiltInTools.length > 0
          ? 'auto'
          : 'never') satisfies ServerSideToolInvocationsPolicy,
        workspaceCacheManager,
        buildContents: () => {
          const prompt = buildDiagramGenerationPrompt({
            attachedParts,
            description: args.goal,
            diagramType: args.diagramType,
            validateSyntax: args.validateSyntax,
          });
          return { contents: prompt.promptParts, systemInstruction: prompt.systemInstruction };
        },
        config: {
          costProfile: 'analyze.diagram',
          thinkingLevel: args.thinkingLevel,
          thinkingBudget: args.thinkingBudget,
          maxOutputTokens: args.maxOutputTokens,
          safetySettings: args.safetySettings,
        },
        responseBuilder: (_streamResult, textContent: string) => {
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
      });
    },
    1, // indexOffset
  );
}

async function analyzeWork(
  rootsFetcher: RootsFetcher,
  workspaceCacheManager: WorkspaceCacheManagerImpl,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result =
    args.outputKind === 'diagram'
      ? await analyzeDiagramWork(
          rootsFetcher,
          workspaceCacheManager,
          args as AnalyzeDiagramInput,
          ctx,
        )
      : await runAnalyzeTarget(rootsFetcher, workspaceCacheManager, fileWork, args, ctx);

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
  workspaceCacheManager: WorkspaceCacheManagerImpl,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (args.targetKind === 'file') {
    return await fileWork(
      {
        filePath: args.filePath,
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
        urls: args.urls,
        question: args.goal,
        thinkingLevel: args.thinkingLevel,
        thinkingBudget: args.thinkingBudget,
        maxOutputTokens: args.maxOutputTokens,
        safetySettings: args.safetySettings,
      },
      ctx,
      workspaceCacheManager,
    );
  }

  return await analyzeMultiFileWork(
    rootsFetcher,
    workspaceCacheManager,
    args.filePaths,
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
  if (args.targetKind === 'file') return [args.filePath];
  if (args.targetKind === 'multi') return args.filePaths;
  return undefined;
}

function buildAnalyzeStructuredContent(
  args: AnalyzeInput,
  ctx: ServerContext,
  structured: Record<string, unknown>,
): z.infer<typeof AnalyzeOutputSchema> {
  const base = {
    functionCalls: structured.functionCalls,
    safetyRatings: structured.safetyRatings,
    finishMessage: structured.finishMessage,
    citationMetadata: structured.citationMetadata,
    thoughts: structured.thoughts,
    toolEvents: structured.toolEvents,
    usage: structured.usage,
  };

  if (args.outputKind === 'diagram') {
    const diagramType = args.diagramType ?? 'mermaid';

    return pickDefined({
      ...buildSuccessfulStructuredContent({
        requestId: ctx.task?.id,
        domain: {
          kind: 'diagram' as const,
          targetKind: args.targetKind,
          diagramType,
          diagram: getDiagramString(structured.diagram),
          explanation: getExplanationString(structured.explanation),
          urlMetadata: structured.urlMetadata,
          analyzedPaths: getAnalyzedPaths(args),
        },
        shared: base,
      }),
    }) as unknown as z.infer<typeof AnalyzeOutputSchema>;
  }

  return pickDefined({
    ...buildSuccessfulStructuredContent({
      requestId: ctx.task?.id,
      domain: {
        status: typeof structured.status === 'string' ? structured.status : 'completed',
        kind: 'summary' as const,
        targetKind: args.targetKind,
        summary: typeof structured.summary === 'string' ? structured.summary : '',
        groundingSignals: structured.groundingSignals,
        urlMetadata: structured.urlMetadata,
        analyzedPaths: args.targetKind === 'multi' ? args.filePaths : undefined,
      },
      shared: base,
    }),
  }) as unknown as z.infer<typeof AnalyzeOutputSchema>;
}

export function registerAnalyzeTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
  workspaceCacheManager: WorkspaceCacheManagerImpl,
): void {
  const rootsFetcher = buildServerRootsFetcher(server);
  const fileWork = createAnalyzeFileWork(rootsFetcher, workspaceCacheManager);

  registerWorkTool<AnalyzeInput>({
    server,
    tool: {
      name: 'analyze',
      title: 'Analyze',
      description:
        'Analyze one file, one or more public URLs, a small file set, or generate a diagram.',
      inputSchema: AnalyzeInputSchema,
      outputSchema: AnalyzeOutputSchema,
      annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    },
    queue: taskMessageQueue,
    work: (args, ctx) => analyzeWork(rootsFetcher, workspaceCacheManager, fileWork, args, ctx),
  });
}
