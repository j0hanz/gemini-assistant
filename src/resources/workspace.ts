import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';

import type { WorkspaceAccess } from '../lib/workspace-context.js';

import { buildResourceMeta, normalizeWorkspacePath, validateScanPath } from './metadata.js';
import {
  decodeTemplateParam,
  FILE_RESOURCE_TEMPLATE,
  WORKSPACE_CACHE_CONTENTS_URI,
  WORKSPACE_CACHE_URI,
} from './uris.js';

/**
 * Parse a URI and extract template parameters.
 * Returns an object with the extracted parameters.
 */
function parseWorkspaceUri(
  uri: string,
): { type: 'cache' } | { type: 'cache_contents' } | { type: 'file'; path: string } {
  // Handle workspace cache
  if (uri === WORKSPACE_CACHE_URI) {
    return { type: 'cache' };
  }

  // Handle workspace cache contents
  if (uri === WORKSPACE_CACHE_CONTENTS_URI) {
    return { type: 'cache_contents' };
  }

  // Handle workspace files - parse gemini://workspace/files/{path}
  const fileMatch = /^gemini:\/\/workspace\/files\/(.+)$/.exec(uri);
  if (fileMatch?.[1]) {
    return { type: 'file', path: fileMatch[1] };
  }

  throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
}

class WorkspaceResourceHandler {
  constructor(private workspace: WorkspaceAccess) {}

  async readResource(uri: string): Promise<string> {
    const parsed = parseWorkspaceUri(uri);

    switch (parsed.type) {
      case 'cache':
        return this.readCacheMetadata(uri);

      case 'cache_contents':
        return this.readCacheContents(uri);

      case 'file':
        return await this.readFile(uri, parsed.path);
    }
  }

  private readCacheMetadata(uri: string): string {
    const status = this.workspace.getCacheStatus();

    const meta = buildResourceMeta({
      cached: true,
      ttlMs: 120_000, // 2 minutes
      size: JSON.stringify(status).length,
      selfUri: uri,
    });

    return `${JSON.stringify(status, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
  }

  private readCacheContents(uri: string): string {
    const status = this.workspace.getCacheStatus();
    const files = status.sources.map((path) => ({ path }));

    const content = {
      metadata: status,
      files,
    };

    const meta = buildResourceMeta({
      cached: true,
      ttlMs: 120_000, // 2 minutes
      size: JSON.stringify(content).length,
      selfUri: uri,
    });

    return `${JSON.stringify(content, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
  }

  private async readFile(uri: string, encodedPath: string): Promise<string> {
    // Decode the path from URI encoding
    const decodedPath = decodeTemplateParam(encodedPath);
    if (!decodedPath) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'File path required');
    }

    // Validate path for security (prevents directory traversal)
    validateScanPath(decodedPath);

    // Normalize the path
    const normalizedPath = normalizeWorkspacePath(decodedPath);

    // Read the file
    let content: string;
    try {
      content = await readFile(normalizedPath, 'utf-8');
    } catch (err) {
      throw new ProtocolError(
        ProtocolErrorCode.ResourceNotFound,
        `Failed to read file: ${String(err)}`,
      );
    }

    const meta = buildResourceMeta({
      cached: false,
      ttlMs: 60_000, // 1 minute
      size: content.length,
      selfUri: uri,
    });

    return `${content}\n\n_meta: ${JSON.stringify(meta)}`;
  }
}

/**
 * Register workspace resources with the MCP server.
 * Registers 3 gemini:// resources:
 *   - gemini://workspace/cache (cache metadata)
 *   - gemini://workspace/cache/contents (cache contents)
 *   - gemini://workspace/files/{path} (file content with security validation)
 */
export function registerWorkspaceResources(
  server: McpServer,
  services: { workspace: WorkspaceAccess },
): void {
  const handler = new WorkspaceResourceHandler(services.workspace);

  // Register resource: gemini://workspace/cache
  server.registerResource(
    'workspace-cache-gemini',
    WORKSPACE_CACHE_URI,
    {
      description: 'Workspace cache metadata',
      mimeType: 'application/json',
    },
    async (): Promise<ReadResourceResult> => {
      const content = await handler.readResource(WORKSPACE_CACHE_URI);
      return {
        contents: [
          {
            uri: WORKSPACE_CACHE_URI,
            mimeType: 'application/json',
            text: content,
          },
        ],
      };
    },
  );

  // Register resource: gemini://workspace/cache/contents
  server.registerResource(
    'workspace-cache-contents-gemini',
    WORKSPACE_CACHE_CONTENTS_URI,
    {
      description: 'Workspace cache full contents',
      mimeType: 'application/json',
    },
    async (): Promise<ReadResourceResult> => {
      const content = await handler.readResource(WORKSPACE_CACHE_CONTENTS_URI);
      return {
        contents: [
          {
            uri: WORKSPACE_CACHE_CONTENTS_URI,
            mimeType: 'application/json',
            text: content,
          },
        ],
      };
    },
  );

  // Register resource template: gemini://workspace/files/{path}
  server.registerResource(
    'workspace-files-gemini',
    FILE_RESOURCE_TEMPLATE,
    {
      description: 'Workspace file contents',
      mimeType: 'text/plain',
    },
    async (uri): Promise<ReadResourceResult> => {
      const uriStr = typeof uri === 'string' ? uri : uri.href;
      const content = await handler.readResource(uriStr);
      return {
        contents: [
          {
            uri: uriStr,
            mimeType: 'application/json',
            text: content,
          },
        ],
      };
    },
  );
}
