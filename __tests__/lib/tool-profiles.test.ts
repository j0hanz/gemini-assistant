import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FunctionCallingConfigMode } from '@google/genai';

import {
  buildProfileToolConfig,
  buildToolsArray,
  type CapabilityKey,
  COMBO_MATRIX,
  compareThinkingLevels,
  PROFILES,
  ProfileValidationError,
  type ResolvedProfile,
  resolveProfile,
  resolveProfileFunctionCallingMode,
  toAskThinkingLevel,
  TOOL_PROFILE_NAMES,
  type ToolProfileName,
  validateProfile,
} from '../../src/lib/tool-profiles.js';

// ── Catalog tests ─────────────────────────────────────────────────────────────

describe('TOOL_PROFILE_NAMES', () => {
  it('contains exactly 11 profiles', () => {
    assert.strictEqual(TOOL_PROFILE_NAMES.length, 11);
  });

  it('contains all expected profile names', () => {
    const expected: ToolProfileName[] = [
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
    ];
    for (const name of expected) {
      assert.ok(
        (TOOL_PROFILE_NAMES as readonly string[]).includes(name),
        `Missing profile: ${name}`,
      );
    }
  });
});

describe('PROFILES catalog', () => {
  it('has an entry for every profile name', () => {
    for (const name of TOOL_PROFILE_NAMES) {
      assert.ok(PROFILES[name], `Missing PROFILES entry for: ${name}`);
      assert.strictEqual(PROFILES[name].name, name);
    }
  });

  const builtInsMap: Record<ToolProfileName, readonly string[]> = {
    plain: [],
    grounded: ['googleSearch'],
    'web-research': ['googleSearch', 'urlContext'],
    'deep-research': ['googleSearch', 'urlContext', 'codeExecution'],
    'urls-only': ['urlContext'],
    'code-math': ['codeExecution'],
    'code-math-grounded': ['codeExecution', 'googleSearch'],
    'visual-inspect': ['codeExecution'],
    rag: ['fileSearch'],
    agent: [],
    structured: [],
  };

  for (const [name, expectedBuiltIns] of Object.entries(builtInsMap)) {
    it(`profile '${name}' has correct built-ins`, () => {
      const profile = PROFILES[name as ToolProfileName];
      assert.deepStrictEqual([...profile.builtIns].sort(), [...expectedBuiltIns].sort());
    });
  }

  it('marks agent and structured as meta profiles', () => {
    assert.strictEqual(PROFILES['agent'].meta, true);
    assert.strictEqual(PROFILES['structured'].meta, true);
  });

  it('marks all non-meta profiles as not meta', () => {
    for (const name of TOOL_PROFILE_NAMES) {
      if (name === 'agent' || name === 'structured') continue;
      assert.strictEqual(PROFILES[name].meta, false, `${name} should not be meta`);
    }
  });

  it('visual-inspect has defaultThinkingLevel high', () => {
    assert.strictEqual(PROFILES['visual-inspect'].defaultThinkingLevel, 'high');
  });

  it('deep-research has defaultThinkingLevel high', () => {
    assert.strictEqual(PROFILES['deep-research'].defaultThinkingLevel, 'high');
  });

  it('agent has defaultThinkingLevel high', () => {
    assert.strictEqual(PROFILES['agent'].defaultThinkingLevel, 'high');
  });

  it('plain has defaultThinkingLevel minimal', () => {
    assert.strictEqual(PROFILES['plain'].defaultThinkingLevel, 'minimal');
  });

  it('all profiles have non-empty notes', () => {
    for (const name of TOOL_PROFILE_NAMES) {
      assert.ok(PROFILES[name].notes.length > 0, `Profile '${name}' should have notes`);
    }
  });
});

// ── COMBO_MATRIX tests ────────────────────────────────────────────────────────

