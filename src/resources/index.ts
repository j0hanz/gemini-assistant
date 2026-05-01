import type { McpServer } from '@modelcontextprotocol/server';

import type { StoreRegistry } from '../lib/store-registry.js';
import type { ToolServices } from '../lib/tool-context.js';
import type { RootsFetcher } from '../lib/validation.js';

import type { SessionStore } from '../sessions.js';
import { registerDiscoverResources } from './discover.js';
import { registerSessionResources } from './sessions.js';
import { registerStoreResources } from './stores.js';
import { registerWorkspaceResources } from './workspace.js';

/**
 * Services required for resource registration.
 * Combines session store access with tool services.
 */
interface ResourceServices {
  sessionStore: SessionStore;
  toolServices: ToolServices;
  rootsFetcher: RootsFetcher;
  storeRegistry?: StoreRegistry;
}

/**
 * Register all resource modules with the MCP server.
 * Discovers, sessions/turns, workspace, and store resources.
 *
 * @param server The MCP server instance to register resources with
 * @param services Combined services containing sessionStore, toolServices, rootsFetcher, and optional storeRegistry
 */
export function registerAllResources(server: McpServer, services: ResourceServices): void {
  registerDiscoverResources(server);
  registerSessionResources(server, services);
  registerWorkspaceResources(server, services.toolServices);
  if (services.storeRegistry) {
    registerStoreResources(server, services.storeRegistry);
  }
}

export * from './links.js';
export * from './memo.js';
export * from './notifier.js';
