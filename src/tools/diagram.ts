import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import type { Part } from '@google/genai';

import { cleanupErrorLogger, handleToolError, sendProgress } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { buildOrchestrationConfig } from '../lib/orchestration.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import { type GenerateDiagramInput, GenerateDiagramInputSchema } from '../schemas/inputs.js';
import { GenerateDiagramOutputSchema } from '../schemas/outputs.js';
import { withCurrentWorkspaceRoot } from '../schemas/shared.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Generate Diagram';

const DIAGRAM_FENCED_PATTERN = /```(?:mermaid|plantuml)?\s*\n([\s\S]*?)```/;

function buildSystemInstruction(diagramType: string, validateSyntax?: boolean): string {
  return (
    `Generate a ${diagramType} diagram from the description and files.\n\n` +
    'Rules:\n' +
    `1. Return exactly one fenced \`\`\`${diagramType} block.\n` +
    '2. Keep it readable.\n' +
    '3. Use clear node and edge labels.\n' +
    '4. If source code is provided, derive the diagram from it.' +
    (validateSyntax
      ? '\n5. If syntax validation is requested, use code execution for a best-effort check and state uncertainty.'
      : '')
  );
}

function extractDiagram(text: string): { diagram: string; explanation: string } {
  const match = DIAGRAM_FENCED_PATTERN.exec(text);

  if (match?.[1]) {
    const diagram = match[1].trimEnd();
    const explanation = text.replace(DIAGRAM_FENCED_PATTERN, '').trim();
    return { diagram, explanation };
  }

  return { diagram: text, explanation: '' };
}

function collectDiagramSourceFiles(
  sourceFilePath: string | undefined,
  sourceFilePaths: string[] | undefined,
): string[] {
  return [...(sourceFilePath ? [sourceFilePath] : []), ...(sourceFilePaths ?? [])];
}

async function uploadDiagramSourceFiles(
  filesToUpload: string[],
  ctx: ServerContext,
  rootsFetcher: RootsFetcher,
  uploadedNames: string[],
): Promise<Part[]> {
  const contentParts: Part[] = [];
  const totalSteps = filesToUpload.length + 1;

  for (let i = 0; i < filesToUpload.length; i++) {
    if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const filePath = filesToUpload[i];
    if (!filePath) continue;

    await sendProgress(
      ctx,
      i,
      totalSteps,
      `${TOOL_LABEL}: Uploading ${filePath.split(/[\\/]/).pop() ?? filePath} (${String(i + 1)}/${String(filesToUpload.length)})`,
    );
    const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
    uploadedNames.push(uploaded.name);
    contentParts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
    contentParts.push({ text: `Source file: ${uploaded.displayPath}` });
  }

  return contentParts;
}

function buildDiagramPrompt(
  contentParts: Part[],
  diagramType: string,
  description: string,
  systemInstruction: string,
  cacheName?: string,
): {
  effectiveSystemInstruction: string | undefined;
  prompt: Part[];
} {
  const prompt = [
    ...contentParts,
    {
      text: `Task: ${description}`,
    },
  ];

  if (cacheName) {
    prompt.unshift({ text: systemInstruction });
  }

  return {
    effectiveSystemInstruction: cacheName ? undefined : systemInstruction,
    prompt,
  };
}

function createDiagramWork(rootsFetcher: RootsFetcher) {
  return async function diagramWork(
    args: GenerateDiagramInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
    const { description, diagramType, thinkingLevel, googleSearch, cacheName, validateSyntax } =
      args;
    const sourceFilePath = 'sourceFilePath' in args ? args.sourceFilePath : undefined;
    const sourceFilePaths = 'sourceFilePaths' in args ? args.sourceFilePaths : undefined;
    const uploadedNames: string[] = [];

    try {
      const filesToUpload = collectDiagramSourceFiles(sourceFilePath, sourceFilePaths);
      const contentParts =
        filesToUpload.length > 0
          ? await uploadDiagramSourceFiles(filesToUpload, ctx, rootsFetcher, uploadedNames)
          : [];

      const hasFiles = filesToUpload.length > 0;
      await sendProgress(
        ctx,
        hasFiles ? filesToUpload.length : 0,
        hasFiles ? filesToUpload.length + 1 : undefined,
        `${TOOL_LABEL}: Generating ${diagramType} diagram`,
      );
      await ctx.mcpReq.log('info', `Generating ${diagramType} diagram`);

      const systemInstruction = buildSystemInstruction(diagramType, validateSyntax);
      const { effectiveSystemInstruction, prompt } = buildDiagramPrompt(
        contentParts,
        diagramType,
        description,
        systemInstruction,
        cacheName,
      );

      return await handleToolExecution(
        ctx,
        'generate_diagram',
        TOOL_LABEL,
        () =>
          getAI().models.generateContentStream({
            model: MODEL,
            contents: prompt,
            config: buildGenerateContentConfig(
              {
                systemInstruction: effectiveSystemInstruction,
                thinkingLevel: thinkingLevel ?? 'LOW',
                cacheName,
                ...buildOrchestrationConfig({
                  toolProfile:
                    googleSearch && validateSyntax
                      ? 'search_code'
                      : googleSearch
                        ? 'search'
                        : validateSyntax
                          ? 'code'
                          : 'none',
                }),
              },
              ctx.mcpReq.signal,
            ),
          }),
        (_streamResult, textContent) => {
          const { diagram, explanation } = extractDiagram(textContent);

          return {
            structuredContent: {
              diagram,
              diagramType,
              ...(explanation ? { explanation } : {}),
            },
          };
        },
      );
    } catch (err) {
      return await handleToolError(ctx, 'generate_diagram', TOOL_LABEL, err);
    } finally {
      await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx));
    }
  };
}

export function registerGenerateDiagramTool(server: McpServer): void {
  registerTaskTool(
    server,
    'generate_diagram',
    {
      title: TOOL_LABEL,
      description: withCurrentWorkspaceRoot(
        'Generate a Mermaid or PlantUML diagram from a text description or source files. ' +
          'Supports single or multiple source files for architecture diagrams. ' +
          'Optionally validates syntax via code execution and uses Google Search for patterns.',
      ),
      inputSchema: GenerateDiagramInputSchema,
      outputSchema: GenerateDiagramOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    createDiagramWork(buildServerRootsFetcher(server)),
  );
}
