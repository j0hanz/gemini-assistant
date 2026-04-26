import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FunctionCallingConfigMode } from '@google/genai';

import { buildMergedToolConfig } from '../../src/client.js';
import { AppError } from '../../src/lib/errors.js';
import {
  buildOrchestrationConfig,
  buildOrchestrationRequestFromInputs,
  buildToolProfile,
  buildUrlContextFallbackPart,
  BUILT_IN_TOOL_NAMES,
  resolveOrchestration,
  resolveServerSideToolInvocations,
} from '../../src/lib/orchestration.js';

interface Call {
  level: string;
  message: string;
  data?: unknown;
}

function makeCtx(): { ctx: ServerContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    mcpReq: {
      log: async (level: string, message: string, data?: unknown) => {
        calls.push({ level, message, data });
      },
      signal: new AbortController().signal,
    },
  } as unknown as ServerContext;
  return { ctx, calls };
}

function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [[]];
  for (const item of items) {
    const len = out.length;
    for (let i = 0; i < len; i++) {
      out.push([...(out[i] ?? []), item]);
    }
  }
  return out;
}

describe('buildOrchestrationConfig', () => {
  const legacyBuiltInNames = BUILT_IN_TOOL_NAMES.filter((name) => name !== 'fileSearch');
  for (const subset of subsets(legacyBuiltInNames)) {
    const label = subset.length > 0 ? subset.join('+') : 'none';
    it(`composes built-in tool subset [${label}]`, () => {
      const result = buildOrchestrationConfig({ builtInToolNames: subset });
      const tools = result.tools ?? [];
      assert.strictEqual(tools.length, subset.length);
      for (const name of BUILT_IN_TOOL_NAMES) {
        assert.strictEqual(
          result.activeCapabilities.has(name),
          subset.includes(name as (typeof legacyBuiltInNames)[number]),
          `${name} capability`,
        );
      }
      assert.strictEqual(
        result.toolProfile,
        subset.length === 0 ? 'none' : [...subset].sort().join('+'),
      );
    });
  }

  it('exposes includeServerSideToolInvocations when requested', () => {
    const result = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      serverSideToolInvocations: 'always',
    });
    assert.deepStrictEqual(result.toolConfig, { includeServerSideToolInvocations: true });
  });

  it('auto-enables server-side tool invocations only for mixed built-in and function flows', () => {
    const result = buildOrchestrationConfig({ builtInToolNames: ['googleSearch'] });
    assert.strictEqual(result.toolConfig, undefined);

    const mixed = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      functionDeclarations: [{ name: 'lookup', parameters: {} }],
    });
    assert.deepStrictEqual(mixed.toolConfig, { includeServerSideToolInvocations: true });

    const empty = buildOrchestrationConfig({});
    assert.strictEqual(empty.toolConfig, undefined);
  });

  it('omits server-side tool invocations when policy is never', () => {
    const result = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      serverSideToolInvocations: 'never',
    });
    assert.strictEqual(result.toolConfig, undefined);
  });

  it('threads functionCallingMode through the resolved config', () => {
    const result = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      functionCallingMode: FunctionCallingConfigMode.ANY,
    });
    assert.strictEqual(result.functionCallingMode, FunctionCallingConfigMode.ANY);
  });

  it('builds fileSearch from typed built-in specs', () => {
    const result = buildOrchestrationConfig({
      builtInToolSpecs: [{ kind: 'fileSearch', fileSearchStoreNames: ['fileSearchStores/docs'] }],
    });
    assert.deepStrictEqual(result.tools, [
      { fileSearch: { fileSearchStoreNames: ['fileSearchStores/docs'] } },
    ]);
    assert.strictEqual(result.activeCapabilities.has('fileSearch'), true);
  });

  it('appends typed function declarations and function calling mode', () => {
    const declarations = [
      {
        name: 'lookup',
        description: 'Lookup a thing',
        parameters: { type: 'object' },
      },
    ];
    const result = buildOrchestrationConfig({
      functionDeclarations: declarations,
      functionCallingMode: FunctionCallingConfigMode.ANY,
    });
    assert.deepStrictEqual(result.tools, [{ functionDeclarations: declarations }]);
    assert.strictEqual(result.activeCapabilities.has('functions'), true);
    assert.strictEqual(result.functionCallingMode, FunctionCallingConfigMode.ANY);
    assert.strictEqual(result.toolConfig, undefined);
  });

  it('rejects legacy builtInToolNames fileSearch without a spec', () => {
    assert.throws(
      () => buildOrchestrationConfig({ builtInToolNames: ['fileSearch'] }),
      (error) => error instanceof AppError && error.message.includes('fileSearch requires'),
    );
  });

  it('returns toolProfile "none" for no built-in and no additional tools', () => {
    const result = buildOrchestrationConfig({});
    assert.strictEqual(result.toolProfile, 'none');
    assert.strictEqual(result.tools, undefined);
  });
});

