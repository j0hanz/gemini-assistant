import {
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type ToolConfig,
  type ToolListUnion,
} from '@google/genai';

export const TOOL_PROFILES = [
  'none',
  'search',
  'url',
  'search_url',
  'code',
  'search_code',
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
};

interface OrchestrationRequest {
  functionDeclarations?: FunctionDeclaration[] | undefined;
  googleSearch?: boolean | undefined;
  includeServerSideToolInvocations?: boolean | undefined;
  toolProfile?: ToolProfile | undefined;
  urls?: readonly string[] | undefined;
}

interface OrchestrationConfig {
  functionCallingMode?: FunctionCallingConfigMode;
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

  if (googleSearch) {
    return urls && urls.length > 0 ? 'search_url' : 'search';
  }

  return 'none';
}

function hasBuiltInTools(toolProfile: ToolProfile): boolean {
  return TOOL_PROFILE_CAPABILITIES[toolProfile].builtInTools.length > 0;
}

function buildBuiltInTools(toolProfile: ToolProfile): ToolListUnion {
  return TOOL_PROFILE_CAPABILITIES[toolProfile].builtInTools.map((tool) => ({ ...tool }));
}

function hasFunctionDeclarations(
  functionDeclarations: FunctionDeclaration[] | undefined,
): functionDeclarations is FunctionDeclaration[] {
  return (functionDeclarations?.length ?? 0) > 0;
}

function buildTools(
  builtInTools: ToolListUnion,
  functionDeclarations: FunctionDeclaration[] | undefined,
): ToolListUnion {
  if (!hasFunctionDeclarations(functionDeclarations)) {
    return builtInTools;
  }

  return [...builtInTools, { functionDeclarations }];
}

function buildFunctionCallingMode(
  hasBuiltInToolsForProfile: boolean,
  functionDeclarations: FunctionDeclaration[] | undefined,
): FunctionCallingConfigMode | undefined {
  return hasBuiltInToolsForProfile && hasFunctionDeclarations(functionDeclarations)
    ? FunctionCallingConfigMode.VALIDATED
    : undefined;
}

function buildToolConfig(
  includeServerSideToolInvocations: boolean | undefined,
  hasBuiltInToolsForProfile: boolean,
  functionDeclarations: FunctionDeclaration[] | undefined,
): ToolConfig | undefined {
  const shouldExposeServerTools =
    includeServerSideToolInvocations === true ||
    (hasBuiltInToolsForProfile && hasFunctionDeclarations(functionDeclarations));

  return shouldExposeServerTools ? { includeServerSideToolInvocations: true } : undefined;
}

export function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
  const toolProfile = normalizeToolProfile(request);
  const capabilities = TOOL_PROFILE_CAPABILITIES[toolProfile];
  const builtInTools = buildBuiltInTools(toolProfile);
  const functionDeclarations = request.functionDeclarations?.slice();
  const hasBuiltInToolsForProfile = hasBuiltInTools(toolProfile);
  const tools = buildTools(builtInTools, functionDeclarations);
  const functionCallingMode = buildFunctionCallingMode(
    hasBuiltInToolsForProfile,
    functionDeclarations,
  );
  const toolConfig = buildToolConfig(
    request.includeServerSideToolInvocations,
    hasBuiltInToolsForProfile,
    functionDeclarations,
  );

  const config: OrchestrationConfig = {
    toolProfile,
    usesCodeExecution: capabilities.usesCodeExecution,
    usesGoogleSearch: capabilities.usesGoogleSearch,
    usesUrlContext: capabilities.usesUrlContext,
  };

  if (functionCallingMode) {
    config.functionCallingMode = functionCallingMode;
  }

  if (toolConfig) {
    config.toolConfig = toolConfig;
  }

  if (tools.length > 0) {
    config.tools = tools;
  }

  return config;
}
