import type { McpServer } from '@modelcontextprotocol/server';

import type { ToolServices } from './lib/tool-context.js';
import type { RootsFetcher } from './lib/validation.js';

import { registerDiscoverResources } from './resources/discover.js';
import { registerSessionResources } from './resources/sessions.js';
import {
  sessionEventsUri as buildSessionEventsUri,
  sessionTranscriptUri as buildSessionTranscriptUri,
  sessionResourceUri,
  SESSIONS_LIST_URI,
  turnGroundingUri,
  turnPartsUri,
} from './resources/uris.js';
import { registerWorkspaceResources } from './resources/workspace.js';
import type { SessionStore } from './sessions.js';

/**
 * Services required for resource registration.
 * Combines session store access with tool services.
 */
interface ResourceServices {
  sessionStore: SessionStore;
  toolServices: ToolServices;
  rootsFetcher: RootsFetcher;
}

/**
 * Structural type for server objects that support resource content handlers.
 * Used by discover and session resource registrars.
 */
interface ServerWithResourceContentHandler {
  setResourceContentsHandler(
    handler: (request: { uri: string }) => Promise<{
      contents: { uri: string; text: string; mimeType?: string }[];
    }>,
  ): void;
}

/**
 * Register all resource modules with the MCP server.
 * Discovers, sessions/turns, and workspace resources.
 *
 * @param server The MCP server instance to register resources with
 * @param services Combined services containing sessionStore, toolServices, and rootsFetcher
 */
export function registerAllResources(server: McpServer, services: ResourceServices): void {
  // Register discover resources (catalogs, workflows, context, profiles, instructions)
  // Cast server to structural type that has setResourceContentsHandler
  const serverForDiscover = server as unknown as ServerWithResourceContentHandler;
  registerDiscoverResources(serverForDiscover);

  // Register session resources (sessions list, transcripts, events, turn parts)
  registerSessionResources(serverForDiscover, services);

  // Register workspace resources (cache metadata, cache contents, file access)
  registerWorkspaceResources(server, services.toolServices);
}

// Re-export URI helpers for backward compatibility with server.ts and tools
export { SESSIONS_LIST_URI };

/**
 * Build a session detail URI for the given session ID.
 * Alias for sessionResourceUri for backward compatibility.
 */
export function sessionDetailUri(sessionId: string): string {
  return sessionResourceUri(sessionId);
}

/**
 * Build a session transcript URI for the given session ID.
 * Alias for sessionTranscriptUri for backward compatibility.
 */
export function sessionTranscriptUri(sessionId: string): string {
  return buildSessionTranscriptUri(sessionId);
}

/**
 * Build a session events URI for the given session ID.
 * Alias for sessionEventsUri from uris for backward compatibility.
 */
export function sessionEventsUri(sessionId: string): string {
  return buildSessionEventsUri(sessionId);
}

/**
 * Build a session turn parts URI for the given session ID and turn index.
 * Alias for turnPartsUri for backward compatibility.
 */
export function sessionTurnPartsUri(sessionId: string, turnIndex: number): string {
  return turnPartsUri(sessionId, turnIndex);
}

// Also provide turn grounding URI builder (currently unused, prefixed for consistency)
export function _sessionTurnGroundingUri(sessionId: string, turnIndex: number): string {
  return turnGroundingUri(sessionId, turnIndex);
}
