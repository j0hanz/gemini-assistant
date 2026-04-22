import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import type { FunctionCallingConfigMode, ToolConfig, ToolListUnion } from '@google/genai';

import { logger } from './logger.js';
import { validateUrls } from './validation.js';

export const BUILT_IN_TOOL_NAMES = ['googleSearch', 'urlContext', 'codeExecution'] as const;
export type BuiltInToolName = (typeof BUILT_IN_TOOL_NAMES)[number];

const BUILT_IN_TOOL_FACTORIES: Record<BuiltInToolName, () => ToolListUnion[number]> = {
  googleSearch: () => ({ googleSearch: {} }),
  urlContext: () => ({ urlContext: {} }),
  codeExecution: () => ({ codeExecution: {} }),
};

/**
 * @deprecated Preset-profile strings are no longer the orchestration input.
 * Retained as a string alias for one release; derived labels are produced by
 * {@link buildToolProfile}. Prefer `BuiltInToolName[]` for new code.
 */
export type ToolProfile = string;

function buildBuiltInTools(names: readonly BuiltInToolName[] | undefined): ToolListUnion {
  if (!names || names.length === 0) return [];
  return names.map((name) => BUILT_IN_TOOL_FACTORIES[name]());
}

function cloneTools(tools: ToolListUnion | undefined): ToolListUnion {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({ ...tool }));
}

function hasTool(tools: ToolListUnion, key: BuiltInToolName): boolean {
  return tools.some((tool) => Object.prototype.hasOwnProperty.call(tool, key));
}

export function buildToolProfile(tools: ToolListUnion | undefined): string {
  if (!tools || tools.length === 0) return 'none';
  const keys = new Set<string>();
  for (const tool of tools) {
    for (const key of Object.keys(tool)) {
      keys.add(key);
    }
  }
  if (keys.size === 0) return 'none';
  return [...keys].sort().join('+');
}

interface OrchestrationRequest {
  builtInToolNames?: readonly BuiltInToolName[] | undefined;
  additionalTools?: ToolListUnion | undefined;
  functionCallingMode?: FunctionCallingConfigMode | undefined;
  includeServerSideToolInvocations?: boolean | undefined;
  urls?: readonly string[] | undefined;
}

interface OrchestrationConfig {
  functionCallingMode?: FunctionCallingConfigMode;
  toolConfig?: ToolConfig;
  toolProfile: string;
  tools?: ToolListUnion;
  activeCapabilities: Set<BuiltInToolName>;
}

export function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
  const builtInTools = buildBuiltInTools(request.builtInToolNames);
  const extraTools = cloneTools(request.additionalTools);
  const tools: ToolListUnion = [...builtInTools, ...extraTools];

  const activeCapabilities = new Set<BuiltInToolName>();
  for (const name of BUILT_IN_TOOL_NAMES) {
    if (hasTool(tools, name)) {
      activeCapabilities.add(name);
    }
  }

  const config: OrchestrationConfig = {
    toolProfile: buildToolProfile(tools),
    activeCapabilities,
  };

  if (request.includeServerSideToolInvocations === true) {
    config.toolConfig = { includeServerSideToolInvocations: true };
  }

  if (request.functionCallingMode !== undefined) {
    config.functionCallingMode = request.functionCallingMode;
  }

  if (tools.length > 0) {
    config.tools = tools;
  }

  return config;
}

export type ResolveOrchestrationResult =
  | { config: OrchestrationConfig; error?: undefined }
  | { config?: undefined; error: CallToolResult };

/**
 * Unified orchestration entry point for tool handlers: validates URLs,
 * resolves the composed tool list, and emits a single info log describing the
 * resolution. Emits a warning if `urls` were supplied but the resolved
 * configuration has URL Context disabled.
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
    activeCapabilities: [...config.activeCapabilities],
    urlCount,
  };

  await ctx.mcpReq.log('info', `orchestration resolved: ${toolKey} -> ${config.toolProfile}`);
  logger.child(toolKey).info('orchestration resolved', payload);

  if (urlCount > 0 && !config.activeCapabilities.has('urlContext')) {
    await ctx.mcpReq.log(
      'warning',
      `orchestration: ${toolKey} received ${String(urlCount)} URL(s) but resolved profile '${config.toolProfile}' does not expose URL Context`,
    );
  }

  return { config };
}
