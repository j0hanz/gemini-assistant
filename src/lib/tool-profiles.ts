import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import {
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type ToolConfig,
  type ToolListUnion,
} from '@google/genai';

import type { McpServerSpec } from '../schemas/fields.js';

import type { AskThinkingLevel } from '../public-contract.js';
import { AppError } from './errors.js';
import { logger, mcpLog } from './logger.js';
import { validateUrls } from './validation.js';

type BuiltInCapability = 'googleSearch' | 'urlContext' | 'codeExecution' | 'fileSearch';

/** Lowercase thinking levels used in the public ToolsSpec input. */
type ProfileThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export const TOOL_PROFILE_NAMES = [
  'plain',
  'grounded',
  'web-research',
  'deep-research',
  'urls-only',
  'code-math',
  'code-math-grounded',
  'visual-inspect',
  'rag',
  'agent',
  'structured',
] as const;

type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number];

interface ProfileDefinition {
  name: ToolProfileName;
  builtIns: readonly BuiltInCapability[];
  defaultThinkingLevel: ProfileThinkingLevel;
  meta: boolean;
  notes: string;
}

export const PROFILES: Readonly<Record<ToolProfileName, ProfileDefinition>> = {
  plain: {
    name: 'plain',
    builtIns: [],
    defaultThinkingLevel: 'minimal',
    meta: false,
    notes: 'Pure generation.',
  },
  grounded: {
    name: 'grounded',
    builtIns: ['googleSearch'],
    defaultThinkingLevel: 'medium',
    meta: false,
    notes: 'Real-time facts + citations.',
  },
  'web-research': {
    name: 'web-research',
    builtIns: ['googleSearch', 'urlContext'],
    defaultThinkingLevel: 'medium',
    meta: false,
    notes: 'Search + read specific pages.',
  },
  'deep-research': {
    name: 'deep-research',
    builtIns: ['googleSearch', 'urlContext', 'codeExecution'],
    defaultThinkingLevel: 'high',
    meta: false,
    notes: 'Search + synthesis + computation.',
  },
  'urls-only': {
    name: 'urls-only',
    builtIns: ['urlContext'],
    defaultThinkingLevel: 'medium',
    meta: false,
    notes: 'Caller-supplied URLs only.',
  },
  'code-math': {
    name: 'code-math',
    builtIns: ['codeExecution'],
    defaultThinkingLevel: 'medium',
    meta: false,
    notes: 'Calc/plot/CSV.',
  },
  'code-math-grounded': {
    name: 'code-math-grounded',
    builtIns: ['codeExecution', 'googleSearch'],
    defaultThinkingLevel: 'medium',
    meta: false,
    notes: 'Compute over fresh facts.',
  },
  'visual-inspect': {
    name: 'visual-inspect',
    builtIns: ['codeExecution'],
    defaultThinkingLevel: 'high',
    meta: false,
    notes: 'Gemini 3 Flash image zoom/annotate. Requires thinkingLevel >= medium.',
  },
  rag: {
    name: 'rag',
    builtIns: ['fileSearch'],
    defaultThinkingLevel: 'medium',
    meta: false,
    notes: 'Mutually exclusive with all other built-ins.',
  },
  agent: {
    name: 'agent',
    builtIns: [],
    defaultThinkingLevel: 'high',
    meta: true,
    notes: 'Meta: requires functions modifier; layers over any base.',
  },
  structured: {
    name: 'structured',
    builtIns: [],
    defaultThinkingLevel: 'minimal',
    meta: true,
    notes: 'Meta: requires responseSchemaJson modifier.',
  },
};

// ── Error types ───────────────────────────────────────────────────────────────

type ProfileErrorCode =
  | 'FILE_SEARCH_EXCLUSIVE'
  | 'FUNCTIONS_REQUIRED_FOR_PROFILE'
  | 'RESPONSE_SCHEMA_REQUIRED_FOR_PROFILE'
  | 'THINKING_LEVEL_TOO_LOW'
  | 'TOO_MANY_FUNCTIONS'
  | 'URLS_NOT_PERMITTED_BY_PROFILE'
  | 'FILE_SEARCH_STORES_REQUIRED'
  | 'FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS';

