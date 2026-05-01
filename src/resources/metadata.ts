import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { normalize } from 'node:path';

import type { ResourceLink, ResourceMetadata } from '../schemas/resource-meta.js';

/**
 * Append a _meta block with links to resource content.
 * The _meta block is appended to the content string with a blank line separator.
 *
 * @param content - The resource content (text)
 * @param resourceUri - The URI of this resource (e.g., 'assistant://discover/catalog')
 * @param options - Optional metadata (name, description, mimeType)
 * @returns Content with _meta block appended
 */
export function appendResourceLinks(
  content: string,
  resourceUri: string,
  options?: {
    name?: string;
    description?: string;
    mimeType?: string;
  },
): string {
  const selfLink: ResourceLink = {
    uri: resourceUri,
    ...(options?.name && { name: options.name }),
    ...(options?.description && { description: options.description }),
    ...(options?.mimeType && { mimeType: options.mimeType }),
  };

  const metaBlock = {
    _meta: {
      links: {
        self: selfLink,
      },
    },
  };

  return `${content}\n\n_meta: ${JSON.stringify(metaBlock._meta)}`;
}

/**
 * Build a ResourceMetadata object with all required and optional fields.
 * Auto-sets generatedAt to current ISO timestamp if not provided.
 * Validates source is a known enum value.
 *
 * @param options - Configuration object
 * @returns ResourceMetadata object
 * @throws ProtocolError if source is not a valid enum value
 */
export function buildResourceMeta(options: {
  generatedAt?: string;
  source?: string;
  cached?: boolean;
  ttlMs?: number;
  size?: number;
  selfUri?: string;
  links?: ResourceLink[];
}): ResourceMetadata {
  const now = new Date().toISOString();

  // Validate source is 'gemini-assistant' if provided
  if (options.source && options.source !== 'gemini-assistant') {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid source: ${options.source}. Must be 'gemini-assistant'`,
    );
  }

  const meta: ResourceMetadata = {
    generatedAt: options.generatedAt ?? now,
    source: 'gemini-assistant',
    cached: options.cached ?? false,
    ...(options.ttlMs !== undefined && { ttlMs: options.ttlMs }),
    ...(options.size !== undefined && { size: options.size }),
  };

  // Add links if selfUri is provided
  if (options.selfUri) {
    meta.links = {
      self: {
        uri: options.selfUri,
      },
    };
  } else if (options.links) {
    meta.links = {
      self: options.links[0],
    };
  }

  return meta;
}

/**
 * Validate a file path for security (prevent path traversal attacks).
 * Checks for:
 *  - Directory traversal sequences (e.g., ../)
 *  - Windows drive letter prefixes (e.g., C:\)
 *
 * Workspace-relative paths may include a leading slash.
 * Examples: 'src/foo.ts' → true, '/src/foo.ts' → true, '../etc/passwd' → error
 *
 * @param path - The file path to validate
 * @returns true if path is valid within workspace
 * @throws ProtocolError if path is invalid
 */
export function validateScanPath(path: string): boolean {
  // Reject empty paths
  if (!path || path.length === 0) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Path cannot be empty');
  }

  // Check for Windows drive letter paths (absolute system paths)
  if (/^[A-Za-z]:/.test(path)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Path must be workspace-relative');
  }

  // Normalize the path for consistent checking
  const normalized = normalize(path);

  // Check for directory traversal sequences
  // This catches both ../ and ..\\ patterns
  if (normalized.includes('..') || normalized.startsWith('..')) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Path traversal detected: cannot use .. sequences',
    );
  }

  return true;
}

/**
 * Normalize a file path to canonical form (forward slashes, leading slash).
 * Handles both Windows (C:\...) and Unix paths.
 * Adds leading slash if missing.
 * Converts backslashes to forward slashes.
 *
 * @param path - The file path to normalize
 * @returns Normalized path (e.g., '/src/foo.ts')
 */
export function normalizeWorkspacePath(path: string): string {
  // Remove drive letter prefix if present (Windows)
  let normalized = path.replace(/^[A-Za-z]:/, '');

  // Convert backslashes to forward slashes
  normalized = normalized.replace(/\\/g, '/');

  // Remove trailing slashes unless it's just /
  normalized = normalized.replace(/\/+$/, '');

  // Add leading slash if missing and not empty
  if (normalized.length > 0 && !normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  // Collapse multiple consecutive slashes
  normalized = normalized.replace(/\/+/g, '/');

  // Handle root case
  if (normalized === '') {
    normalized = '/';
  }

  return normalized;
}
