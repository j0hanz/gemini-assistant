import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { FunctionCallingConfigMode } from '@google/genai';
import type { FunctionDeclaration, ToolConfig, ToolListUnion } from '@google/genai';

import { AppError } from './errors.js';
import { logger, mcpLog } from './logger.js';
import {
  buildProfileToolConfig,
  buildToolsArray,
  ProfileValidationError,
  type ResolvedProfile,
  resolveProfile,
  type ResolveProfileContext,
  resolveProfileFunctionCallingMode,
  type ToolsSpecInput,
  validateProfile,
} from './tool-profiles.js';
import { validateUrls } from './validation.js';

// ── Legacy types (kept for backward compatibility with tool-executor.ts) ──────

const BUILT_IN_TOOL_NAMES = ['googleSearch', 'urlContext', 'codeExecution', 'fileSearch'] as const;
type BuiltInToolName = (typeof BUILT_IN_TOOL_NAMES)[number];
type ActiveCapability = BuiltInToolName | 'functions';

export type BuiltInToolSpec =
  | { kind: 'googleSearch' }
  | { kind: 'urlContext' }
  | { kind: 'codeExecution' }
  | {
      kind: 'fileSearch';
      fileSearchStoreNames: readonly string[];
      metadataFilter?: unknown;
    };

const BUILT_IN_TOOL_FACTORIES: Record<
  BuiltInToolName,
  (spec: BuiltInToolSpec) => ToolListUnion[number]
