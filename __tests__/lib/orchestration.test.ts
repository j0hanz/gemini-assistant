import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildOrchestrationConfig,
  normalizeToolProfile,
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

describe('orchestration', () => {
  it('normalizes backward-compatible googleSearch requests', () => {
    assert.strictEqual(normalizeToolProfile({ googleSearch: true }), 'search');
    assert.strictEqual(
      normalizeToolProfile({ googleSearch: true, urls: ['https://example.com'] }),
      'search_url',
    );
  });

  it('normalizes urls-only requests to the url profile', () => {
    assert.strictEqual(normalizeToolProfile({ urls: ['https://example.com'] }), 'url');
  });

  it('builds search-only orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'search' });

    assert.strictEqual(result.toolProfile, 'search');
    assert.deepStrictEqual(result.tools, [{ googleSearch: {} }]);
    assert.strictEqual(result.toolConfig, undefined);
  });

  it('builds url-only orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'url' });

    assert.strictEqual(result.toolProfile, 'url');
    assert.deepStrictEqual(result.tools, [{ urlContext: {} }]);
  });

  it('infers url orchestration from urls-only input', () => {
    const result = buildOrchestrationConfig({ urls: ['https://example.com'] });

    assert.strictEqual(result.toolProfile, 'url');
    assert.strictEqual(result.usesUrlContext, true);
    assert.deepStrictEqual(result.tools, [{ urlContext: {} }]);
  });

  it('builds search + url orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'search_url' });

    assert.strictEqual(result.toolProfile, 'search_url');
    assert.deepStrictEqual(result.tools, [{ googleSearch: {} }, { urlContext: {} }]);
  });

  it('builds code-only orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'code' });

    assert.strictEqual(result.toolProfile, 'code');
    assert.deepStrictEqual(result.tools, [{ codeExecution: {} }]);
  });

  it('builds search + code orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'search_code' });

    assert.strictEqual(result.toolProfile, 'search_code');
    assert.deepStrictEqual(result.tools, [{ googleSearch: {} }, { codeExecution: {} }]);
  });

  it('builds url + code orchestration for url_code profile', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'url_code' });

    assert.strictEqual(result.toolProfile, 'url_code');
    assert.strictEqual(result.usesUrlContext, true);
    assert.strictEqual(result.usesCodeExecution, true);
    assert.deepStrictEqual(result.tools, [{ urlContext: {} }, { codeExecution: {} }]);
  });

  it('exposes includeServerSideToolInvocations when requested', () => {
    const result = buildOrchestrationConfig({
      toolProfile: 'search',
      includeServerSideToolInvocations: true,
    });
    assert.deepStrictEqual(result.toolConfig, { includeServerSideToolInvocations: true });
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
      { toolProfile: 'search', includeServerSideToolInvocations: true },
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
      { toolProfile: 'search', urls: ['https://example.com'] },
      ctx,
      'chat',
    );
    assert.ok(resolved.config);
    assert.strictEqual(resolved.config.usesUrlContext, false);
    const warn = calls.find((c) => c.level === 'warning' || c.level === 'warn');
    assert.ok(warn, 'expected warn log when urls provided without URL Context');
  });
});
