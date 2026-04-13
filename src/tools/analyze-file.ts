import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { extractToolContext, reportCompletion, reportFailure } from '../lib/context.js';
import { logAndReturnError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file-upload.js';
import { withRetry } from '../lib/retry.js';
import { consumeStreamWithProgress, validateStreamResult } from '../lib/streaming.js';
import { runToolAsTask, taskTtl } from '../lib/task-utils.js';
import { AnalyzeFileInputSchema } from '../schemas/inputs.js';

import { ai, MODEL } from '../client.js';

const ANALYZE_FILE_SYSTEM_INSTRUCTION =
  'Analyze the uploaded file thoroughly. Structure findings clearly with headings. ' +
  'Reference specific sections, lines, or elements from the file. ' +
  'Base analysis strictly on the file content. Do not introduce external information.';

async function analyzeFileWork(
  { filePath, question }: { filePath: string; question: string },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const tc = extractToolContext(ctx);
  const TOOL_LABEL = 'Analyze File';
  let uploadedFileName: string | undefined;
  try {
    await tc.reportProgress(0, 3, `${TOOL_LABEL}: Uploading to Gemini`);
    const uploaded = await uploadFile(filePath, tc.signal);
    uploadedFileName = uploaded.name;

    await tc.log('info', `Analyzing ${filePath} (${uploaded.mimeType})`);

    // Generate content with the file
    await tc.reportProgress(1, 3, `${TOOL_LABEL}: Analyzing content`);
    const stream = await withRetry(
      () =>
        ai.models.generateContentStream({
          model: MODEL,
          contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: question }],
          config: {
            systemInstruction: ANALYZE_FILE_SYSTEM_INSTRUCTION,
            thinkingConfig: { includeThoughts: true },
            maxOutputTokens: 8192,
            abortSignal: tc.signal,
          },
        }),
      { signal: tc.signal },
    );

    const streamResult = await consumeStreamWithProgress(
      stream,
      tc.reportProgress,
      tc.signal,
      TOOL_LABEL,
    );
    const result = validateStreamResult(streamResult, 'analyze_file');
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    await reportCompletion(tc.reportProgress, TOOL_LABEL, `responded (${text.length} chars)`);
    return result;
  } catch (err) {
    await reportFailure(tc.reportProgress, TOOL_LABEL, err);
    return await logAndReturnError(tc.log, 'analyze_file', err);
  } finally {
    await deleteUploadedFiles(uploadedFileName ? [uploadedFileName] : []);
  }
}

export function registerAnalyzeFileTool(server: McpServer): void {
  server.experimental.tasks.registerToolTask(
    'analyze_file',
    {
      title: 'Analyze File',
      description:
        'Upload a file to Gemini and ask questions about it (PDFs, images, code files, etc.).',
      inputSchema: AnalyzeFileInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: 'optional' },
    },
    {
      createTask: async ({ filePath, question }, ctx) => {
        const task = await ctx.task.store.createTask({ ttl: taskTtl(ctx.task.requestedTtl) });
        runToolAsTask(ctx.task.store, task, analyzeFileWork({ filePath, question }, ctx));
        return { task } as CreateTaskResult;
      },
      getTask: async (_args, ctx) =>
        ({ task: await ctx.task.store.getTask(ctx.task.id) }) as unknown as GetTaskResult,
      getTaskResult: async (_args, ctx) =>
        (await ctx.task.store.getTaskResult(ctx.task.id)) as CallToolResult,
    },
  );
}
