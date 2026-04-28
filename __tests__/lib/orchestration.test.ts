import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUrlContextFallbackPart, resolveOrchestration } from '../../src/lib/orchestration.js';

function makeCtx(): { ctx: ServerContext; calls: { level: string; message: string }[] } {
  const calls: { level: string; message: string }[] = [];
  const ctx = {
    mcpReq: {
      log: async (level: string, message: string) => {
        calls.push({ level, message });
      },
      signal: new AbortController().signal,
    },
  } as unknown as ServerContext;
  return { ctx, calls };
}

describe('resolveOrchestration (profile-driven)', () => {
  it('chat with no tools resolves to plain profile with no tools array', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(undefined, ctx, { toolKey: 'chat' });
    assert.ok(!result.error, 'expected no error');
    const config = result.config;
    assert.strictEqual(config.resolvedProfile.profile, 'plain');
    assert.strictEqual(config.tools, undefined);
  });

  it('research.deep resolves to deep-research with googleSearch+urlContext+codeExecution', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(undefined, ctx, {
      toolKey: 'research',
      mode: 'deep',
    });
    assert.ok(!result.error);
    const config = result.config;
    assert.strictEqual(config.resolvedProfile.profile, 'deep-research');
    const toolKeys = (config.tools ?? []).flatMap((t) => Object.keys(t));
    assert.ok(toolKeys.includes('googleSearch'), 'missing googleSearch');
    assert.ok(toolKeys.includes('urlContext'), 'missing urlContext');
    assert.ok(toolKeys.includes('codeExecution'), 'missing codeExecution');
  });

  it('temperature is never set on the OrchestrationConfig', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(undefined, ctx, { toolKey: 'chat' });
    assert.ok(!result.error);
    assert.strictEqual((result.config as Record<string, unknown>)['temperature'], undefined);
  });

  it('emits an info log describing the resolved profile', async () => {
    const { ctx, calls } = makeCtx();
    await resolveOrchestration(undefined, ctx, { toolKey: 'research', mode: 'quick' });
    const info = calls.find((c) => c.level === 'info');
    assert.ok(info, 'expected info log');
  });

  it('chat auto-promotes plain to web-research when urls are supplied', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(
      { overrides: { urls: ['https://example.com'] } },
      ctx,
      { toolKey: 'chat' },
    );
    assert.ok(!result.error);
    assert.strictEqual(result.config.resolvedProfile.profile, 'web-research');
    assert.strictEqual(result.config.resolvedProfile.autoPromoted, true);
  });

  it('SSTI is enabled automatically when built-in tools are active', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration({ profile: 'grounded' }, ctx, { toolKey: 'chat' });
    assert.ok(!result.error);
    assert.deepStrictEqual(result.config.toolConfig, { includeServerSideToolInvocations: true });
  });

  it('returns error result for invalid URLs', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(
      { profile: 'web-research', overrides: { urls: ['not-a-url'] } },
      ctx,
      { toolKey: 'research' },
    );
    assert.ok(result.error, 'expected error for invalid URL');
  });

  it('returns error result for rag + urls (URLS_NOT_PERMITTED_BY_PROFILE)', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(
      {
        profile: 'rag',
        overrides: { urls: ['https://example.com'], fileSearchStores: ['stores/x'] },
      },
      ctx,
      { toolKey: 'chat' },
    );
    assert.ok(result.error, 'expected error for invalid combination');
  });

  it('returns error result for agent profile without functions', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration({ profile: 'agent' }, ctx, { toolKey: 'chat' });
    assert.ok(result.error, 'expected FUNCTIONS_REQUIRED_FOR_PROFILE error');
  });

  it('returns error result for visual-inspect with minimal thinkingLevel', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(
      { profile: 'visual-inspect', thinkingLevel: 'minimal' },
      ctx,
      { toolKey: 'analyze' },
    );
    assert.ok(result.error, 'expected THINKING_LEVEL_TOO_LOW error');
  });

  it('resolves rag profile with fileSearchStores correctly', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration(
      { profile: 'rag', overrides: { fileSearchStores: ['stores/docs'] } },
      ctx,
      { toolKey: 'chat' },
    );
    assert.ok(!result.error);
    assert.ok(result.config);
    assert.strictEqual(result.config.resolvedProfile?.profile, 'rag');
    const toolKeys = (result.config.tools ?? []).flatMap((t) => Object.keys(t));
    assert.ok(toolKeys.includes('fileSearch'));
  });

  it('activeCapabilities reflects the resolved built-ins', async () => {
    const { ctx } = makeCtx();
    const result = await resolveOrchestration({ profile: 'web-research' }, ctx, {
      toolKey: 'research',
    });
    assert.ok(!result.error);
    assert.ok(result.config);
    const caps = result.config.activeCapabilities;
    assert.ok(caps.has('googleSearch'));
    assert.ok(caps.has('urlContext'));
    assert.ok(!caps.has('codeExecution'));
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
