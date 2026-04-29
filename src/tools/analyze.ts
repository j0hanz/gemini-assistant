import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';

import type { Part } from '@google/genai';
import type { z } from 'zod/v4';

import { withUploadsAndPipeline } from '../lib/file.js';
import { mcpLog } from '../lib/logger.js';
import { buildDiagramGenerationPrompt, buildFileAnalysisPrompt } from '../lib/model-prompts.js';
import {
  type BuiltInToolSpec,
  resolveOrchestration,
  type ToolsSpecInput,
} from '../lib/orchestration.js';
import {
  buildSuccessfulStructuredContent,
  deriveDiagramSyntaxValidation,
  pickDefined,
} from '../lib/response.js';
import {
  getTaskEmitter,
  getWorkSignal,
  READONLY_NON_IDEMPOTENT_ANNOTATIONS,
  registerWorkTool,
} from '../lib/tasks.js';
import {
  createDefaultToolServices,
  type ToolRootsFetcher,
  type ToolServices,
} from '../lib/tool-context.js';
import { createToolContext, executor } from '../lib/tool-executor.js';
import { type AnalyzeInput, AnalyzeInputSchema } from '../schemas/inputs.js';
import { AnalyzeOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig, getAI } from '../client.js';
import { getGeminiModel } from '../config.js';
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
  tools?: AnalyzeInput['tools'];
}

type AnalyzeFileInput = Extract<AnalyzeInput, { targetKind: 'file' }>;

const UNLABELED_DIAGRAM_FENCED_PATTERN = /```\s*\n([\s\S]*?)```/;

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function buildDiagramFencePattern(diagramType: 'mermaid' | 'plantuml'): RegExp {
  return new RegExp(`\`\`\`${diagramType}\\s*\\n([\\s\\S]*?)\`\`\``);
}

function extractDiagram(
  text: string,
  diagramType: 'mermaid' | 'plantuml',
  ctx: ServerContext,
): { diagram: string; explanation: string; syntaxErrors?: string[]; syntaxValid?: boolean } {
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
      syntaxErrors: [`Gemini returned an unlabeled fenced block; expected \`\`\`${diagramType}`],
      syntaxValid: false,
    };
  }

  return {
    diagram: text,
    explanation: '',
    syntaxErrors: [`Gemini did not return a labeled \`\`\`${diagramType} fence`],
    syntaxValid: false,
  };
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

