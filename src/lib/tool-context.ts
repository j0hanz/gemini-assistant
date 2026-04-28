import type { ClientCapabilities } from '@modelcontextprotocol/server';

import {
  createSessionAccess,
  createSessionStore,
  type SessionAccess,
  type SessionStore,
} from '../sessions.js';
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

export function toToolSessionAccess(
  sessionAccessOrStore: SessionAccess | SessionStore,
): SessionAccess {
  return 'appendContent' in sessionAccessOrStore
    ? sessionAccessOrStore
    : createSessionAccess(sessionAccessOrStore);
}

export function toToolWorkspaceAccess(
  workspaceOrManager?: WorkspaceAccess | WorkspaceCacheManagerImpl,
): WorkspaceAccess {
  return workspaceOrManager !== undefined && 'allowedRoots' in workspaceOrManager
    ? workspaceOrManager
    : createWorkspaceAccess(workspaceOrManager ?? createWorkspaceCacheManager());
}

export function createDefaultToolServices(): ToolServices {
  return {
    rootsFetcher: () => Promise.resolve([]),
    session: createSessionAccess(createSessionStore()),
    workspace: createWorkspaceAccess(createWorkspaceCacheManager()),
    clientCapabilities: () => undefined,
  };
}

export { isPathWithinRoot };
export { buildContextUsed, buildSessionSummary, emptyContextUsed };
