import type { ClientCapabilities } from '@modelcontextprotocol/server';

import { createSessionAccess, createSessionStore, type SessionAccess } from '../sessions.js';
import { isPathWithinRoot, type RootsFetcher } from './validation.js';
import {
  buildContextUsed,
  buildSessionSummary,
  createWorkspaceAccess,
  createWorkspaceCacheManager,
  emptyContextUsed,
  type WorkspaceAccess,
  type WorkspaceCacheManagerImpl,
} from './workspace-context.js';

type ClientCapabilitiesAccessor = () => ClientCapabilities | undefined;

export interface ToolServices {
  rootsFetcher: RootsFetcher;
  session: SessionAccess;
  workspace: WorkspaceAccess;
  clientCapabilities: ClientCapabilitiesAccessor;
}

export type ToolRootsFetcher = ToolServices['rootsFetcher'];
export type ToolWorkspaceAccess = ToolServices['workspace'];
export type ToolWorkspaceCacheManager = WorkspaceCacheManagerImpl;

export function createDefaultToolServices(): ToolServices {
  return {
    rootsFetcher: () => Promise.resolve([]),
    session: createSessionAccess(createSessionStore()),
    workspace: createWorkspaceAccess(createWorkspaceCacheManager()),
    clientCapabilities: () => undefined,
  };
}

export { isPathWithinRoot };
export { buildContextUsed, emptyContextUsed };
