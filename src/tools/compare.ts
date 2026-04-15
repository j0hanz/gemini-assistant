import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import type { ToolListUnion } from '@google/genai';

import { cleanupErrorLogger, handleToolError, sendProgress } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import { type CompareFilesInput, CompareFilesInputSchema } from '../schemas/inputs.js';
import { CompareFilesOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Compare Files';

const SYSTEM_INSTRUCTION =
  'You are a code and document comparison expert. ' +
  'Compare the two provided files thoroughly.\n\n' +
  'Structure your response with these markdown sections:\n' +
  '## Summary\nBrief overview of the key differences.\n\n' +
  '## Similarities\nShared patterns, structures, or content.\n\n' +
  '## Differences\nDetailed breakdown of what differs, with specific references.\n\n' +
  '## Impact\nPractical implications of the differences (breaking changes, behavior shifts, etc.).\n\n' +
  'Reference specific line numbers, function names, or sections from each file.';

function createCompareFileWork(rootsFetcher: RootsFetcher) {
  return async function compareFileWork(
    { filePathA, filePathB, question, thinkingLevel, googleSearch, cacheName }: CompareFilesInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const uploadedNames: string[] = [];

    try {
      await sendProgress(ctx, 0, 4, `${TOOL_LABEL}: Uploading file A`);
      const fileA = await uploadFile(filePathA, ctx.mcpReq.signal, rootsFetcher);
      uploadedNames.push(fileA.name);

      await sendProgress(ctx, 1, 4, `${TOOL_LABEL}: Uploading file B`);
      const fileB = await uploadFile(filePathB, ctx.mcpReq.signal, rootsFetcher);
      uploadedNames.push(fileB.name);

      await ctx.mcpReq.log('info', `Comparing: ${filePathA} vs ${filePathB}`);
      await sendProgress(ctx, 2, 4, `${TOOL_LABEL}: Analyzing differences`);

      const prompt = question
        ? `Compare these two files with focus on: ${question}`
        : 'Compare these two files thoroughly.';

      const tools: ToolListUnion = [...(googleSearch ? [{ googleSearch: {} }] : [])];

      const effectiveSystemInstruction = cacheName ? undefined : SYSTEM_INSTRUCTION;
      const effectivePrompt = cacheName ? `${SYSTEM_INSTRUCTION}\n\n${prompt}` : prompt;

      return await handleToolExecution(
        ctx,
        'compare_files',
        TOOL_LABEL,
        () =>
          getAI().models.generateContentStream({
            model: MODEL,
            contents: [
              { text: `File A: ${filePathA}` },
              createPartFromUri(fileA.uri, fileA.mimeType),
              { text: `File B: ${filePathB}` },
              createPartFromUri(fileB.uri, fileB.mimeType),
              { text: effectivePrompt },
            ],
            config: buildGenerateContentConfig(
              {
                systemInstruction: effectiveSystemInstruction,
                thinkingLevel: thinkingLevel ?? 'MEDIUM',
                cacheName,
                ...(tools.length > 0 ? { tools } : {}),
              },
              ctx.mcpReq.signal,
            ),
          }),
        (_streamResult, textContent) => ({
          structuredContent: {
            comparison: textContent || '',
          },
        }),
      );
    } catch (err) {
      return await handleToolError(ctx, 'compare_files', TOOL_LABEL, err);
    } finally {
      await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx));
    }
  };
}

export function registerCompareFilesTool(server: McpServer): void {
  registerTaskTool(
    server,
    'compare_files',
    {
      title: TOOL_LABEL,
      description:
        'Upload two files to Gemini and get a structured comparison analysis. ' +
        'Supports code, documents, configs, and other file types. ' +
        'Optionally uses Google Search for best practices or migration context.',
      inputSchema: CompareFilesInputSchema,
      outputSchema: CompareFilesOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    createCompareFileWork(buildServerRootsFetcher(server)),
  );
}