describe('COMBO_MATRIX', () => {
  const capabilities: CapabilityKey[] = [
    'googleSearch',
    'urlContext',
    'codeExecution',
    'fileSearch',
    'functions',
  ];

  it('has entries for all 5 capabilities', () => {
    for (const cap of capabilities) {
      assert.ok(COMBO_MATRIX[cap], `Missing matrix entry for: ${cap}`);
    }
  });

  it('each capability row covers all 5 capabilities', () => {
    for (const cap of capabilities) {
      const row = COMBO_MATRIX[cap];
      for (const other of capabilities) {
        assert.ok(
          typeof row[other] === 'boolean',
          `COMBO_MATRIX[${cap}][${other}] should be boolean`,
        );
      }
    }
  });

  it('fileSearch is incompatible with all other capabilities', () => {
    for (const other of capabilities) {
      if (other === 'fileSearch') continue;
      assert.strictEqual(COMBO_MATRIX['fileSearch'][other], false, `fileSearch + ${other}`);
      assert.strictEqual(COMBO_MATRIX[other]['fileSearch'], false, `${other} + fileSearch`);
    }
  });

  it('non-fileSearch capabilities are compatible with each other', () => {
    const nonFileSearch: CapabilityKey[] = [
      'googleSearch',
      'urlContext',
      'codeExecution',
      'functions',
    ];
    for (const a of nonFileSearch) {
      for (const b of nonFileSearch) {
        assert.strictEqual(COMBO_MATRIX[a][b], true, `${a} + ${b} should be compatible`);
      }
    }
  });

  it('is symmetric', () => {
    for (const a of capabilities) {
      for (const b of capabilities) {
        assert.strictEqual(
          COMBO_MATRIX[a][b],
          COMBO_MATRIX[b][a],
          `Matrix should be symmetric: [${a}][${b}] !== [${b}][${a}]`,
        );
      }
    }
  });
});

// ── Thinking level helpers ────────────────────────────────────────────────────

describe('compareThinkingLevels', () => {
  it('returns 0 for equal levels', () => {
    assert.strictEqual(compareThinkingLevels('medium', 'medium'), 0);
  });

  it('returns positive when first > second', () => {
    assert.ok(compareThinkingLevels('high', 'medium') > 0);
    assert.ok(compareThinkingLevels('medium', 'low') > 0);
    assert.ok(compareThinkingLevels('low', 'minimal') > 0);
  });

  it('returns negative when first < second', () => {
    assert.ok(compareThinkingLevels('minimal', 'medium') < 0);
    assert.ok(compareThinkingLevels('low', 'high') < 0);
  });
});

describe('toAskThinkingLevel', () => {
  it('converts lowercase to uppercase AskThinkingLevel', () => {
    assert.strictEqual(toAskThinkingLevel('minimal'), 'MINIMAL');
    assert.strictEqual(toAskThinkingLevel('low'), 'LOW');
    assert.strictEqual(toAskThinkingLevel('medium'), 'MEDIUM');
    assert.strictEqual(toAskThinkingLevel('high'), 'HIGH');
  });
});

// ── resolveProfile ────────────────────────────────────────────────────────────

describe('resolveProfile', () => {
  it('uses the explicit profile when provided', () => {
    const resolved = resolveProfile({ profile: 'grounded' }, { toolKey: 'chat' });
    assert.strictEqual(resolved.profile, 'grounded');
    assert.strictEqual(resolved.autoPromoted, false);
  });

  it('chat with no tools defaults to plain', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'chat' });
    assert.strictEqual(resolved.profile, 'plain');
    assert.strictEqual(resolved.autoPromoted, false);
  });

  it('chat with urls auto-promotes to web-research (urlContext needed for URL Context API)', () => {
    const resolved = resolveProfile(
      { overrides: { urls: ['https://example.com'] } },
      { toolKey: 'chat' },
    );
    assert.strictEqual(resolved.profile, 'web-research');
    assert.strictEqual(resolved.autoPromoted, true);
  });

  it('chat with explicit profile and urls does NOT auto-promote', () => {
    const resolved = resolveProfile(
      { profile: 'grounded', overrides: { urls: ['https://example.com'] } },
      { toolKey: 'chat' },
    );
    assert.strictEqual(resolved.profile, 'grounded');
    assert.strictEqual(resolved.autoPromoted, false);
  });

  it('research quick defaults to web-research', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'research', mode: 'quick' });
    assert.strictEqual(resolved.profile, 'web-research');
  });

  it('research deep defaults to deep-research', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'research', mode: 'deep' });
    assert.strictEqual(resolved.profile, 'deep-research');
  });

  it('analyze without image defaults to code-math', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'analyze', hasImageInput: false });
    assert.strictEqual(resolved.profile, 'code-math');
  });

  it('analyze with image + medium thinking auto-promotes to visual-inspect', () => {
    const resolved = resolveProfile(
      { thinkingLevel: 'medium' },
      { toolKey: 'analyze', hasImageInput: true },
    );
    assert.strictEqual(resolved.profile, 'visual-inspect');
    assert.strictEqual(resolved.autoPromoted, true);
  });

  it('analyze with image + minimal thinking does NOT auto-promote to visual-inspect', () => {
    const resolved = resolveProfile(
      { thinkingLevel: 'minimal' },
      { toolKey: 'analyze', hasImageInput: true },
    );
    assert.strictEqual(resolved.profile, 'code-math');
    assert.strictEqual(resolved.autoPromoted, false);
  });

  it('analyze with image and explicit profile does NOT auto-promote', () => {
    const resolved = resolveProfile(
      { profile: 'code-math' },
      { toolKey: 'analyze', hasImageInput: true },
    );
    assert.strictEqual(resolved.profile, 'code-math');
    assert.strictEqual(resolved.autoPromoted, false);
  });

  it('review diff defaults to plain', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'review', mode: 'diff' });
    assert.strictEqual(resolved.profile, 'plain');
  });

  it('review failure defaults to web-research', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'review', mode: 'failure' });
    assert.strictEqual(resolved.profile, 'web-research');
  });

  it('review comparison with urls defaults to urls-only', () => {
    const resolved = resolveProfile(
      { overrides: { urls: ['https://example.com'] } },
      { toolKey: 'review', mode: 'comparison' },
    );
    assert.strictEqual(resolved.profile, 'urls-only');
  });

  it('review comparison without urls defaults to plain', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'review', mode: 'comparison' });
    assert.strictEqual(resolved.profile, 'plain');
  });

  it('uses the profile default thinkingLevel when none specified', () => {
    const resolved = resolveProfile(undefined, { toolKey: 'research', mode: 'deep' });
    assert.strictEqual(resolved.thinkingLevel, 'high');
  });

  it('uses caller-specified thinkingLevel over profile default', () => {
    const resolved = resolveProfile(
      { thinkingLevel: 'low' },
      { toolKey: 'research', mode: 'deep' },
    );
    assert.strictEqual(resolved.thinkingLevel, 'low');
  });
});

