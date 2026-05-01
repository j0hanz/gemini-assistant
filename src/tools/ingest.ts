import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { readFileSync } from 'node:fs';

import { logger } from '../lib/logger.js';
import { MUTABLE_ANNOTATIONS, registerWorkTool } from '../lib/tasks.js';
import type { ToolServices } from '../lib/tool-context.js';
import { createToolContext } from '../lib/tool-executor.js';
import type { IngestInput } from '../schemas/ingest-input.js';
import { IngestInputSchema } from '../schemas/ingest-input.js';
import { type IngestOutput, IngestOutputSchema } from '../schemas/ingest-output.js';

import { getAI } from '../client.js';
import { appendResourceLinks } from '../resources/index.js';
import { validateScanPath } from '../resources/metadata.js';

const log = logger.child('ingest');

/**
 * Validate file path security
 */
function validateUploadPath(filePath: string): void {
  try {
    validateScanPath(filePath);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid file path', { cause: error });
  }
}

/**
 * Handle create-store operation
 */
async function handleCreateStore(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  const displayName = input.displayName ?? input.storeName;
  const created = await ai.fileSearchStores.create({
    config: { displayName },
  });
  const resourceName = created.name ?? `fileSearchStores/${input.storeName}`;

  return {
    operation: 'create-store',
    storeName: resourceName,
    message: `Store '${resourceName}' created successfully.`,
  };
}

/**
 * Handle upload operation
 */
async function handleUpload(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  // Schema's superRefine guarantees filePath is present for upload.
  const filePath = input.filePath;
  if (filePath === undefined) {
    throw new Error("filePath is required when operation = 'upload'");
  }

  // Validate file path
  validateUploadPath(filePath);

  // Verify file is readable before sending to SDK
  try {
    readFileSync(filePath);
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Failed to read file: ${error.message}` : 'Failed to read file',
      { cause: error },
    );
  }

  const fileSearchStoreName = input.storeName.startsWith('fileSearchStores/')
    ? input.storeName
    : `fileSearchStores/${input.storeName}`;

  const operation = await ai.fileSearchStores.uploadToFileSearchStore({
    fileSearchStoreName,
    file: filePath,
    config: {
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    },
  });

  const documentName = operation.response?.documentName ?? operation.name ?? fileSearchStoreName;

  return {
    operation: 'upload',
    storeName: fileSearchStoreName,
    documentName,
    message: `Document upload started for store '${fileSearchStoreName}' (operation: ${operation.name ?? 'unknown'}).`,
  };
}

/**
 * Handle delete-store operation
 */
async function handleDeleteStore(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  const name = input.storeName.startsWith('fileSearchStores/')
    ? input.storeName
    : `fileSearchStores/${input.storeName}`;

  await ai.fileSearchStores.delete({ name, config: { force: true } });

  return {
    operation: 'delete-store',
    storeName: name,
    message: `Store '${name}' deleted successfully.`,
  };
}

/**
 * Handle delete-document operation
 */
async function handleDeleteDocument(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  // Schema's superRefine guarantees documentName is present for delete-document.
  const documentName = input.documentName;
  if (documentName === undefined) {
    throw new Error("documentName is required when operation = 'delete-document'");
  }

  const storeName = input.storeName.startsWith('fileSearchStores/')
    ? input.storeName
    : `fileSearchStores/${input.storeName}`;
  const fullDocName = documentName.includes('/documents/')
    ? documentName
    : `${storeName}/documents/${documentName}`;

  await ai.fileSearchStores.documents.delete({ name: fullDocName });

  return {
    operation: 'delete-document',
    storeName,
    documentName: fullDocName,
    message: `Document '${fullDocName}' deleted successfully.`,
  };
}

/**
 * Main ingest tool handler
 */
async function ingestWork(input: IngestInput, ctx: ServerContext): Promise<CallToolResult> {
  const toolContext = createToolContext('ingest', ctx);

  try {
    const ai = getAI();
    let output: IngestOutput;

    // Dispatch to operation handler
    switch (input.operation) {
      case 'create-store': {
        output = await handleCreateStore(input, ai);
        break;
      }

      case 'upload': {
        output = await handleUpload(input, ai);
        break;
      }

      case 'delete-store': {
        output = await handleDeleteStore(input, ai);
        break;
      }

      case 'delete-document': {
        output = await handleDeleteDocument(input, ai);
        break;
      }

      default: {
        const _exhaustive: never = input.operation;
        throw new Error(`Unknown operation: ${String(_exhaustive)}`);
      }
    }

    // Validate and return structured response
    const validated = toolContext.validateOutput(IngestOutputSchema, output, {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(output),
        },
      ],
    });

    const resourceLinks = appendResourceLinks('ingest');
    return {
      ...validated,
      resourceLink: resourceLinks,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

    log.error('ingest tool error', { error: errorMessage });

    return {
      content: [
        {
          type: 'text' as const,
          text: errorMessage,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Register the ingest tool with the MCP server
 */
export function registerIngestTool(server: McpServer, _services?: ToolServices): void {
  registerWorkTool<IngestInput>({
    server,
    tool: {
      name: 'ingest',
      title: 'Ingest',
      description:
        'Manage File Search Stores: create, upload documents, delete stores or documents.',
      inputSchema: IngestInputSchema,
      outputSchema: IngestOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    work: (args, ctx) => ingestWork(args, ctx),
  });
}
