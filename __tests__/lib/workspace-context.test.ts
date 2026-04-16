import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DEFAULT_SYSTEM_INSTRUCTION } from '../../src/client.js';
import {
  assembleWorkspaceContext,
  estimateTokens,
  MIN_CACHE_TOKENS,
} from '../../src/lib/workspace-context.js';

describe('workspace-context', () => {
  describe('estimateTokens', () => {
    it('returns zero for empty string', () => {
      assert.strictEqual(estimateTokens(''), 0);
    });

    it('estimates tokens from character count', () => {
      const text = 'a'.repeat(400);
      assert.strictEqual(estimateTokens(text), 100);
    });

    it('rounds up for non-divisible lengths', () => {
      const text = 'a'.repeat(5);
      assert.strictEqual(estimateTokens(text), 2);
    });
  });

  describe('MIN_CACHE_TOKENS', () => {
    it('is 32000', () => {
      assert.strictEqual(MIN_CACHE_TOKENS, 32_000);
    });
  });

  describe('DEFAULT_SYSTEM_INSTRUCTION', () => {
    it('is exported and non-empty', () => {
      assert.ok(DEFAULT_SYSTEM_INSTRUCTION.length > 0);
      assert.ok(DEFAULT_SYSTEM_INSTRUCTION.includes('concise'));
    });
  });

  describe('assembleWorkspaceContext', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('returns context with header even for empty roots', async () => {
      process.env.WORKSPACE_AUTO_SCAN = 'false';
      delete process.env.WORKSPACE_CONTEXT_FILE;
      const result = await assembleWorkspaceContext([]);
      assert.ok(result.content.includes('# Workspace Context'));
      assert.strictEqual(result.fileCount, 0);
      assert.ok(result.estimatedTokens > 0);
      assert.deepStrictEqual(result.sources, []);
    });

    it('scans workspace root for known files', async () => {
      process.env.WORKSPACE_AUTO_SCAN = 'true';
      delete process.env.WORKSPACE_CONTEXT_FILE;
      const result = await assembleWorkspaceContext([process.cwd()]);
      assert.ok(result.fileCount > 0);
      assert.ok(result.sources.length > 0);
      assert.ok(result.content.includes('## Workspace Files'));
    });

    it('respects WORKSPACE_AUTO_SCAN=false', async () => {
      process.env.WORKSPACE_AUTO_SCAN = 'false';
      delete process.env.WORKSPACE_CONTEXT_FILE;
      const result = await assembleWorkspaceContext([process.cwd()]);
      assert.strictEqual(result.fileCount, 0);
      assert.ok(!result.content.includes('## Workspace Files'));
    });

    it('skips non-existent roots gracefully', async () => {
      process.env.WORKSPACE_AUTO_SCAN = 'true';
      delete process.env.WORKSPACE_CONTEXT_FILE;
      const result = await assembleWorkspaceContext(['/non/existent/path/xyz']);
      assert.strictEqual(result.fileCount, 0);
    });

    it('includes custom context file when configured', async () => {
      process.env.WORKSPACE_CONTEXT_FILE = 'package.json';
      process.env.WORKSPACE_AUTO_SCAN = 'false';
      const result = await assembleWorkspaceContext([]);
      assert.ok(result.content.includes('## Project Context'));
      assert.strictEqual(result.fileCount, 1);
      assert.ok(result.sources.includes('package.json'));
    });

    it('scans each root independently', async () => {
      process.env.WORKSPACE_AUTO_SCAN = 'true';
      delete process.env.WORKSPACE_CONTEXT_FILE;
      const cwd = process.cwd();
      const single = await assembleWorkspaceContext([cwd]);
      const doubled = await assembleWorkspaceContext([cwd, cwd]);
      assert.strictEqual(doubled.sources.length, single.sources.length * 2);
    });
  });
});
