import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { cleanupErrorLogger } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildFileAnalysisPrompt } from '../lib/model-prompts.js';
import { ProgressReporter } from '../lib/progress.js';
import { buildBaseStructuredOutput } from '../lib/response.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { executor } from '../lib/tool-executor.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import {
  type AnalyzeFileInput,
  AnalyzeFileInputSchema,
  type AnalyzeInput,
  AnalyzeInputSchema,
} from '../schemas/inputs.js';
import { AnalyzeFileOutputSchema, AnalyzeOutputSchema } from '../schemas/outputs.js';
import { withCurrentWorkspaceRoot } from '../schemas/shared.js';

import { buildGenerateContentConfig, getAI, MODEL } from '../client.js';
import { analyzeUrlWork } from './research-job.js';

const ANALYZE_FILE_TOOL_LABEL = 'Analyze File';
const ANALYZE_TOOL_LABEL = 'Analyze';

export function createAnalyzeFileWork(rootsFetcher: RootsFetcher) {
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
                thinkingLevel: thinkingLevel ?? 'LOW',
                ...(mediaResolution ? { mediaResolution } : {}),
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
  args: Extract<AnalyzeInput['targets'], { kind: 'multi' }>,
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
        for (const filePath of args.filePaths) {
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
              thinkingLevel: thinkingLevel ?? 'MEDIUM',
            },
            ctx.mcpReq.signal,
          ),
        });
      },
      (_streamResult, textContent: string) => ({
        structuredContent: {
          summary: textContent || '',
          targetKind: 'multi',
          analyzedPaths: args.filePaths,
        },
      }),
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
  const result = await runAnalyzeTarget(rootsFetcher, fileWork, args, ctx);

  if (result.isError) {
    return result;
  }

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;

  return {
    ...result,
    structuredContent: buildAnalyzeStructuredContent(args, ctx, structured),
  };
}

async function runAnalyzeTarget(
  rootsFetcher: RootsFetcher,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  if (args.targets.kind === 'file') {
    return await fileWork(
      {
        filePath: args.targets.filePath,
        question: args.goal,
        thinkingLevel: args.thinkingLevel,
        mediaResolution: args.mediaResolution,
      },
      ctx,
    );
  }

  if (args.targets.kind === 'url') {
    return await analyzeUrlWork(
      {
        urls: args.targets.urls,
        question: args.goal,
        thinkingLevel: args.thinkingLevel,
      },
      ctx,
    );
  }

  return await analyzeMultiFileWork(rootsFetcher, args.targets, args.goal, args.thinkingLevel, ctx);
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
  return {
    ...buildBaseStructuredOutput(ctx.task?.id),
    targetKind: args.targets.kind,
    summary: extractAnalyzeSummary(structured),
    ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
    ...(args.targets.kind === 'multi' ? { analyzedPaths: args.targets.filePaths } : {}),
    ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
    ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
    ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
    ...(structured.usage ? { usage: structured.usage } : {}),
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
      description: 'Analyze one file, one or more public URLs, or a small file set.',
      inputSchema: AnalyzeInputSchema,
      outputSchema: AnalyzeOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    taskMessageQueue,
    (args: AnalyzeInput, ctx: ServerContext) => analyzeWork(rootsFetcher, fileWork, args, ctx),
  );
}

export function registerAnalyzeFileTool(
  server: McpServer,
  taskMessageQueue: TaskMessageQueue,
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
