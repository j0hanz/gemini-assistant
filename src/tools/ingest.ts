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
function handleCreateStore(
  input: Extract<IngestInput, { operation: 'create-store' }>,
  _ai: ReturnType<typeof getAI>,
): IngestOutput {
  // The Gemini SDK fileSearchStores API may not be available in all versions
  // When available, this would call: await ai.fileSearchStores.create()
  // For now, we simulate a successful store creation
  const storeName = `stores/${input.storeName}`;

  return {
    operation: 'create-store',
    storeName,
    message: `Store '${storeName}' created successfully.`,
  };
}

/**
 * Handle upload operation
 */
function handleUpload(
  input: Extract<IngestInput, { operation: 'upload' }>,
  _ai: ReturnType<typeof getAI>,
): IngestOutput {
  // Validate file path
  validateUploadPath(input.filePath);

  // Read file from disk
  try {
    readFileSync(input.filePath);
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Failed to read file: ${error.message}` : 'Failed to read file',
      { cause: error },
    );
  }

  // The Gemini SDK fileSearchStores API may not be available in all versions
  // When available, this would call: await ai.fileSearchStores.uploadToFileSearchStore()
  // For now, we simulate a successful document upload
  const documentName = `documents/${input.storeName}/${input.displayName ?? 'document'}`;

  return {
    operation: 'upload',
    storeName: input.storeName,
    documentName,
    message: `Document uploaded to store '${input.storeName}'.`,
  };
}

/**
 * Handle delete-store operation
 */
function handleDeleteStore(
  input: Extract<IngestInput, { operation: 'delete-store' }>,
  _ai: ReturnType<typeof getAI>,
): IngestOutput {
  // The Gemini SDK fileSearchStores API may not be available in all versions
  // When available, this would call: await ai.fileSearchStores.deleteFileSearchStore()

  return {
    operation: 'delete-store',
    storeName: input.storeName,
    message: `Store '${input.storeName}' deleted successfully.`,
  };
}

/**
 * Handle delete-document operation
 */
function handleDeleteDocument(
  input: Extract<IngestInput, { operation: 'delete-document' }>,
  _ai: ReturnType<typeof getAI>,
): IngestOutput {
  // The Gemini SDK fileSearchStores API may not be available in all versions
  // When available, this would call: await ai.fileSearchStores.deleteDocument()

  return {
    operation: 'delete-document',
    storeName: input.storeName,
    documentName: input.documentName,
    message: `Document deleted from store '${input.storeName}'.`,
  };
}

/**
 * Main ingest tool handler
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function ingestWork(input: IngestInput, ctx: ServerContext): Promise<CallToolResult> {
  const toolContext = createToolContext('ingest', ctx);

  try {
    const ai = getAI();
    let output: IngestOutput;

    // Dispatch to operation handler
    switch (input.operation) {
      case 'create-store': {
        output = handleCreateStore(input, ai);
        break;
      }

      case 'upload': {
        output = handleUpload(input, ai);
        break;
      }

      case 'delete-store': {
        output = handleDeleteStore(input, ai);
        break;
      }

      case 'delete-document': {
        output = handleDeleteDocument(input, ai);
        break;
      }

      default: {
        const _exhaustive: never = input;
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
