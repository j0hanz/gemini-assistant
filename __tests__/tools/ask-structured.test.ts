import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAskStructuredContent, formatStructuredResult } from '../../src/tools/chat.js';

function makeBaseResult(text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

describe('ask structured output shaping', () => {
  it('parses valid JSON output into answer and data', () => {
    const result = formatStructuredResult(
      makeBaseResult('{"status":"ok","count":2}'),
      {
        functionCalls: [],
        thoughtText: '',
        toolEvents: [],
        usageMetadata: { totalTokenCount: 42 },
      },
      true,
    );

    assert.deepStrictEqual(result.structuredContent, {
      answer: '',
      data: { status: 'ok', count: 2 },
      diagnostics: { usage: { totalTokenCount: 42 } },
    });
    assert.strictEqual(result.content[0]?.type, 'text');
    assert.strictEqual(result.content[0]?.text, '');
  });

  it('parses fenced JSON output', () => {
    const structured = buildAskStructuredContent(
      '```json\n{"status":"ok","count":2}\n```',
      {
        functionCalls: [],
        thoughtText: '',
        toolEvents: [],
        usageMetadata: undefined,
      },
      true,
    );

    assert.deepStrictEqual(structured, {
      answer: '',
      data: { status: 'ok', count: 2 },
    });
  });

  it('records a warning when JSON parsing fails', () => {
    const structured = buildAskStructuredContent(
      '{not json}',
      {
        functionCalls: [],
        thoughtText: '',
        toolEvents: [],
        usageMetadata: undefined,
      },
      true,
    );

    assert.deepStrictEqual(structured, {
      answer: '{not json}',
      schemaWarnings: ['Failed to parse JSON from model response'],
    });
  });

  it('records schema mismatch warnings for parsed JSON', () => {
    const structured = buildAskStructuredContent(
      '{"status":"ok"}',
      {
        functionCalls: [],
        thoughtText: '',
        toolEvents: [],
        usageMetadata: undefined,
      },
      true,
      {
        type: 'object',
        properties: {
          status: { type: 'integer' },
        },
      },
    );

    assert.deepStrictEqual(structured.data, { status: 'ok' });
    assert.ok(structured.schemaWarnings);
    assert.match(structured.schemaWarnings?.[0] ?? '', /does not match schema/i);
  });

  it('surfaces code execution computations from tool events', () => {
    const structured = buildAskStructuredContent('Answer', {
      functionCalls: [],
      thoughtText: '',
      toolEvents: [
        { kind: 'executable_code', id: 'exec-1', code: 'print(2)', language: 'PYTHON' },
        {
          kind: 'code_execution_result',
          id: 'exec-1',
          outcome: 'OUTCOME_OK',
          output: '2',
        },
      ],
      usageMetadata: undefined,
    });

    assert.deepStrictEqual(structured.computations, [
      {
        id: 'exec-1',
        code: 'print(2)',
        language: 'PYTHON',
        outcome: 'OUTCOME_OK',
        output: '2',
      },
    ]);
  });
});