describe('buildToolProfile', () => {
  it('returns "none" for empty/undefined', () => {
    assert.strictEqual(buildToolProfile(undefined), 'none');
    assert.strictEqual(buildToolProfile([]), 'none');
  });

  it('joins sorted tool keys', () => {
    assert.strictEqual(
      buildToolProfile([{ urlContext: {} }, { googleSearch: {} }]),
      'googleSearch+urlContext',
    );
  });
});

describe('buildMergedToolConfig', () => {
  it('merges functionCallingConfig.mode without overwriting server-side trace flag', () => {
    const merged = buildMergedToolConfig(
      { includeServerSideToolInvocations: true },
      FunctionCallingConfigMode.ANY,
    );
    assert.deepStrictEqual(merged, {
      includeServerSideToolInvocations: true,
      functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
    });
  });

  it('returns the original toolConfig when no functionCallingMode is provided', () => {
    const base = { includeServerSideToolInvocations: true };
    assert.strictEqual(buildMergedToolConfig(base, undefined), base);
  });

  it('creates a toolConfig when only functionCallingMode is provided', () => {
    assert.deepStrictEqual(buildMergedToolConfig(undefined, FunctionCallingConfigMode.AUTO), {
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
    });
  });
});

describe('resolveServerSideToolInvocations', () => {
  it('resolves the policy truth table', () => {
    assert.strictEqual(resolveServerSideToolInvocations('auto', new Set()), undefined);
    assert.strictEqual(resolveServerSideToolInvocations(undefined, new Set()), undefined);
    assert.strictEqual(
      resolveServerSideToolInvocations('auto', new Set(['googleSearch'])),
      undefined,
    );
    assert.strictEqual(
      resolveServerSideToolInvocations('auto', new Set(['googleSearch', 'functions'])),
      true,
    );
    assert.strictEqual(resolveServerSideToolInvocations('always', new Set()), true);
    assert.strictEqual(
      resolveServerSideToolInvocations('never', new Set(['googleSearch'])),
      undefined,
    );
  });
});

describe('resolveOrchestration', () => {
  it('returns an error result for invalid URLs', async () => {
    const { ctx } = makeCtx();
    const resolved = await resolveOrchestration({ urls: ['not a url'] }, ctx, 'test');
    assert.ok(resolved.error, 'expected error');
    assert.strictEqual(resolved.config, undefined);
  });

  it('emits an info log with resolved capabilities', async () => {
    const { ctx, calls } = makeCtx();
    const resolved = await resolveOrchestration(
      { builtInToolNames: ['googleSearch'], serverSideToolInvocations: 'always' },
      ctx,
      'research',
    );
    assert.ok(resolved.config);
    const info = calls.find((c) => c.level === 'info');
    assert.ok(info, 'expected info log');
  });

  it('warns when urls are provided but URL Context is inactive', async () => {
    const { ctx, calls } = makeCtx();
    const resolved = await resolveOrchestration(
      { builtInToolNames: ['googleSearch'], urls: ['https://example.com'] },
      ctx,
      'chat',
    );
    assert.ok(resolved.config);
    assert.strictEqual(resolved.config.activeCapabilities.has('urlContext'), false);
    const warn = calls.find((c) => c.level === 'warning' || c.level === 'warn');
    assert.ok(warn, 'expected warn log when urls provided without URL Context');
  });
});

