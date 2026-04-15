import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { createPartFromUri } from '@google/genai';
import type { Part, ToolListUnion } from '@google/genai';

import { cleanupErrorLogger, handleToolError, sendProgress } from '../lib/errors.js';
import { deleteUploadedFiles, uploadFile } from '../lib/file.js';
import { handleToolExecution } from '../lib/streaming.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { buildServerRootsFetcher, type RootsFetcher } from '../lib/validation.js';
import { type GenerateDiagramInput, GenerateDiagramInputSchema } from '../schemas/inputs.js';
import { GenerateDiagramOutputSchema } from '../schemas/outputs.js';

import { buildGenerateContentConfig } from '../client.js';
import { getAI, MODEL } from '../client.js';

const TOOL_LABEL = 'Generate Diagram';

const DIAGRAM_FENCED_PATTERN = /```(?:mermaid|plantuml)?\s*\n([\s\S]*?)```/;

function buildSystemInstruction(diagramType: string, validateSyntax?: boolean): string {
  return (
    `You are a diagramming expert. Generate a ${diagramType} diagram based on the user's description.\n\n` +
    'Rules:\n' +
    `1. Output exactly one fenced \`\`\`${diagramType} code block containing valid ${diagramType} syntax.\n` +
    `2. Use \`\`\`${diagramType} to open the code block.\n` +
    '3. After the code block, you may add a brief explanation of the diagram structure.\n' +
    '4. Keep diagrams clean and readable — avoid excessive detail.\n' +
    '5. Use meaningful node/edge labels.\n' +
    '6. If source code is provided, derive the diagram from actual code structure.' +
    (validateSyntax
      ? `\n7. If asked to validate syntax, do a best-effort verification with code execution and mention any uncertainty rather than claiming parser-grade validation.`
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
    contentParts.push({ text: `Source file: ${filePath}` });
  }

  return contentParts;
}

function buildDiagramTools(googleSearch?: boolean, validateSyntax?: boolean): ToolListUnion {
  return [
    ...(googleSearch ? [{ googleSearch: {} }] : []),
    ...(validateSyntax ? [{ codeExecution: {} }] : []),
  ];
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
      text: `Generate a ${diagramType} diagram for: ${description}`,
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
    {
      description,
      diagramType,
      sourceFilePath,
      sourceFilePaths,
      thinkingLevel,
      googleSearch,
      cacheName,
      validateSyntax,
    }: GenerateDiagramInput,
    ctx: ServerContext,
  ): Promise<CallToolResult> {
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

      const tools = buildDiagramTools(googleSearch, validateSyntax);
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
                ...(tools.length > 0 ? { tools } : {}),
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
      description:
        'Generate a Mermaid or PlantUML diagram from a text description or source files. ' +
        'Supports single or multiple source files for architecture diagrams. ' +
        'Optionally validates syntax via code execution and uses Google Search for patterns.',
      inputSchema: GenerateDiagramInputSchema,
      outputSchema: GenerateDiagramOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    createDiagramWork(buildServerRootsFetcher(server)),
  );
}
