import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { extractToolContext } from '../lib/context.js';
import { logAndReturnError } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file-upload.js';
import { withRetry } from '../lib/retry.js';
import { consumeStreamWithProgress, validateStreamResult } from '../lib/streaming.js';
import { AnalyzeFileInputSchema } from '../schemas/inputs.js';

import { ai, MODEL } from '../client.js';

export function registerAnalyzeFileTool(server: McpServer): void {
  server.registerTool(
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
    },
    async ({ filePath, question }, ctx: ServerContext) => {
      const tc = extractToolContext(ctx);
      let uploadedFileName: string | undefined;
      try {
        await tc.reportProgress(0, 3, 'Uploading to Gemini');
        const uploaded = await uploadFile(filePath, tc.signal);
        uploadedFileName = uploaded.name;

        await tc.log('info', `Analyzing ${filePath} (${uploaded.mimeType})`);

        // Generate content with the file
        await tc.reportProgress(1, 3, 'Analyzing content');
        const stream = await withRetry(
          () =>
            ai.models.generateContentStream({
              model: MODEL,
              contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: question }],
              config: {
                thinkingConfig: { includeThoughts: true },
                abortSignal: tc.signal,
              },
            }),
          { signal: tc.signal },
        );

        const streamResult = await consumeStreamWithProgress(stream, tc.reportProgress, tc.signal);
        return validateStreamResult(streamResult, 'analyze_file');
      } catch (err) {
        return await logAndReturnError(tc.log, 'analyze_file', err);
      } finally {
        await deleteUploadedFiles(uploadedFileName ? [uploadedFileName] : []);
      }
    },
  );
}