// ── validateProfile ───────────────────────────────────────────────────────────

describe('validateProfile', () => {
  function makeResolved(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
    return {
      profile: 'plain',
      builtIns: [],
      thinkingLevel: 'medium',
      autoPromoted: false,
      overrides: {},
      ...overrides,
    };
  }

  it('accepts valid plain profile with no overrides', () => {
    assert.doesNotThrow(() => validateProfile(makeResolved()));
  });

  it('accepts rag with fileSearchStores', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'rag',
          builtIns: ['fileSearch'],
          overrides: { fileSearchStores: ['stores/docs'] },
        }),
      ),
    );
  });

  it('rejects FILE_SEARCH_EXCLUSIVE when fileSearch + other built-in', () => {
    assert.throws(
      () =>
        validateProfile(makeResolved({ profile: 'rag', builtIns: ['fileSearch', 'googleSearch'] })),
      (err) => err instanceof ProfileValidationError && err.code === 'FILE_SEARCH_EXCLUSIVE',
    );
  });

  it('rejects FILE_SEARCH_EXCLUSIVE when fileSearch + functions', () => {
    assert.throws(
      () =>
        validateProfile(
          makeResolved({
            profile: 'rag',
            builtIns: ['fileSearch'],
            overrides: { functions: [{ name: 'fn', description: 'test' }] },
          }),
        ),
      (err) => err instanceof ProfileValidationError && err.code === 'FILE_SEARCH_EXCLUSIVE',
    );
  });

  it('rejects FUNCTIONS_REQUIRED_FOR_PROFILE for agent without functions', () => {
    assert.throws(
      () => validateProfile(makeResolved({ profile: 'agent', builtIns: [] })),
      (err) =>
        err instanceof ProfileValidationError && err.code === 'FUNCTIONS_REQUIRED_FOR_PROFILE',
    );
  });

  it('accepts agent with functions provided', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'agent',
          builtIns: [],
          overrides: { functions: [{ name: 'fn', description: 'does stuff' }] },
        }),
      ),
    );
  });

  it('rejects RESPONSE_SCHEMA_REQUIRED_FOR_PROFILE for structured without schema', () => {
    assert.throws(
      () => validateProfile(makeResolved({ profile: 'structured', builtIns: [] })),
      (err) =>
        err instanceof ProfileValidationError &&
        err.code === 'RESPONSE_SCHEMA_REQUIRED_FOR_PROFILE',
    );
  });

  it('rejects THINKING_LEVEL_TOO_LOW for visual-inspect with minimal', () => {
    assert.throws(
      () =>
        validateProfile(
          makeResolved({
            profile: 'visual-inspect',
            builtIns: ['codeExecution'],
            thinkingLevel: 'minimal',
          }),
        ),
      (err) => err instanceof ProfileValidationError && err.code === 'THINKING_LEVEL_TOO_LOW',
    );
  });

  it('accepts visual-inspect with medium thinking', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'visual-inspect',
          builtIns: ['codeExecution'],
          thinkingLevel: 'medium',
        }),
      ),
    );
  });

  it('rejects TOO_MANY_FUNCTIONS when > 20 declarations', () => {
    const functions = Array.from({ length: 21 }, (_, i) => ({
      name: `fn${String(i)}`,
      description: 'test',
    }));
    assert.throws(
      () => validateProfile(makeResolved({ overrides: { functions } })),
      (err) => err instanceof ProfileValidationError && err.code === 'TOO_MANY_FUNCTIONS',
    );
  });

  it('accepts exactly 20 functions', () => {
    const functions = Array.from({ length: 20 }, (_, i) => ({
      name: `fn${String(i)}`,
      description: 'test',
    }));
    assert.doesNotThrow(() => validateProfile(makeResolved({ overrides: { functions } })));
  });

  it('rejects URLS_NOT_PERMITTED_BY_PROFILE when urls provided but no urlContext', () => {
    assert.throws(
      () =>
        validateProfile(
          makeResolved({
            profile: 'plain',
            builtIns: [],
            overrides: { urls: ['https://example.com'] },
          }),
        ),
      (err) =>
        err instanceof ProfileValidationError && err.code === 'URLS_NOT_PERMITTED_BY_PROFILE',
    );
  });

  it('accepts urls when urlContext built-in is present', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'web-research',
          builtIns: ['googleSearch', 'urlContext'],
          overrides: { urls: ['https://example.com'] },
        }),
      ),
    );
  });

  it('rejects FILE_SEARCH_STORES_REQUIRED for rag without stores', () => {
    assert.throws(
      () =>
        validateProfile(
          makeResolved({
            profile: 'rag',
            builtIns: ['fileSearch'],
            overrides: {},
          }),
        ),
      (err) => err instanceof ProfileValidationError && err.code === 'FILE_SEARCH_STORES_REQUIRED',
    );
  });

  it('rejects FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS for ANY with built-ins', () => {
    assert.throws(
      () =>
        validateProfile(
          makeResolved({
            profile: 'grounded',
            builtIns: ['googleSearch'],
            overrides: { functionCallingMode: 'ANY' },
          }),
        ),
      (err) =>
        err instanceof ProfileValidationError &&
        err.code === 'FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS',
    );
  });

  it('rejects FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS for AUTO with built-ins', () => {
    assert.throws(
      () =>
        validateProfile(
          makeResolved({
            profile: 'grounded',
            builtIns: ['googleSearch'],
            overrides: { functionCallingMode: 'AUTO' },
          }),
        ),
      (err) =>
        err instanceof ProfileValidationError &&
        err.code === 'FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS',
    );
  });

  it('accepts NONE functionCallingMode with built-ins', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'grounded',
          builtIns: ['googleSearch'],
          overrides: { functionCallingMode: 'NONE' },
        }),
      ),
    );
  });

  it('accepts VALIDATED functionCallingMode with built-ins', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'grounded',
          builtIns: ['googleSearch'],
          overrides: { functionCallingMode: 'VALIDATED' },
        }),
      ),
    );
  });

  it('accepts ANY when no built-ins are active', () => {
    assert.doesNotThrow(() =>
      validateProfile(
        makeResolved({
          profile: 'plain',
          builtIns: [],
          overrides: {
            functionCallingMode: 'ANY',
            functions: [{ name: 'fn', description: 'test' }],
          },
        }),
      ),
    );
  });
});

