import type { McpServer } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';

import { createPartFromUri } from '@google/genai';

import { geminiErrorResult } from '../lib/errors.js';
import { getMimeType, MAX_FILE_SIZE } from '../lib/file-utils.js';
import { resolveAndValidatePath } from '../lib/path-validation.js';
import { extractTextOrError } from '../lib/response.js';
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
    async ({ filePath, question }) => {
      let uploadedFileName: string | undefined;
      try {
        const validPath = await resolveAndValidatePath(filePath);

        // Validate file exists and check size
        const fileStat = await stat(validPath);
        if (fileStat.size > MAX_FILE_SIZE) {
          return geminiErrorResult(
            'analyze_file',
            new Error(`File exceeds 20MB limit (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`),
          );
        }

        const mimeType = getMimeType(validPath);

        // Upload file to Gemini directly
        const uploadedFile = await ai.files.upload({
          file: validPath,
          config: { mimeType },
        });

        uploadedFileName = uploadedFile.name;

        if (!uploadedFile.uri || !uploadedFile.mimeType) {
          return geminiErrorResult(
            'analyze_file',
            new Error('File upload succeeded but returned no URI'),
          );
        }

        // Generate content with the file
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            { text: question },
          ],
        });

        return extractTextOrError(response, 'analyze_file');
      } catch (err) {
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
