import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';

import { extractToolContext } from '../lib/context.js';
import { geminiErrorResult } from '../lib/errors.js';
import { uploadFile } from '../lib/file-upload.js';
import { extractTextOrError } from '../lib/response.js';
import { withRetry } from '../lib/retry.js';
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
        const response = await withRetry(
          () =>
            ai.models.generateContent({
              model: MODEL,
              contents: [createPartFromUri(uploaded.uri, uploaded.mimeType), { text: question }],
              config: { abortSignal: tc.signal },
            }),
          { signal: tc.signal },
        );

        await tc.reportProgress(2, 3, 'Complete');
        return extractTextOrError(response, 'analyze_file');
      } catch (err) {
        await tc.log(
          'error',
          `analyze_file failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return geminiErrorResult('analyze_file', err);
      } finally {
        if (uploadedFileName) {
          try {
            await ai.files.delete({ name: uploadedFileName });
          } catch {
            // Cleanup failure is non-critical
          }
        }
      }
    },
  );
}