> = {
  googleSearch: () => ({ googleSearch: {} }),
  urlContext: () => ({ urlContext: {} }),
  codeExecution: () => ({ codeExecution: {} }),
  fileSearch: (spec) => {
    if (spec.kind !== 'fileSearch') {
      throw new AppError('orchestration', 'fileSearch tool factory received invalid spec');
    }
    return {
      fileSearch: {
        fileSearchStoreNames: [...spec.fileSearchStoreNames],
        ...(spec.metadataFilter !== undefined ? { metadataFilter: spec.metadataFilter } : {}),
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
  return tools.some((tool) => Object.hasOwn(tool, key));
}

function buildToolProfile(tools: ToolListUnion | undefined): string {
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

type ServerSideToolInvocationsPolicy = 'auto' | 'always' | 'never';

export interface OrchestrationRequest {
  builtInToolSpecs?: readonly BuiltInToolSpec[] | undefined;
  builtInToolNames?: readonly BuiltInToolName[] | undefined;
  functionDeclarations?: readonly FunctionDeclaration[] | undefined;
  functionCallingMode?: FunctionCallingConfigMode | undefined;
  responseSchemaRequested?: boolean | undefined;
  serverSideToolInvocations?: ServerSideToolInvocationsPolicy | undefined;
  urls?: readonly string[] | undefined;
}

export interface CommonToolInputs {
  googleSearch?: boolean | undefined;
  urls?: readonly string[] | undefined;
  codeExecution?: boolean | undefined;
  fileSearch?: { fileSearchStoreNames: readonly string[]; metadataFilter?: unknown } | undefined;
  functionDeclarations?: readonly FunctionDeclaration[] | undefined;
  functionCallingMode?: FunctionCallingConfigMode | undefined;
  responseSchemaRequested?: boolean | undefined;
  serverSideToolInvocations?: ServerSideToolInvocationsPolicy | undefined;
  extraBuiltInToolSpecs?: readonly BuiltInToolSpec[] | undefined;
}

export function buildOrchestrationRequestFromInputs(input: CommonToolInputs): OrchestrationRequest {
  const builtInToolSpecs: BuiltInToolSpec[] = [];
  if (input.googleSearch) builtInToolSpecs.push({ kind: 'googleSearch' });
  if ((input.urls?.length ?? 0) > 0) builtInToolSpecs.push({ kind: 'urlContext' });
  if (input.codeExecution) builtInToolSpecs.push({ kind: 'codeExecution' });
  if (input.fileSearch) {
    builtInToolSpecs.push({
      kind: 'fileSearch',
      fileSearchStoreNames: input.fileSearch.fileSearchStoreNames,
      ...(input.fileSearch.metadataFilter !== undefined
        ? { metadataFilter: input.fileSearch.metadataFilter }
        : {}),
    });
  }
  if (input.extraBuiltInToolSpecs && input.extraBuiltInToolSpecs.length > 0) {
    builtInToolSpecs.push(...input.extraBuiltInToolSpecs);
  }
  return {
    builtInToolSpecs,
    ...(input.functionDeclarations !== undefined
      ? { functionDeclarations: input.functionDeclarations }
      : {}),
    ...(input.functionCallingMode !== undefined
      ? { functionCallingMode: input.functionCallingMode }
      : {}),
    ...(input.responseSchemaRequested !== undefined
      ? { responseSchemaRequested: input.responseSchemaRequested }
      : {}),
    ...(input.serverSideToolInvocations !== undefined
      ? { serverSideToolInvocations: input.serverSideToolInvocations }
      : {}),
    ...(input.urls !== undefined ? { urls: input.urls } : {}),
  };
}

export function buildUrlContextFallbackPart(
  urls: readonly string[] | undefined,
  activeCapabilities: ReadonlySet<string>,
): { text: string } | undefined {
  if (!urls || urls.length === 0) return undefined;
  if (activeCapabilities.has('urlContext')) return undefined;
  return { text: `Context URLs:\n${urls.join('\n')}` };
}

interface ToolProfileDetails {
  fileSearchStoreCount?: number;
  functionCount?: number;
  functionCallingMode?: string;
  serverSideToolInvocations?: boolean;
}

interface OrchestrationConfig {
  functionCallingMode?: FunctionCallingConfigMode;
  toolConfig?: ToolConfig;
  toolProfile: string;
  toolProfileDetails: ToolProfileDetails;
  tools?: ToolListUnion;
  activeCapabilities: Set<ActiveCapability>;
  resolvedProfile?: ResolvedProfile;
}

function resolveServerSideToolInvocations(
  policy: ServerSideToolInvocationsPolicy | undefined,
  activeCapabilities: ReadonlySet<string>,
): boolean | undefined {
  if (policy === 'never') return undefined;
  if (policy === 'always') return true;
  const hasBuiltIn = BUILT_IN_TOOL_NAMES.some((name) => activeCapabilities.has(name));
  return hasBuiltIn ? true : undefined;
}

function resolveFunctionCallingModeInternal(
  explicitMode: FunctionCallingConfigMode | undefined,
  activeCapabilities: ReadonlySet<string>,
  responseSchemaRequested: boolean | undefined,
): FunctionCallingConfigMode | undefined {
  if (explicitMode !== undefined) {
    return explicitMode;
  }
  if (!activeCapabilities.has('functions')) {
    return undefined;
  }
  const hasBuiltIn = BUILT_IN_TOOL_NAMES.some((name) => activeCapabilities.has(name));
  return hasBuiltIn || responseSchemaRequested === true
    ? FunctionCallingConfigMode.VALIDATED
    : undefined;
}

function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
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

  const fileSearchSpec = specs.find((spec) => spec.kind === 'fileSearch');
  const fileSearchStoreCount =
    fileSearchSpec?.kind === 'fileSearch' ? fileSearchSpec.fileSearchStoreNames.length : undefined;
  const functionCount = request.functionDeclarations?.length ?? undefined;

  const includeServerSideToolInvocations = resolveServerSideToolInvocations(
    request.serverSideToolInvocations,
    activeCapabilities,
  );
  const functionCallingMode = resolveFunctionCallingModeInternal(
    request.functionCallingMode,
    activeCapabilities,
    request.responseSchemaRequested,
  );

  const toolProfileDetails: ToolProfileDetails = {
    ...(fileSearchStoreCount !== undefined ? { fileSearchStoreCount } : {}),
    ...(functionCount !== undefined && functionCount > 0 ? { functionCount } : {}),
    ...(functionCallingMode !== undefined ? { functionCallingMode } : {}),
    ...(includeServerSideToolInvocations === true ? { serverSideToolInvocations: true } : {}),
  };

  const config: OrchestrationConfig = {
    toolProfile: buildToolProfile(tools),
    toolProfileDetails,
    activeCapabilities,
  };

  if (includeServerSideToolInvocations === true) {
    config.toolConfig = { includeServerSideToolInvocations: true };
  }

  if (functionCallingMode !== undefined) {
    config.functionCallingMode = functionCallingMode;
  }

  if (tools.length > 0) {
    config.tools = tools;
  }

  return config;
}

type ResolveOrchestrationResult =
  | { config: OrchestrationConfig; error?: undefined }
  | { config?: undefined; error: CallToolResult };

// ── Legacy request-based entry point (used by tool-executor.ts) ───────────────

export async function resolveOrchestrationFromRequest(
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
    toolProfileDetails: config.toolProfileDetails,
    activeCapabilities: [...config.activeCapabilities],
    serverSideToolInvocations,
    urlCount,
  };

  await mcpLog(ctx, 'info', `orchestration resolved: ${toolKey} -> ${config.toolProfile}`);
  logger.child(toolKey).info('orchestration resolved', payload);

  if (urlCount > 0 && !config.activeCapabilities.has('urlContext')) {
    await mcpLog(
      ctx,
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
    await mcpLog(
      ctx,
      'warning',
      `orchestration: ${toolKey} resolved File Search without fileSearchStoreNames`,
    );
  }

  return { config };
}

// ── Profile-driven entry point (new public API) ───────────────────────────────

export async function resolveOrchestration(
  toolsSpec: ToolsSpecInput | undefined,
  ctx: ServerContext,
  context: ResolveProfileContext,
): Promise<ResolveOrchestrationResult> {
  const resolved = resolveProfile(toolsSpec, context);

  try {
    validateProfile(resolved);
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      return { error: new AppError('orchestration', error.message).toToolResult() };
    }
    throw error;
  }

  const urlError = validateUrls(resolved.overrides.urls);
  if (urlError) {
    return { error: urlError };
  }

  const tools = buildToolsArray(resolved);
  const toolConfig = buildProfileToolConfig(resolved);
  const functionCallingMode = resolveProfileFunctionCallingMode(resolved);

  const activeCapabilities = new Set<ActiveCapability>();
  for (const builtIn of resolved.builtIns) {
    activeCapabilities.add(builtIn);
  }
  if ((resolved.overrides.functions?.length ?? 0) > 0) {
    activeCapabilities.add('functions');
  }

  const fileSearchStoreCount =
    resolved.profile === 'rag' ? (resolved.overrides.fileSearchStores?.length ?? 0) : undefined;
  const functionCount = resolved.overrides.functions?.length;

  const toolProfileDetails: ToolProfileDetails = {
    ...(fileSearchStoreCount !== undefined ? { fileSearchStoreCount } : {}),
    ...(functionCount !== undefined && functionCount > 0 ? { functionCount } : {}),
    ...(functionCallingMode !== undefined ? { functionCallingMode } : {}),
    ...(toolConfig?.includeServerSideToolInvocations === true
      ? { serverSideToolInvocations: true }
      : {}),
  };

  const toolProfileParts = [
    ...resolved.builtIns,
    ...((resolved.overrides.functions?.length ?? 0) > 0 ? ['functionDeclarations'] : []),
  ].sort();
  const toolProfile = toolProfileParts.length === 0 ? 'none' : toolProfileParts.join('+');

  const config: OrchestrationConfig = {
    resolvedProfile: resolved,
    toolProfile,
    toolProfileDetails,
    activeCapabilities,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    ...(functionCallingMode !== undefined ? { functionCallingMode } : {}),
  };

  const logPayload = {
    toolKey: context.toolKey,
    profile: resolved.profile,
    autoPromoted: resolved.autoPromoted,
    builtIns: [...resolved.builtIns],
    thinkingLevel: resolved.thinkingLevel,
  };

  await mcpLog(
    ctx,
    'info',
    `orchestration resolved: ${context.toolKey} -> ${resolved.profile}${resolved.autoPromoted ? ' (auto-promoted)' : ''}`,
  );
  logger.child(context.toolKey).info('tool.profile.resolved', logPayload);

  return { config };
}

// Re-export profile types for callers that need them
export type { ToolsSpecInput } from './tool-profiles.js';
