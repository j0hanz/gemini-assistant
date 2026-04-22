import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FunctionCallingConfigMode } from '@google/genai';

import { buildMergedToolConfig } from '../../src/client.js';
import {
  buildOrchestrationConfig,
  buildToolProfile,
  BUILT_IN_TOOL_NAMES,
  type BuiltInToolName,
  resolveOrchestration,
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
  for (const subset of subsets(BUILT_IN_TOOL_NAMES)) {
    const label = subset.length > 0 ? subset.join('+') : 'none';
    it(`composes built-in tool subset [${label}]`, () => {
      const result = buildOrchestrationConfig({ builtInToolNames: subset });
      const tools = result.tools ?? [];
      assert.strictEqual(tools.length, subset.length);
      for (const name of BUILT_IN_TOOL_NAMES) {
        assert.strictEqual(
          result.activeCapabilities.has(name),
          subset.includes(name),
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
      includeServerSideToolInvocations: true,
    });
    assert.deepStrictEqual(result.toolConfig, { includeServerSideToolInvocations: true });
  });

  it('omits toolConfig when includeServerSideToolInvocations is not set', () => {
    const result = buildOrchestrationConfig({ builtInToolNames: ['googleSearch'] });
    assert.strictEqual(result.toolConfig, undefined);
  });

  it('composes additional tools alongside built-ins', () => {
    const result = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      additionalTools: [{ functionDeclarations: [{ name: 'x', parameters: {} }] }],
    });
    const tools = result.tools ?? [];
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(result.activeCapabilities.has('googleSearch'), true);
    assert.ok(tools.some((tool) => 'functionDeclarations' in tool));
  });

  it('threads functionCallingMode through the resolved config', () => {
    const result = buildOrchestrationConfig({
      builtInToolNames: ['googleSearch'],
      functionCallingMode: FunctionCallingConfigMode.ANY,
    });
    assert.strictEqual(result.functionCallingMode, FunctionCallingConfigMode.ANY);
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
      { builtInToolNames: ['googleSearch'], includeServerSideToolInvocations: true },
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
