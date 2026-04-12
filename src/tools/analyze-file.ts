import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { createPartFromUri } from '@google/genai';
import { ai, MODEL } from '../client.js';
import { AnalyzeFileInputSchema } from '../schemas/inputs.js';
import { errorResult } from '../lib/errors.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.rb': 'text/plain',
  '.sh': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

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
