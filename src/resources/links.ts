import type { ResourceLink } from '../schemas/resource-meta.js';

import {
  ASSISTANT_CATALOG_URI,
  ASSISTANT_CONTEXT_URI,
  fileResourceUri,
  sessionResourceUri,
  SESSIONS_LIST_URI,
  sessionTranscriptUri,
  WORKSPACE_CACHE_CONTENTS_URI,
  WORKSPACE_CACHE_URI,
} from './uris.js';

/**
 * Options for appendResourceLinks()
 */
interface ResourceLinkOptions {
  sessionId?: string | undefined;
  context?: string | undefined;
  filePaths?: string[] | undefined;
}

/**
 * Append resource links to tool responses based on tool name and context.
 * Suggests relevant resources that are related to the tool output.
 *
 * @param toolName - The tool that generated the response
 * @param options - Optional context for resource suggestions
 * @returns Array of ResourceLink objects suggesting relevant resources
 */
export function appendResourceLinks(
  toolName: 'chat' | 'research' | 'analyze' | 'review',
  options?: ResourceLinkOptions,
): ResourceLink[] {
  const links: ResourceLink[] = [];

  switch (toolName) {
    case 'chat': {
      // Session-specific links if sessionId provided
      if (options?.sessionId) {
        links.push({
          uri: sessionResourceUri(options.sessionId),
          name: 'Current Session',
          description: 'Current session details and metadata',
          mimeType: 'application/json',
        });

        links.push({
          uri: sessionTranscriptUri(options.sessionId),
          name: 'Session Transcript',
          description: 'Full conversation transcript for this session',
          mimeType: 'text/markdown',
        });
      }

      // Sessions list
      links.push({
        uri: SESSIONS_LIST_URI,
        name: 'Sessions',
        description: 'List of all sessions and their metadata',
        mimeType: 'application/json',
      });

      // Tool catalog
      links.push({
        uri: ASSISTANT_CATALOG_URI,
        name: 'Tool Catalog',
        description: 'Available tools and their capabilities',
        mimeType: 'text/markdown',
      });

      break;
    }

    case 'research': {
      // Workspace cache
      links.push({
        uri: WORKSPACE_CACHE_URI,
        name: 'Workspace Cache',
        description: 'Cached workspace context and file keywords',
        mimeType: 'application/json',
      });

      // System context
      links.push({
        uri: ASSISTANT_CONTEXT_URI,
        name: 'System Context',
        description: 'Server context and system instructions',
        mimeType: 'text/markdown',
      });

      break;
    }

    case 'analyze': {
      // Workspace contents
      links.push({
        uri: WORKSPACE_CACHE_CONTENTS_URI,
        name: 'Workspace Contents',
        description: 'Analyzed workspace files and directory structure',
        mimeType: 'application/json',
      });

      // File-specific links if filePaths provided
      if (options?.filePaths && options.filePaths.length > 0) {
        for (const filePath of options.filePaths) {
          links.push({
            uri: fileResourceUri(filePath),
            name: `File: ${filePath}`,
            description: `Source file: ${filePath}`,
            mimeType: 'text/plain',
          });
        }
      }

      break;
    }

    case 'review': {
      // Session-specific links if sessionId provided
      if (options?.sessionId) {
        links.push({
          uri: sessionResourceUri(options.sessionId),
          name: 'Review Session',
          description: 'Session being reviewed',
          mimeType: 'application/json',
        });

        links.push({
          uri: sessionTranscriptUri(options.sessionId),
          name: 'Session Transcript',
          description: 'Transcript of the session being reviewed',
          mimeType: 'text/markdown',
        });
      }

      // Workspace context
      links.push({
        uri: WORKSPACE_CACHE_CONTENTS_URI,
        name: 'Workspace Contents',
        description: 'Workspace context for the review',
        mimeType: 'application/json',
      });

      break;
    }
  }

  return links;
}
