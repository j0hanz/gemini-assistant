import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import type { ResourceLink, ResourceMetadata } from '../schemas/resource-meta.js';

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