// ── buildToolsArray ───────────────────────────────────────────────────────────

describe('buildToolsArray', () => {
  function makeResolved(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
    return {
      profile: 'plain',
      builtIns: [],
      thinkingLevel: 'medium',
      autoPromoted: false,
      overrides: {},
      ...overrides,
    };
  }

  it('returns empty array for plain profile with no overrides', () => {
    assert.deepStrictEqual(buildToolsArray(makeResolved()), []);
  });

  it('emits googleSearch tool', () => {
    const tools = buildToolsArray(makeResolved({ builtIns: ['googleSearch'] }));
    assert.deepStrictEqual(tools, [{ googleSearch: {} }]);
  });

  it('emits urlContext tool', () => {
    const tools = buildToolsArray(makeResolved({ builtIns: ['urlContext'] }));
    assert.deepStrictEqual(tools, [{ urlContext: {} }]);
  });

  it('emits codeExecution tool', () => {
    const tools = buildToolsArray(makeResolved({ builtIns: ['codeExecution'] }));
    assert.deepStrictEqual(tools, [{ codeExecution: {} }]);
  });

  it('emits fileSearch tool with store names', () => {
    const tools = buildToolsArray(
      makeResolved({
        builtIns: ['fileSearch'],
        overrides: { fileSearchStores: ['stores/docs', 'stores/code'] },
      }),
    );
    assert.deepStrictEqual(tools, [
      { fileSearch: { fileSearchStoreNames: ['stores/docs', 'stores/code'] } },
    ]);
  });

  it('emits function declarations from overrides', () => {
    const tools = buildToolsArray(
      makeResolved({
        overrides: {
          functions: [
            {
              name: 'lookup',
              description: 'Looks up data',
              parametersJsonSchema: { type: 'object' },
            },
          ],
        },
      }),
    );
    assert.deepStrictEqual(tools, [
      {
        functionDeclarations: [
          { name: 'lookup', description: 'Looks up data', parameters: { type: 'object' } },
        ],
      },
    ]);
  });

  it('emits function declarations without parameters when none specified', () => {
    const tools = buildToolsArray(
      makeResolved({
        overrides: { functions: [{ name: 'fn', description: 'does stuff' }] },
      }),
    );
    assert.deepStrictEqual(tools, [
      { functionDeclarations: [{ name: 'fn', description: 'does stuff' }] },
    ]);
  });

  it('emits multiple built-ins in definition order', () => {
    const tools = buildToolsArray(makeResolved({ builtIns: ['googleSearch', 'urlContext'] }));
    assert.deepStrictEqual(tools, [{ googleSearch: {} }, { urlContext: {} }]);
  });
});

