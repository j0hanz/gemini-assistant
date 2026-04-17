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

export interface OrchestrationConfig {
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

export function isUrlCapableToolProfile(toolProfile: ToolProfile): boolean {
  return toolProfile === 'url' || toolProfile === 'search_url';
}

function hasBuiltInTools(toolProfile: ToolProfile): boolean {
  return TOOL_PROFILE_CAPABILITIES[toolProfile].builtInTools.length > 0;
}

function buildBuiltInTools(toolProfile: ToolProfile): ToolListUnion {
  return TOOL_PROFILE_CAPABILITIES[toolProfile].builtInTools.map((tool) => ({ ...tool }));
}

export function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
  const toolProfile = normalizeToolProfile(request);
  const capabilities = TOOL_PROFILE_CAPABILITIES[toolProfile];
  const builtInTools = buildBuiltInTools(toolProfile);
  const functionDeclarations = request.functionDeclarations?.slice();
  const tools: ToolListUnion = [
    ...builtInTools,
    ...(functionDeclarations && functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
  ];

  const shouldExposeServerTools =
    request.includeServerSideToolInvocations === true ||
    (hasBuiltInTools(toolProfile) && (functionDeclarations?.length ?? 0) > 0);

  const toolConfig: ToolConfig | undefined = shouldExposeServerTools
    ? { includeServerSideToolInvocations: true }
    : undefined;

  return {
    ...(functionDeclarations && functionDeclarations.length > 0 && hasBuiltInTools(toolProfile)
      ? { functionCallingMode: FunctionCallingConfigMode.VALIDATED }
      : {}),
    ...(toolConfig ? { toolConfig } : {}),
    toolProfile,
    ...(tools.length > 0 ? { tools } : {}),
    usesCodeExecution: capabilities.usesCodeExecution,
    usesGoogleSearch: capabilities.usesGoogleSearch,
    usesUrlContext: capabilities.usesUrlContext,
  };
}
