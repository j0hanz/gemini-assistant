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
  return toolProfile !== 'none';
}

function buildBuiltInTools(toolProfile: ToolProfile): ToolListUnion {
  switch (toolProfile) {
    case 'search':
      return [{ googleSearch: {} }];
    case 'url':
      return [{ urlContext: {} }];
    case 'search_url':
      return [{ googleSearch: {} }, { urlContext: {} }];
    case 'code':
      return [{ codeExecution: {} }];
    case 'search_code':
      return [{ googleSearch: {} }, { codeExecution: {} }];
    case 'none':
    default:
      return [];
  }
}

export function buildOrchestrationConfig(request: OrchestrationRequest): OrchestrationConfig {
  const toolProfile = normalizeToolProfile(request);
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
    usesCodeExecution: toolProfile === 'code' || toolProfile === 'search_code',
    usesGoogleSearch:
      toolProfile === 'search' || toolProfile === 'search_url' || toolProfile === 'search_code',
    usesUrlContext: toolProfile === 'url' || toolProfile === 'search_url',
  };
}
