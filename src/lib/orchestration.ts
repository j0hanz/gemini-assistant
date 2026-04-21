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
  const functionDeclarations = request.functionDeclarations?.slice();
  const hasBuiltIn = builtInTools.length > 0;
  const hasDeclarations = functionDeclarations !== undefined && functionDeclarations.length > 0;

  const tools: ToolListUnion = [...builtInTools];
  if (hasDeclarations) {
    tools.push({ functionDeclarations });
  }

  const config: OrchestrationConfig = {
    toolProfile,
    usesCodeExecution: capabilities.usesCodeExecution,
    usesGoogleSearch: capabilities.usesGoogleSearch,
    usesUrlContext: capabilities.usesUrlContext,
  };

  if (hasBuiltIn && hasDeclarations) {
    config.functionCallingMode = FunctionCallingConfigMode.VALIDATED;
  }

  const shouldExposeServerTools =
    request.includeServerSideToolInvocations === true || (hasBuiltIn && hasDeclarations);

  if (shouldExposeServerTools) {
    config.toolConfig = { includeServerSideToolInvocations: true };
  }

  if (tools.length > 0) {
    config.tools = tools;
  }

  return config;
}
