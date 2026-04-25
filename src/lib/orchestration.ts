import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import type {
  FunctionCallingConfigMode,
  FunctionDeclaration,
  ToolConfig,
  ToolListUnion,
} from '@google/genai';

import { AppError } from './errors.js';
import { logger } from './logger.js';
import { validateUrls } from './validation.js';

export const BUILT_IN_TOOL_NAMES = [
  'googleSearch',
  'urlContext',
  'codeExecution',
  'fileSearch',
] as const;
export type BuiltInToolName = (typeof BUILT_IN_TOOL_NAMES)[number];
export type ActiveCapability = BuiltInToolName | 'functions';

export type BuiltInToolSpec =
  | { kind: 'googleSearch' }
  | { kind: 'urlContext' }
  | { kind: 'codeExecution' }
  | {
      kind: 'fileSearch';
      fileSearchStoreNames: readonly string[];
      metadataFilter?: unknown;
    };

export function selectSearchAndUrlContextTools(
  googleSearch?: boolean,
  urls?: readonly string[],
): BuiltInToolName[] {
  return [
    ...(googleSearch ? (['googleSearch'] as const) : []),
    ...((urls?.length ?? 0) > 0 ? (['urlContext'] as const) : []),
  ];
}

const BUILT_IN_TOOL_FACTORIES: Record<
  BuiltInToolName,
  (spec: BuiltInToolSpec) => ToolListUnion[number]
> = {
  googleSearch: () => ({ googleSearch: {} }),
  urlContext: () => ({ urlContext: {} }),
  codeExecution: () => ({ codeExecution: {} }),
  fileSearch: (spec) => {
    // `spec.kind` is narrowed to 'fileSearch' by the Record key; no runtime guard needed.
    const fileSearchSpec = spec as Extract<BuiltInToolSpec, { kind: 'fileSearch' }>;
    return {
      fileSearch: {
        fileSearchStoreNames: [...fileSearchSpec.fileSearchStoreNames],
        ...(fileSearchSpec.metadataFilter !== undefined
          ? { metadataFilter: fileSearchSpec.metadataFilter }
          : {}),
      },
    } as ToolListUnion[number];
  },
};

function specsFromNames(names: readonly BuiltInToolName[]): BuiltInToolSpec[] {
  return names.map((name) => {
    if (name === 'fileSearch') {
      throw new AppError(
        'orchestration',
        'fileSearch requires builtInToolSpecs with fileSearchStoreNames',
      );
    }
    return { kind: name };
  });
}

function buildBuiltInTools(specs: readonly BuiltInToolSpec[]): ToolListUnion {
  if (specs.length === 0) return [];
  return specs.map((spec) => BUILT_IN_TOOL_FACTORIES[spec.kind](spec));
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

export type ServerSideToolInvocationsPolicy = 'auto' | 'always' | 'never';

export interface OrchestrationRequest {
  builtInToolSpecs?: readonly BuiltInToolSpec[] | undefined;
  builtInToolNames?: readonly BuiltInToolName[] | undefined;
  functionDeclarations?: readonly FunctionDeclaration[] | undefined;
  functionCallingMode?: FunctionCallingConfigMode | undefined;
  serverSideToolInvocations?: ServerSideToolInvocationsPolicy | undefined;
  urls?: readonly string[] | undefined;
}

interface OrchestrationConfig {
  functionCallingMode?: FunctionCallingConfigMode;
  toolConfig?: ToolConfig;
  toolProfile: string;
  tools?: ToolListUnion;
  activeCapabilities: Set<ActiveCapability>;
}

export function resolveServerSideToolInvocations(
  policy: ServerSideToolInvocationsPolicy | undefined,
  activeCapabilities: ReadonlySet<string>,
): boolean | undefined {
  if (policy === 'never') return undefined;
  if (policy === 'always') return true;
  const hasBuiltIn = BUILT_IN_TOOL_NAMES.some((name) => activeCapabilities.has(name));
  const hasFunctions = activeCapabilities.has('functions');
  return hasBuiltIn && hasFunctions ? true : undefined;
}

export function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
  const specs = request.builtInToolSpecs ?? specsFromNames(request.builtInToolNames ?? []);
  const builtInTools = buildBuiltInTools(specs);
  const functionTools: ToolListUnion =
    request.functionDeclarations && request.functionDeclarations.length > 0
      ? [{ functionDeclarations: [...request.functionDeclarations] }]
      : [];
  const tools: ToolListUnion = [...builtInTools, ...functionTools];

  const activeCapabilities = new Set<ActiveCapability>();
  for (const name of BUILT_IN_TOOL_NAMES) {
    if (hasTool(tools, name)) {
      activeCapabilities.add(name);
    }
  }
  if (request.functionDeclarations && request.functionDeclarations.length > 0) {
    activeCapabilities.add('functions');
  }

  const config: OrchestrationConfig = {
    toolProfile: buildToolProfile(tools),
    activeCapabilities,
  };

  const includeServerSideToolInvocations = resolveServerSideToolInvocations(
    request.serverSideToolInvocations,
    activeCapabilities,
  );
  if (includeServerSideToolInvocations === true) {
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
  const serverSideToolInvocations =
    config.toolConfig?.includeServerSideToolInvocations === true ? true : undefined;
  const payload = {
    toolKey,
    toolProfile: config.toolProfile,
    activeCapabilities: [...config.activeCapabilities],
    serverSideToolInvocations,
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

  const fileSearchSpec = (request.builtInToolSpecs ?? []).find(
    (spec) => spec.kind === 'fileSearch',
  );
  if (
    config.activeCapabilities.has('fileSearch') &&
    fileSearchSpec?.kind === 'fileSearch' &&
    fileSearchSpec.fileSearchStoreNames.length === 0
  ) {
    await ctx.mcpReq.log(
      'warning',
      `orchestration: ${toolKey} resolved File Search without fileSearchStoreNames`,
    );
  }

  return { config };
}
