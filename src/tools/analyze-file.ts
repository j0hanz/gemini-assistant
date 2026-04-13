import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { reportCompletion, reportFailure, sendProgress } from '../lib/context.js';
import { logAndReturnError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file-upload.js';
import { extractTextContent } from '../lib/response.js';
import { executeToolStream, extractUsage } from '../lib/streaming.js';
import { createToolTaskHandlers } from '../lib/task-utils.js';
import { AnalyzeFileInputSchema } from '../schemas/inputs.js';
import { AnalyzeFileOutputSchema } from '../schemas/outputs.js';

import { ai, MODEL } from '../client.js';

const ANALYZE_FILE_SYSTEM_INSTRUCTION =
  'Analyze the uploaded file thoroughly. Structure findings clearly with headings. ' +
  'Reference specific sections, lines, or elements from the file. ' +
  'Base analysis strictly on the file content. Do not introduce external information.';

async function analyzeFileWork(
  { filePath, question }: { filePath: string; question: string },
  ctx: ServerContext,
): Promise<CallToolResult> {
  const TOOL_LABEL = 'Analyze File';
  let uploadedFileName: string | undefined;
  try {
    await sendProgress(ctx, 0, 3, `${TOOL_LABEL}: Uploading to Gemini`);
    const uploaded = await uploadFile(filePath, ctx.mcpReq.signal);
    uploadedFileName = uploaded.name;

    await ctx.mcpReq.log('info', `Analyzing ${filePath} (${uploaded.mimeType})`);

    // Generate content with the file
    await sendProgress(ctx, 1, 3, `${TOOL_LABEL}: Analyzing content`);

    const { streamResult, result } = await executeToolStream(ctx, 'analyze_file', TOOL_LABEL, () =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: question }],
        config: {
          systemInstruction: ANALYZE_FILE_SYSTEM_INSTRUCTION,
          thinkingConfig: { includeThoughts: true },
          maxOutputTokens: 8192,
          abortSignal: ctx.mcpReq.signal,
        },
      }),
    );

    const text = extractTextContent(result.content);
    await reportCompletion(ctx, TOOL_LABEL, `responded (${text.length} chars)`);
    const usage = extractUsage(streamResult.usageMetadata);
    return {
      ...result,
      structuredContent: { analysis: text, ...(usage ? { usage } : {}) },
    };
  } catch (err) {
    await reportFailure(ctx, TOOL_LABEL, err);
    return await logAndReturnError(ctx, 'analyze_file', err);
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
      outputSchema: AnalyzeFileOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: 'optional' },
    },
    createToolTaskHandlers(analyzeFileWork),
  );
}