function createAnalyzeFileWork(rootsFetcher: ToolRootsFetcher, services?: ToolServices) {
  return async function analyzeFileWork(
    {
      filePath,
      goal,
      thinkingLevel,
      thinkingBudget,
      mediaResolution,
      maxOutputTokens,
      safetySettings,
    }: AnalyzeFileInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const { progress } = createToolContext('analyzeFile', ctx);

    return await withUploadsAndPipeline(
      ctx,
      rootsFetcher,
      [filePath],
      progress,
      (fp) => `Uploading ${basename(fp)}`,
      async (contents) => {
        await mcpLog(ctx, 'info', `Analyzing file content`);
        await progress.step(1, 2, 'Analyzing content');

        return await executor.executeGeminiPipeline(ctx, {
          toolName: 'analyze_file',
          label: TOOL_LABELS.analyzeFile,
          cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,
          commonInputs: {},
          buildContents: () => {
            const { promptText, systemInstruction } = buildFileAnalysisPrompt({
              goal,
              kind: 'single',
            });
            return {
              contents: [...contents, { text: promptText }],
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
      0,
    );
  };
}

interface AnalyzeMultiExtra {
  maxOutputTokens?: AnalyzeInput['maxOutputTokens'];
  safetySettings?: AnalyzeInput['safetySettings'];
  thinkingBudget?: AnalyzeInput['thinkingBudget'];
  tools?: AnalyzeInput['tools'] | undefined;
}

async function analyzeMultiFileWork(
  rootsFetcher: ToolRootsFetcher,
  filePaths: string[],
  goal: string,
  thinkingLevel: AnalyzeInput['thinkingLevel'],
  ctx: ServerContext,
  extra: AnalyzeMultiExtra = {},
): Promise<CallToolResult> {
  const { maxOutputTokens, safetySettings, thinkingBudget, tools: toolsSpec } = extra;
  const tasks = getTaskEmitter(ctx);

  const resolved = await resolveOrchestration(toolsSpec as ToolsSpecInput | undefined, ctx, {
    toolKey: 'analyze',
  });
  if (resolved.error) return resolved.error;

  const { progress } = createToolContext('analyze', ctx);

  await tasks.phase('loading-files');

  for (const filePath of filePaths) {
    try {
      const fileStat = await stat(filePath);
      await tasks.finding({
        kind: 'file-read',
        data: { path: filePath, bytes: fileStat.size },
      });
    } catch {
      await tasks.finding({
        kind: 'file-read',
        data: { path: filePath, bytes: 0 },
      });
    }
  }

  return await withUploadsAndPipeline(
    ctx,
    rootsFetcher,
    filePaths,
    progress,
    (filePath) => `Uploading ${basename(filePath)}`,
    async (contents) => {
      await progress.step(filePaths.length, filePaths.length + 1, 'Analyzing content');

      await tasks.phase('analyzing');

      const prompt = buildFileAnalysisPrompt({
        attachedParts: contents,
        goal,
        kind: 'multi',
      });

      const result = await executor.runStream(
        ctx,
        'analyze',
        TOOL_LABELS.analyze,
        () =>
          getAI().models.generateContentStream({
            model: getGeminiModel(),
            contents: prompt.promptParts,
            config: buildGenerateContentConfig(
              {
                systemInstruction: prompt.systemInstruction,
                costProfile: 'analyze.summary',
                thinkingLevel,
                thinkingBudget,
                maxOutputTokens,
                safetySettings,
                tools: resolved.config.tools,
                toolConfig: resolved.config.toolConfig,
              },
              getWorkSignal(ctx),
            ),
          }),
        (_streamResult, textContent: string) => ({
          structuredContent: {
            summary: textContent || '',
            targetKind: 'multi' as const,
            analyzedPaths: filePaths,
          },
        }),
      );

      await tasks.phase('finalizing');

      return result;
    },
    0,
  );
}

function pickDiagramBuiltInTools(args: AnalyzeDiagramInput): BuiltInToolSpec[] {
  const specs: BuiltInToolSpec[] = [];
  if (args.targetKind === 'url') specs.push({ kind: 'urlContext' });
  if (args.validateSyntax === true) specs.push({ kind: 'codeExecution' });
  return specs;
}

async function analyzeDiagramWork(
  rootsFetcher: ToolRootsFetcher,
  args: AnalyzeDiagramInput,
  ctx: ServerContext,
  services?: ToolServices,
): Promise<CallToolResult> {
  const { progress } = createToolContext('analyzeDiagram', ctx);

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
    (filePath, index, total) => `Uploaded ${basename(filePath)} (${index + 1}/${total})`,
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

      const diagramSpecs = pickDiagramBuiltInTools(args);

      return await executor.executeGeminiPipeline(ctx, {
        toolName: 'analyze_diagram',
        label: TOOL_LABELS.analyzeDiagram,
        cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,
        builtInToolSpecs: diagramSpecs,
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
        responseBuilder: (streamResult, textContent: string) => {
          const extracted = extractDiagram(textContent, args.diagramType, ctx);
          const { diagram, explanation } = extracted;
          const diagramType = args.diagramType;
          const formatted = formatAnalyzeDiagramMarkdown(diagram, diagramType, explanation);
          const toolSyntaxValidation =
            args.validateSyntax === true
              ? deriveDiagramSyntaxValidation(streamResult.toolEvents)
              : {};
          const syntaxErrors = [
            ...(extracted.syntaxErrors ?? []),
            ...(toolSyntaxValidation.syntaxErrors ?? []),
          ];
          const syntaxValidation = {
            ...(extracted.syntaxValid === false
              ? { syntaxValid: false }
              : toolSyntaxValidation.syntaxValid !== undefined
                ? { syntaxValid: toolSyntaxValidation.syntaxValid }
                : extracted.syntaxValid !== undefined
                  ? { syntaxValid: extracted.syntaxValid }
                  : {}),
            ...(syntaxErrors.length > 0 ? { syntaxErrors } : {}),
          };
          const warnings =
            args.validateSyntax === true &&
            !streamResult.toolEvents.some((event) => event.kind === 'code_execution_result')
              ? ['diagram syntax validation requested but Code Execution was not invoked']
              : [];

          return {
            resultMod: () => ({
              content: [{ type: 'text' as const, text: formatted }],
            }),
            structuredContent: {
              diagram,
              diagramType,
              ...(explanation ? { explanation } : {}),
              ...syntaxValidation,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          };
        },
      });
    },
    1,
  );
}

async function analyzeWork(
  rootsFetcher: ToolRootsFetcher,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
  services?: ToolServices,
): Promise<CallToolResult> {
  const result =
    args.outputKind === 'diagram'
      ? await analyzeDiagramWork(rootsFetcher, args as AnalyzeDiagramInput, ctx, services)
      : await runAnalyzeTarget(rootsFetcher, fileWork, args, ctx, services);

  if (result.isError) {
    return result;
  }

  const structured = result.structuredContent ?? {};
  return createToolContext('analyze', ctx).validateOutput(
    AnalyzeOutputSchema,
    buildAnalyzeStructuredContent(args, ctx, structured),
    result,
  );
}

async function runAnalyzeTarget(
  rootsFetcher: ToolRootsFetcher,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
  services?: ToolServices,
): Promise<CallToolResult> {
  if (args.targetKind === 'file') {
    return await fileWork(args, ctx);
  }

  if (args.targetKind === 'url') {
    return await analyzeUrlWork(args, ctx, services);
  }

  return await analyzeMultiFileWork(
    rootsFetcher,
    args.filePaths,
    args.goal,
    args.thinkingLevel,
    ctx,
    {
      maxOutputTokens: args.maxOutputTokens,
      thinkingBudget: args.thinkingBudget,
      safetySettings: args.safetySettings,
      tools: args.tools,
    },
  );
}

function getDiagramString(diagram: unknown): string {
  return typeof diagram === 'string' && diagram ? diagram : '';
}

function getExplanationString(explanation: unknown): string | undefined {
  return typeof explanation === 'string' && explanation ? explanation : undefined;
}

function buildAnalyzeStructuredContent(
  args: AnalyzeInput,
  ctx: ServerContext,
  structured: Record<string, unknown>,
): z.infer<typeof AnalyzeOutputSchema> {
  const warnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
    : undefined;

  if (args.outputKind === 'diagram') {
    const diagramType = args.diagramType ?? 'mermaid';

    return pickDefined({
      ...buildSuccessfulStructuredContent({
        warnings,
        domain: {
          status: 'completed' as const,
          diagramType,
          diagram: getDiagramString(structured.diagram),
          explanation: getExplanationString(structured.explanation),
          syntaxErrors: Array.isArray(structured.syntaxErrors)
            ? structured.syntaxErrors.filter((value): value is string => typeof value === 'string')
            : undefined,
          syntaxValid:
            typeof structured.syntaxValid === 'boolean' ? structured.syntaxValid : undefined,
        },
      }),
    });
  }

  return pickDefined({
    ...buildSuccessfulStructuredContent({
      warnings,
      domain: {
        status: typeof structured.status === 'string' ? structured.status : 'ungrounded',
        summary: typeof structured.summary === 'string' ? structured.summary : '',
      },
    }),
  });
}

export function registerAnalyzeTool(server: McpServer, services?: ToolServices): void {
  const resolvedServices = services ?? createDefaultToolServices();
  const fileWork = createAnalyzeFileWork(resolvedServices.rootsFetcher, resolvedServices);

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
    work: (args, ctx) =>
      analyzeWork(resolvedServices.rootsFetcher, fileWork, args, ctx, resolvedServices),
  });
}
