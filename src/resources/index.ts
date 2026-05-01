import type { McpServer } from '@modelcontextprotocol/server';

import type { ToolServices } from '../lib/tool-context.js';
import type { RootsFetcher } from '../lib/validation.js';

import type { SessionStore } from '../sessions.js';
import { registerDiscoverResources } from './discover.js';
import { registerSessionResources } from './sessions.js';
import { registerWorkspaceResources } from './workspace.js';

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
 * Register all resource modules with the MCP server.
 * Discovers, sessions/turns, and workspace resources.
 *
 * @param server The MCP server instance to register resources with
 * @param services Combined services containing sessionStore, toolServices, and rootsFetcher
 */
export function registerAllResources(server: McpServer, services: ResourceServices): void {
  registerDiscoverResources(server);
  registerSessionResources(server, services);
  registerWorkspaceResources(server, services.toolServices);
}

export * from './links.js';
export * from './memo.js';
export * from './notifier.js';
