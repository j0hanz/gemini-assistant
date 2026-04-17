import type {
  CallToolResult,
  McpServer,
  ServerContext,
  TaskMessageQueue,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { cleanupErrorLogger, handleToolError, sendProgress } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildBaseStructuredOutput } from '../lib/response.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
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

const ANALYZE_FILE_SYSTEM_INSTRUCTION =
  'Answer from the file only. Cite relevant sections, lines, or elements.';

const ANALYZE_MULTI_SYSTEM_INSTRUCTION =
  'Analyze only the provided local files. Synthesize across them when needed. ' +
  'Cite filenames, symbols, or short excerpts. Do not invent missing context.';

export function createAnalyzeFileWork(rootsFetcher: RootsFetcher) {
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

async function analyzeMultiFileWork(
  rootsFetcher: RootsFetcher,
  args: Extract<AnalyzeInput['targets'], { kind: 'multi' }>,
  goal: string,
  thinkingLevel: AnalyzeInput['thinkingLevel'],
  ctx: ServerContext,
): Promise<CallToolResult> {
  const uploadedNames: string[] = [];

  try {
    return await handleToolExecution(
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
        contents.push({ text: `Goal: ${goal}` });

        return getAI().models.generateContentStream({
          model: MODEL,
          contents,
          config: buildGenerateContentConfig(
            {
              systemInstruction: ANALYZE_MULTI_SYSTEM_INSTRUCTION,
              thinkingLevel: thinkingLevel ?? 'MEDIUM',
            },
            ctx.mcpReq.signal,
          ),
        });
      },
      (_streamResult, textContent) => ({
        structuredContent: {
          summary: textContent || '',
          targetKind: 'multi',
          analyzedPaths: args.filePaths,
        },
      }),
    );
  } catch (error) {
    return await handleToolError(ctx, 'analyze', ANALYZE_TOOL_LABEL, error);
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
    args.targets.kind === 'file'
      ? await fileWork(
          {
            filePath: args.targets.filePath,
            question: args.goal,
            thinkingLevel: args.thinkingLevel,
            mediaResolution: args.mediaResolution,
          },
          ctx,
        )
      : args.targets.kind === 'url'
        ? await analyzeUrlWork(
            {
              urls: args.targets.urls,
              question: args.goal,
              thinkingLevel: args.thinkingLevel,
            },
            ctx,
          )
        : await analyzeMultiFileWork(
            rootsFetcher,
            args.targets,
            args.goal,
            args.thinkingLevel,
            ctx,
          );

  if (result.isError) {
    return result;
  }

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const summary =
    typeof structured.analysis === 'string'
      ? structured.analysis
      : typeof structured.answer === 'string'
        ? structured.answer
        : typeof structured.summary === 'string'
          ? structured.summary
          : '';

  return {
    ...result,
    structuredContent: {
      ...buildBaseStructuredOutput(ctx.task?.id),
      targetKind: args.targets.kind,
      summary,
      ...(structured.urlMetadata ? { urlMetadata: structured.urlMetadata } : {}),
      ...(args.targets.kind === 'multi' ? { analyzedPaths: args.targets.filePaths } : {}),
      ...(structured.functionCalls ? { functionCalls: structured.functionCalls } : {}),
      ...(structured.thoughts ? { thoughts: structured.thoughts } : {}),
      ...(structured.toolEvents ? { toolEvents: structured.toolEvents } : {}),
      ...(structured.usage ? { usage: structured.usage } : {}),
    },
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