describe('buildOrchestrationRequestFromInputs', () => {
  it('produces googleSearch+urlContext spec order matching legacy chat assembly', () => {
    const req = buildOrchestrationRequestFromInputs({
      googleSearch: true,
      urls: ['https://example.com'],
    });
    assert.deepStrictEqual(req.builtInToolSpecs, [
      { kind: 'googleSearch' },
      { kind: 'urlContext' },
    ]);
    assert.deepStrictEqual(req.urls, ['https://example.com']);
  });

  it('orders specs as googleSearch, urlContext, codeExecution, fileSearch', () => {
    const req = buildOrchestrationRequestFromInputs({
      googleSearch: true,
      urls: ['https://example.com'],
      codeExecution: true,
      fileSearch: { fileSearchStoreNames: ['stores/x'] },
    });
    assert.deepStrictEqual(req.builtInToolSpecs, [
      { kind: 'googleSearch' },
      { kind: 'urlContext' },
      { kind: 'codeExecution' },
      { kind: 'fileSearch', fileSearchStoreNames: ['stores/x'] },
    ]);
  });

  it('forwards function declarations, mode, and ssti policy', () => {
    const req = buildOrchestrationRequestFromInputs({
      functionDeclarations: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      functionCallingMode: FunctionCallingConfigMode.VALIDATED,
      serverSideToolInvocations: 'always',
    });
    assert.strictEqual(req.functionDeclarations?.length, 3);
    assert.strictEqual(req.functionCallingMode, FunctionCallingConfigMode.VALIDATED);
    assert.strictEqual(req.serverSideToolInvocations, 'always');
  });

  it('appends extraBuiltInToolSpecs after derived specs', () => {
    const req = buildOrchestrationRequestFromInputs({
      googleSearch: true,
      extraBuiltInToolSpecs: [{ kind: 'codeExecution' }],
    });
    assert.deepStrictEqual(req.builtInToolSpecs, [
      { kind: 'googleSearch' },
      { kind: 'codeExecution' },
    ]);
  });
});

describe('buildUrlContextFallbackPart', () => {
  it('returns undefined when urls is empty or undefined', () => {
    assert.strictEqual(buildUrlContextFallbackPart(undefined, new Set()), undefined);
    assert.strictEqual(buildUrlContextFallbackPart([], new Set()), undefined);
  });

  it('returns undefined when urlContext is active', () => {
    assert.strictEqual(
      buildUrlContextFallbackPart(['https://example.com'], new Set(['urlContext'])),
      undefined,
    );
  });

  it('returns a Context URLs part when urls present and urlContext inactive', () => {
    assert.deepStrictEqual(buildUrlContextFallbackPart(['https://a', 'https://b'], new Set()), {
      text: 'Context URLs:\nhttps://a\nhttps://b',
    });
  });
});

describe('OrchestrationConfig.toolProfileDetails', () => {
  it('reports fileSearchStoreCount for fileSearch specs', () => {
    const config = buildOrchestrationConfig({
      builtInToolSpecs: [{ kind: 'fileSearch', fileSearchStoreNames: ['stores/a', 'stores/b'] }],
    });
    assert.strictEqual(config.toolProfileDetails.fileSearchStoreCount, 2);
  });

  it('reports functionCount and functionCallingMode', () => {
    const config = buildOrchestrationConfig({
      functionDeclarations: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      functionCallingMode: FunctionCallingConfigMode.VALIDATED,
    });
    assert.strictEqual(config.toolProfileDetails.functionCount, 3);
    assert.strictEqual(
      config.toolProfileDetails.functionCallingMode,
      FunctionCallingConfigMode.VALIDATED,
    );
  });

  it('reports serverSideToolInvocations true when built-in + functions present', () => {
    const config = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      functionDeclarations: [{ name: 'a' }],
      serverSideToolInvocations: 'auto',
    });
    assert.strictEqual(config.toolProfileDetails.serverSideToolInvocations, true);
  });
});
