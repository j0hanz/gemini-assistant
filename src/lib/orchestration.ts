import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import type { ToolConfig, ToolListUnion } from '@google/genai';

import { logger } from './logger.js';
import { validateUrls } from './validation.js';

export const TOOL_PROFILES = [
  'none',
  'search',
  'url',
  'search_url',
  'code',
  'search_code',
  'url_code',
] as const;

export type ToolProfile = (typeof TOOL_PROFILES)[number];

interface ToolProfileCapabilities {
  builtInTools: ToolListUnion;
  usesCodeExecution: boolean;
  usesGoogleSearch: boolean;
  usesUrlContext: boolean;
}

const TOOL_PROFILE_CAPABILITIES: Record<ToolProfile, ToolProfileCapabilities> = {
  none: {
    builtInTools: [],
    usesCodeExecution: false,
    usesGoogleSearch: false,
    usesUrlContext: false,
  },
  search: {
    builtInTools: [{ googleSearch: {} }],
    usesCodeExecution: false,
    usesGoogleSearch: true,
    usesUrlContext: false,
  },
  url: {
    builtInTools: [{ urlContext: {} }],
    usesCodeExecution: false,
    usesGoogleSearch: false,
    usesUrlContext: true,
  },
  search_url: {
    builtInTools: [{ googleSearch: {} }, { urlContext: {} }],
    usesCodeExecution: false,
    usesGoogleSearch: true,
    usesUrlContext: true,
  },
  code: {
    builtInTools: [{ codeExecution: {} }],
    usesCodeExecution: true,
    usesGoogleSearch: false,
    usesUrlContext: false,
  },
  search_code: {
    builtInTools: [{ googleSearch: {} }, { codeExecution: {} }],
    usesCodeExecution: true,
    usesGoogleSearch: true,
    usesUrlContext: false,
  },
  url_code: {
    builtInTools: [{ urlContext: {} }, { codeExecution: {} }],
    usesCodeExecution: true,
    usesGoogleSearch: false,
    usesUrlContext: true,
  },
};

interface OrchestrationRequest {
  googleSearch?: boolean | undefined;
  includeServerSideToolInvocations?: boolean | undefined;
  jsonMode?: boolean | undefined;
  toolProfile?: ToolProfile | undefined;
  urls?: readonly string[] | undefined;
}

interface OrchestrationConfig {
  toolConfig?: ToolConfig;
  toolProfile: ToolProfile;
  tools?: ToolListUnion;
  usesCodeExecution: boolean;
  usesGoogleSearch: boolean;
  usesUrlContext: boolean;
}

export function normalizeToolProfile({
  googleSearch,
  toolProfile,
  urls,
}: Pick<OrchestrationRequest, 'googleSearch' | 'toolProfile' | 'urls'>): ToolProfile {
  if (toolProfile) {
    return toolProfile;
  }

  const hasUrls = (urls?.length ?? 0) > 0;

  if (googleSearch) {
    return hasUrls ? 'search_url' : 'search';
  }

  if (hasUrls) {
    return 'url';
  }

  return 'none';
}

export function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
  const toolProfile = normalizeToolProfile(request);
  const capabilities = TOOL_PROFILE_CAPABILITIES[toolProfile];
  const builtInTools = capabilities.builtInTools.map((tool) => ({ ...tool }));
  const hasBuiltIn = builtInTools.length > 0;

  const config: OrchestrationConfig = {
    toolProfile,
    usesCodeExecution: capabilities.usesCodeExecution,
    usesGoogleSearch: capabilities.usesGoogleSearch,
    usesUrlContext: capabilities.usesUrlContext,
  };

  if (request.includeServerSideToolInvocations === true) {
    config.toolConfig = { includeServerSideToolInvocations: true };
  }

  if (hasBuiltIn) {
    config.tools = builtInTools;
  }

  return config;
}

export type ResolveOrchestrationResult =
  | { config: OrchestrationConfig; error?: undefined }
  | { config?: undefined; error: CallToolResult };

/**
 * Unified orchestration entry point for tool handlers: validates URLs,
 * resolves the tool profile, and emits a single info log describing the
 * resolution. Emits a warning if `urls` were supplied but the resolved
 * profile has URL Context disabled.
 */
export async function resolveOrchestration(
  request: OrchestrationRequest & { urls?: readonly string[] | undefined },
  ctx: ServerContext,
  toolKey: string,
): Promise<ResolveOrchestrationResult> {
  const urlError = validateUrls(request.urls);
  if (urlError) {
    return { error: urlError };
  }

  const config = buildOrchestrationConfig(request);
  const urlCount = request.urls?.length ?? 0;
  const payload = {
    toolKey,
    toolProfile: config.toolProfile,
    usesGoogleSearch: config.usesGoogleSearch,
    usesUrlContext: config.usesUrlContext,
    usesCodeExecution: config.usesCodeExecution,
    urlCount,
  };

  await ctx.mcpReq.log('info', `orchestration resolved: ${toolKey} -> ${config.toolProfile}`);
  logger.child(toolKey).info('orchestration resolved', payload);

  if (urlCount > 0 && !config.usesUrlContext) {
    await ctx.mcpReq.log(
      'warning',
      `orchestration: ${toolKey} received ${String(urlCount)} URL(s) but resolved profile '${config.toolProfile}' does not expose URL Context`,
    );
  }

  return { config };
}
