import { FunctionCallingConfigMode } from '@google/genai';
import type { ToolConfig, ToolListUnion } from '@google/genai';

import type { AskThinkingLevel } from '../public-contract.js';

type BuiltInCapability = 'googleSearch' | 'urlContext' | 'codeExecution' | 'fileSearch';
export type CapabilityKey = BuiltInCapability | 'functions';

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

export type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number];

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

export const COMBO_MATRIX: Readonly<
  Record<CapabilityKey, Readonly<Record<CapabilityKey, boolean>>>
> = {
  googleSearch: {
    googleSearch: true,
    urlContext: true,
    codeExecution: true,
    fileSearch: false,
    functions: true,
  },
  urlContext: {
    googleSearch: true,
    urlContext: true,
    codeExecution: true,
    fileSearch: false,
    functions: true,
  },
  codeExecution: {
    googleSearch: true,
    urlContext: true,
    codeExecution: true,
    fileSearch: false,
    functions: true,
  },
  fileSearch: {
    googleSearch: false,
    urlContext: false,
    codeExecution: false,
    fileSearch: true,
    functions: false,
  },
  functions: {
    googleSearch: true,
    urlContext: true,
    codeExecution: true,
    fileSearch: false,
    functions: true,
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
  parametersJsonSchema?: Record<string, unknown>;
}

type FunctionCallingModeValue = 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';

interface ToolsSpecOverrides {
  urls?: string[] | undefined;
  fileSearchStores?: string[] | undefined;
  functions?: FunctionDeclarationInput[] | undefined;
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

export interface ResolveProfileContext {
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

export function compareThinkingLevels(a: ProfileThinkingLevel, b: ProfileThinkingLevel): number {
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
          ? { parameters: decl.parametersJsonSchema }
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

export function buildProfileToolConfig(resolved: ResolvedProfile): ToolConfig | undefined {
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