export class ProfileValidationError extends Error {
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

// ── Input / resolved types ────────────────────────────────────────────────────

interface FunctionDeclarationInput {
  name: string;
  description: string;
  parametersJsonSchema?: Record<string, unknown> | undefined;
}

type FunctionCallingModeValue = 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';

/**
 * Spec for an MCP server that can be connected to and have its tools exposed to Gemini.
 * When present on agent profile, the server is queried for available tools via tools/list,
 * and tool declarations are merged with explicit functions.
 */
interface ToolsSpecOverrides {
  urls?: string[] | undefined;
  fileSearchStores?: string[] | undefined;
  functions?: FunctionDeclarationInput[] | undefined;
  mcpServer?: McpServerSpec | undefined;
  responseSchemaJson?: Record<string, unknown> | undefined;
  functionCallingMode?: FunctionCallingModeValue | undefined;
  allowedFunctionNames?: string[] | undefined;
}

export interface ToolsSpecInput {
  profile?: ToolProfileName | undefined;
  thinkingLevel?: ProfileThinkingLevel | undefined;
  overrides?: ToolsSpecOverrides | undefined;
}

type ToolKey = 'chat' | 'research' | 'analyze' | 'review';

type ToolMode =
  | 'quick'
  | 'deep'
  | 'file'
  | 'url'
  | 'multi'
  | 'diagram'
  | 'summary'
  | 'diff'
  | 'comparison'
  | 'failure';

interface ResolveProfileContext {
  toolKey: ToolKey;
  mode?: ToolMode | undefined;
  hasImageInput?: boolean | undefined;
}

export interface ResolvedProfile {
  profile: ToolProfileName;
  builtIns: readonly BuiltInCapability[];
  thinkingLevel: ProfileThinkingLevel;
  autoPromoted: boolean;
  overrides: ToolsSpecOverrides;
}

// ── Thinking level helpers ────────────────────────────────────────────────────

const THINKING_LEVEL_ORDER: Record<ProfileThinkingLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function compareThinkingLevels(a: ProfileThinkingLevel, b: ProfileThinkingLevel): number {
  return THINKING_LEVEL_ORDER[a] - THINKING_LEVEL_ORDER[b];
}

export function toAskThinkingLevel(level: ProfileThinkingLevel): AskThinkingLevel {
  return level.toUpperCase() as AskThinkingLevel;
}

// ── Per-tool default profile selection ───────────────────────────────────────

function selectDefaultProfile(context: ResolveProfileContext, hasUrls: boolean): ToolProfileName {
  const { toolKey, mode } = context;
  switch (toolKey) {
    case 'chat':
      // URLs require urlContext to be processed via URL Context API; web-research includes it
      return hasUrls ? 'web-research' : 'plain';
    case 'research':
      return mode === 'deep' ? 'deep-research' : 'web-research';
    case 'analyze':
      return 'code-math';
    case 'review':
      if (mode === 'comparison') return hasUrls ? 'urls-only' : 'plain';
      if (mode === 'failure') return 'web-research';
      return 'plain';
  }
}

// ── resolveProfile ────────────────────────────────────────────────────────────

export function resolveProfile(
  input: ToolsSpecInput | undefined,
  context: ResolveProfileContext,
): ResolvedProfile {
  const overrides = input?.overrides ?? {};
  const hasUrls = (overrides.urls?.length ?? 0) > 0;
  let autoPromoted = false;

  let profileName: ToolProfileName;
  if (input?.profile !== undefined) {
    profileName = input.profile;
  } else {
    profileName = selectDefaultProfile(context, hasUrls);
    if (hasUrls && profileName === 'web-research') {
      autoPromoted = true;
    }
  }

  let profileDef = PROFILES[profileName];
  let builtIns: readonly BuiltInCapability[] = profileDef.builtIns;

  // Auto-promote analyze with image input + thinking >= medium → visual-inspect
  if (
    context.toolKey === 'analyze' &&
    context.hasImageInput === true &&
    profileName === 'code-math' &&
    input?.profile === undefined
  ) {
    const effectiveLevel = input?.thinkingLevel ?? profileDef.defaultThinkingLevel;
    if (compareThinkingLevels(effectiveLevel, 'medium') >= 0) {
      profileName = 'visual-inspect';
      profileDef = PROFILES['visual-inspect'];
      builtIns = profileDef.builtIns;
      autoPromoted = true;
    }
  }

  const thinkingLevel: ProfileThinkingLevel =
    input?.thinkingLevel ?? profileDef.defaultThinkingLevel;

  return { profile: profileName, builtIns, thinkingLevel, autoPromoted, overrides };
}

// ── validateProfile ───────────────────────────────────────────────────────────

export function validateProfile(resolved: ResolvedProfile): void {
  const { profile, builtIns, thinkingLevel, overrides } = resolved;
  const hasFunctions = (overrides.functions?.length ?? 0) > 0;
  const hasUrls = (overrides.urls?.length ?? 0) > 0;
  const hasFileSearch = builtIns.includes('fileSearch');
  const hasOtherBuiltIns = builtIns.some((b) => b !== 'fileSearch');

  if (hasFileSearch && hasOtherBuiltIns) {
    throw new ProfileValidationError(
      'FILE_SEARCH_EXCLUSIVE',
      `Profile '${profile}': fileSearch cannot be combined with other built-in tools.`,
    );
  }

  if (hasFileSearch && hasFunctions) {
    throw new ProfileValidationError(
      'FILE_SEARCH_EXCLUSIVE',
      `Profile '${profile}': fileSearch cannot be combined with functions.`,
    );
  }

  if (profile === 'agent' && !hasFunctions) {
    throw new ProfileValidationError(
      'FUNCTIONS_REQUIRED_FOR_PROFILE',
      `Profile 'agent' requires overrides.functions to be set.`,
    );
  }

  if (profile === 'structured' && !overrides.responseSchemaJson) {
    throw new ProfileValidationError(
      'RESPONSE_SCHEMA_REQUIRED_FOR_PROFILE',
      `Profile 'structured' requires overrides.responseSchemaJson to be set.`,
    );
  }

  if (profile === 'visual-inspect' && compareThinkingLevels(thinkingLevel, 'medium') < 0) {
    throw new ProfileValidationError(
      'THINKING_LEVEL_TOO_LOW',
      `Profile 'visual-inspect' requires thinkingLevel >= 'medium' (got '${thinkingLevel}').`,
    );
  }

  const functionCount = overrides.functions?.length ?? 0;
  if (functionCount > 20) {
    throw new ProfileValidationError(
      'TOO_MANY_FUNCTIONS',
      `Profile '${profile}': functions cap is 20 (got ${String(functionCount)}).`,
    );
  }

  if (hasUrls && !builtIns.includes('urlContext')) {
    throw new ProfileValidationError(
      'URLS_NOT_PERMITTED_BY_PROFILE',
      `Profile '${profile}' does not include urlContext. Use 'web-research', 'deep-research', or 'urls-only' instead.`,
    );
  }

  if (profile === 'rag' && (overrides.fileSearchStores?.length ?? 0) === 0) {
    throw new ProfileValidationError(
      'FILE_SEARCH_STORES_REQUIRED',
      `Profile 'rag' requires overrides.fileSearchStores to be set.`,
    );
  }

  const mode = overrides.functionCallingMode;
  const hasBuiltIns = builtIns.length > 0;
  if (mode !== undefined && hasBuiltIns) {
    if (mode === 'ANY' || mode === 'AUTO') {
      throw new ProfileValidationError(
        'FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS',
        `functionCallingMode '${mode}' is not permitted when built-in tools are active. Use 'VALIDATED' instead.`,
      );
    }
  }
}

// ── SDK builders ──────────────────────────────────────────────────────────────

export function buildToolsArray(resolved: ResolvedProfile): ToolListUnion {
  const tools: ToolListUnion = [];

  for (const builtIn of resolved.builtIns) {
    if (builtIn === 'googleSearch') {
      tools.push({ googleSearch: {} });
    } else if (builtIn === 'urlContext') {
      tools.push({ urlContext: {} });
    } else if (builtIn === 'codeExecution') {
      tools.push({ codeExecution: {} });
    } else {
      const stores = resolved.overrides.fileSearchStores ?? [];
      tools.push({
        fileSearch: { fileSearchStoreNames: [...stores] },
      } satisfies ToolListUnion[number]);
    }
  }

  const functions = resolved.overrides.functions;
  if (functions && functions.length > 0) {
    tools.push({
      functionDeclarations: functions.map((decl) => ({
        name: decl.name,
        description: decl.description,
        ...(decl.parametersJsonSchema !== undefined
          ? { parametersJsonSchema: decl.parametersJsonSchema }
          : {}),
      })),
    });
  }

  return tools;
}

export function resolveProfileFunctionCallingMode(
  resolved: ResolvedProfile,
): FunctionCallingConfigMode | undefined {
  const hasFunctions = (resolved.overrides.functions?.length ?? 0) > 0;
  const hasBuiltIns = resolved.builtIns.length > 0;
  const explicit = resolved.overrides.functionCallingMode;

  if (explicit !== undefined) {
    return FunctionCallingConfigMode[explicit];
  }

  if (hasFunctions && (hasBuiltIns || resolved.overrides.responseSchemaJson !== undefined)) {
    return FunctionCallingConfigMode.VALIDATED;
  }

  return undefined;
}

function buildProfileToolConfig(resolved: ResolvedProfile): ToolConfig | undefined {
  const hasBuiltIns = resolved.builtIns.length > 0;
  const functionCallingMode = resolveProfileFunctionCallingMode(resolved);
  const allowedFunctionNames = resolved.overrides.allowedFunctionNames;

  const includeServerSideToolInvocations = hasBuiltIns ? true : undefined;
  const hasFunctionCallingConfig =
    functionCallingMode !== undefined || (allowedFunctionNames?.length ?? 0) > 0;
  const hasServerSideInvocations = includeServerSideToolInvocations === true;

  if (!hasFunctionCallingConfig && !hasServerSideInvocations) {
    return undefined;
  }

  return {
    ...(hasServerSideInvocations ? { includeServerSideToolInvocations: true } : {}),
    ...(hasFunctionCallingConfig
      ? {
          functionCallingConfig: {
            ...(functionCallingMode !== undefined ? { mode: functionCallingMode } : {}),
            ...(allowedFunctionNames?.length
              ? { allowedFunctionNames: [...allowedFunctionNames] }
              : {}),
          },
        }
      : {}),
  };
}

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

interface OrchestrationDiagnostic {
  level: 'info' | 'warning';
  message: string;
}

export function buildOrchestrationDiagnostics(
  request: OrchestrationRequest & { urls?: readonly string[] | undefined },
  toolKey: string,
  config?: OrchestrationConfig,
): OrchestrationDiagnostic[] {
  const resolvedConfig = config ?? buildOrchestrationConfig(request);
  const diagnostics: OrchestrationDiagnostic[] = [];

  // Info: resolved profile
  diagnostics.push({
    level: 'info',
    message: `orchestration resolved: ${toolKey} -> ${resolvedConfig.toolProfile}`,
  });

  // Warning: URLs without urlContext capability
  const urlCount = request.urls?.length ?? 0;
  if (urlCount > 0 && !resolvedConfig.activeCapabilities.has('urlContext')) {
    diagnostics.push({
      level: 'warning',
      message: `orchestration: ${toolKey} received ${String(urlCount)} URL(s) but resolved profile '${resolvedConfig.toolProfile}' does not expose URL Context`,
    });
  }

  // Warning: fileSearch stores validation
  const fileSearchSpec = (request.builtInToolSpecs ?? []).find(
    (spec) => spec.kind === 'fileSearch',
  );
  if (
    resolvedConfig.activeCapabilities.has('fileSearch') &&
    fileSearchSpec?.kind === 'fileSearch' &&
    fileSearchSpec.fileSearchStoreNames.length === 0
  ) {
    diagnostics.push({
      level: 'warning',
      message: `orchestration: ${toolKey} resolved File Search without fileSearchStoreNames`,
    });
  }

  return diagnostics;
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
  const diagnostics = buildOrchestrationDiagnostics(request, toolKey, config);

  // Log diagnostics (side-effect remains, but pure function is extracted)
  for (const diag of diagnostics) {
    if (diag.level === 'info') {
      await mcpLog(ctx, 'info', diag.message);
    } else {
      await mcpLog(ctx, 'warning', diag.message);
    }
  }

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

  logger.child(toolKey).info('orchestration resolved', payload);

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
