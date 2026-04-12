import type { McpServer } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';

import { createPartFromUri } from '@google/genai';

import { errorResult } from '../lib/errors.js';
import { getMimeType, MAX_FILE_SIZE } from '../lib/file-utils.js';
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
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ filePath, question }) => {
      try {
        // Validate file exists and check size
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_FILE_SIZE) {
          return errorResult(
            `File exceeds 20MB limit (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`,
          );
        }

        const mimeType = getMimeType(filePath);

        // Upload file to Gemini directly
        const uploadedFile = await ai.files.upload({
          file: filePath,
          config: { mimeType },
        });

        if (!uploadedFile.uri || !uploadedFile.mimeType) {
          return errorResult('File upload succeeded but returned no URI');
        }

        // Generate content with the file
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            { text: question },
          ],
        });

        return {
          content: [{ type: 'text', text: response.text ?? '' }],
        };
      } catch (err) {
        return errorResult(
          `analyze_file failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
