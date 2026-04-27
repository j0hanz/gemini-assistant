import type { ServerContext } from '@modelcontextprotocol/server';

import {
  createSessionAccess,
  createSessionStore,
  type SessionAccess,
  type SessionStore,
} from '../sessions.js';
import { AppError } from './errors.js';
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

const TOOL_SERVICES_KEY = Symbol('gemini-assistant.tool-services');

export interface ToolServices {
  rootsFetcher: RootsFetcher;
  session: SessionAccess;
  workspace: WorkspaceAccess;
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

type BoundToolContext = ServerContext & {
  [TOOL_SERVICES_KEY]?: ToolServices;
};

export function bindToolServices(ctx: ServerContext, services: ToolServices): ServerContext {
  (ctx as BoundToolContext)[TOOL_SERVICES_KEY] = services;
  return ctx;
}

export function getToolServices(ctx: ServerContext): ToolServices {
  const services = findToolServices(ctx);
  if (!services) {
    throw new AppError('server', 'Tool services are unavailable on the current server context.');
  }
  return services;
}

export function findToolServices(ctx: ServerContext): ToolServices | undefined {
  return (ctx as BoundToolContext)[TOOL_SERVICES_KEY];
}

export function createDefaultToolServices(): ToolServices {
  return {
    rootsFetcher: () => Promise.resolve([]),
    session: createSessionAccess(createSessionStore()),
    workspace: createWorkspaceAccess(createWorkspaceCacheManager()),
  };
}

export { isPathWithinRoot };
export { buildContextUsed, buildSessionSummary, emptyContextUsed };
