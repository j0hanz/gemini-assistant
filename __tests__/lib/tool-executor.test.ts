import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import type { StreamResult } from '../../src/lib/streaming.js';
import {
  finalizeStreamExecution,
  type StreamResponseBuilder,
} from '../../src/lib/tool-executor.js';

// Helper: minimal valid StreamResult
function makeStreamResult(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    warnings: [],
    reportMessage: undefined,
    ...overrides,
  };
}

// Helper: minimal valid CallToolResult
function makeToolResult(overrides: Partial<CallToolResult> = {}): CallToolResult {
  return {
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
    ...overrides,
  };
}

test('finalizeStreamExecution — returns result unchanged when isError', () => {
  const result = makeToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  const streamResult = makeStreamResult();
  const responseBuilder: StreamResponseBuilder<Record<string, unknown>> = () => ({});

  const out = finalizeStreamExecution(result, streamResult, responseBuilder);

  assert.strictEqual(out.result, result, 'must return same result object when isError');
});

test('finalizeStreamExecution — appends stream warnings to content', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult({
    warnings: ['w1', 'w2'],
  });
  const responseBuilder: StreamResponseBuilder<Record<string, unknown>> = () => ({});

  const out = finalizeStreamExecution(result, streamResult, responseBuilder);

  const texts = out.result.content
    ?.filter((c) => c.type === 'text')
    .map((c) => (c as { type: 'text'; text: string }).text)
    .join('');

  assert.ok(texts?.includes('w1') && texts?.includes('w2'), 'content must include both warnings');
});

test('finalizeStreamExecution — merges warnings from responseBuilder', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult();
  const responseBuilder: StreamResponseBuilder<Record<string, unknown>> = () => ({
    structuredContent: {
      warnings: ['builder-warn'],
    },
  });

  const out = finalizeStreamExecution(result, streamResult, responseBuilder);

  const structuredContent = out.result.structuredContent;
  const warnings =
    structuredContent && typeof structuredContent === 'object' && 'warnings' in structuredContent
      ? (structuredContent as { warnings?: unknown }).warnings
      : undefined;
  assert.ok(
    Array.isArray(warnings) && warnings.includes('builder-warn'),
    'must include builder warnings in structuredContent',
  );
});

test('finalizeStreamExecution — includes reportMessage from responseBuilder', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult();
  const responseBuilder: StreamResponseBuilder<Record<string, unknown>> = () => ({
    reportMessage: 'done!',
  });

  const out = finalizeStreamExecution(result, streamResult, responseBuilder);

  assert.strictEqual(out.reportMessage, 'done!', 'must include reportMessage');
});
