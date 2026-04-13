import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { AskThinkingLevel, buildGenerateContentConfig } from '../lib/config-utils.js';
import { sendProgress } from '../lib/context.js';
import { handleToolError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file-upload.js';
import type { RootsFetcher } from '../lib/path-validation.js';
import { buildRootsFetcher } from '../lib/path-validation.js';
import { handleToolExecution } from '../lib/streaming.js';
import { createToolTaskHandlers, READONLY_ANNOTATIONS, TASK_EXECUTION } from '../lib/task-utils.js';
import { AnalyzeFileInputSchema } from '../schemas/inputs.js';
import { AnalyzeFileOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const ANALYZE_FILE_SYSTEM_INSTRUCTION =
  'Structure findings with headings. Reference specific sections, lines, or elements. ' +
  'Base analysis strictly on the file content.';

function createAnalyzeFileWork(rootsFetcher: RootsFetcher) {
  return async function analyzeFileWork(
    {
      filePath,
      question,
      thinkingLevel,
    }: { filePath: string; question: string; thinkingLevel?: AskThinkingLevel | undefined },
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const TOOL_LABEL = 'Analyze File';
    let uploadedFileName: string | undefined;
    try {
      await sendProgress(ctx, 0, 3, `${TOOL_LABEL}: Uploading to Gemini`);
      const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
      uploadedFileName = uploaded.name;

      await ctx.mcpReq.log('info', `Analyzing ${filePath} (${uploaded.mimeType})`);

      // Generate content with the file
      await sendProgress(ctx, 1, 3, `${TOOL_LABEL}: Analyzing content`);

      return await handleToolExecution(
        ctx,
        'analyze_file',
        TOOL_LABEL,
        () =>
          ai.models.generateContentStream({
            model: MODEL,
            contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: question }],
            config: buildGenerateContentConfig(
              {
                systemInstruction: ANALYZE_FILE_SYSTEM_INSTRUCTION,
                thinkingLevel: thinkingLevel ?? 'LOW',
              },
              ctx.mcpReq.signal,
            ),
          }),
        (streamResult, textContent) => ({
          structuredContent: {
            analysis: textContent || '',
          },
        }),
      );
    } catch (err) {
      return await handleToolError(ctx, 'analyze_file', TOOL_LABEL, err);
    } finally {
      await deleteUploadedFiles(uploadedFileName ? [uploadedFileName] : []);
    }
  };
}

export function registerAnalyzeFileTool(server: McpServer): void {
  const rootsFetcher = buildRootsFetcher(
    () => server.server.getClientCapabilities(),
    () => server.server.listRoots(),
  );

  server.experimental.tasks.registerToolTask(
    'analyze_file',
    {
      title: 'Analyze File',
      description:
        'Upload a file to Gemini and ask questions about it (PDFs, images, code files, etc.).',
      inputSchema: AnalyzeFileInputSchema,
      outputSchema: AnalyzeFileOutputSchema,
      annotations: READONLY_ANNOTATIONS,
      execution: TASK_EXECUTION,
    },
    createToolTaskHandlers(createAnalyzeFileWork(rootsFetcher)),
  );
}