// ── buildProfileToolConfig ────────────────────────────────────────────────────

describe('buildProfileToolConfig', () => {
  function makeResolved(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
    return {
      profile: 'plain',
      builtIns: [],
      thinkingLevel: 'medium',
      autoPromoted: false,
      overrides: {},
      ...overrides,
    };
  }

  it('returns undefined for plain profile with no functions', () => {
    assert.strictEqual(buildProfileToolConfig(makeResolved()), undefined);
  });

  it('sets includeServerSideToolInvocations when built-ins are active', () => {
    const config = buildProfileToolConfig(makeResolved({ builtIns: ['googleSearch'] }));
    assert.deepStrictEqual(config, { includeServerSideToolInvocations: true });
  });

  it('sets VALIDATED functionCallingMode for functions + built-ins', () => {
    const config = buildProfileToolConfig(
      makeResolved({
        builtIns: ['googleSearch'],
        overrides: { functions: [{ name: 'fn', description: 'test' }] },
      }),
    );
    assert.ok(config?.includeServerSideToolInvocations === true);
    assert.ok(config?.functionCallingConfig !== undefined);
  });

  it('does not set includeServerSideToolInvocations for functions-only profile', () => {
    const config = buildProfileToolConfig(
      makeResolved({
        builtIns: [],
        overrides: { functions: [{ name: 'fn', description: 'test' }] },
      }),
    );
    // No built-ins → no server-side invocations by default
    assert.strictEqual(config?.includeServerSideToolInvocations, undefined);
  });
});

// ── resolveProfileFunctionCallingMode ─────────────────────────────────────────

describe('resolveProfileFunctionCallingMode', () => {
  function makeResolved(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
    return {
      profile: 'plain',
      builtIns: [],
      thinkingLevel: 'medium',
      autoPromoted: false,
      overrides: {},
      ...overrides,
    };
  }

  it('returns undefined when no functions and no explicit mode', () => {
    assert.strictEqual(resolveProfileFunctionCallingMode(makeResolved()), undefined);
  });

  it('defaults to VALIDATED for functions + built-ins', () => {
    const mode = resolveProfileFunctionCallingMode(
      makeResolved({
        builtIns: ['googleSearch'],
        overrides: { functions: [{ name: 'fn', description: 'test' }] },
      }),
    );
    assert.strictEqual(mode, FunctionCallingConfigMode.VALIDATED);
  });

  it('uses explicit functionCallingMode when provided', () => {
    const mode = resolveProfileFunctionCallingMode(
      makeResolved({
        overrides: { functionCallingMode: 'ANY' },
      }),
    );
    assert.strictEqual(mode, FunctionCallingConfigMode.ANY);
  });
});
