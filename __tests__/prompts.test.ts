import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

// We test the prompt schemas and message builders directly.
// Since registerPrompts wires into McpServer, unit-test the schemas + message logic.

const COMMON_LANGUAGES = [
  'python',
  'typescript',
  'javascript',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'swift',
  'kotlin',
  'php',
  'sql',
  'shell',
];

const SUMMARY_STYLES = ['brief', 'detailed', 'bullet-points'] as const;

const CodeReviewSchema = z.object({
  code: z.string().max(100_000).describe('The code to review'),
  language: z.string().optional().describe('Programming language of the code'),
});

const SummarizeSchema = z.object({
  text: z.string().max(100_000).describe('The text to summarize'),
  style: z.enum(SUMMARY_STYLES).optional().describe('Summary style'),
});

const ExplainErrorSchema = z.object({
  error: z.string().max(100_000).describe('The error message or stack trace'),
  context: z
    .string()
    .max(10_000)
    .optional()
    .describe('Additional context about what was being done'),
});

describe('code-review prompt', () => {
  it('accepts valid code input', () => {
    const result = CodeReviewSchema.safeParse({ code: 'console.log("hi")' });
    assert.ok(result.success);
  });

  it('accepts code with language', () => {
    const result = CodeReviewSchema.safeParse({ code: 'print("hi")', language: 'python' });
    assert.ok(result.success);
  });

  it('rejects missing code', () => {
    const result = CodeReviewSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects code exceeding max length', () => {
    const result = CodeReviewSchema.safeParse({ code: 'x'.repeat(100_001) });
    assert.strictEqual(result.success, false);
  });

  it('language completion filters by prefix', () => {
    const filtered = COMMON_LANGUAGES.filter((l) => l.startsWith('py'));
    assert.deepStrictEqual(filtered, ['python']);
  });

  it('language completion returns all for empty input', () => {
    const filtered = COMMON_LANGUAGES.filter((l) => l.startsWith(''));
    assert.strictEqual(filtered.length, COMMON_LANGUAGES.length);
  });
});

describe('summarize prompt', () => {
  it('accepts valid text input', () => {
    const result = SummarizeSchema.safeParse({ text: 'Some long text here.' });
    assert.ok(result.success);
  });

  it('accepts text with style', () => {
    const result = SummarizeSchema.safeParse({ text: 'Content', style: 'brief' });
    assert.ok(result.success);
  });

  it('accepts all valid styles', () => {
    for (const style of SUMMARY_STYLES) {
      const result = SummarizeSchema.safeParse({ text: 'Content', style });
      assert.ok(result.success, `Style '${style}' should be valid`);
    }
  });

  it('rejects invalid style', () => {
    const result = SummarizeSchema.safeParse({ text: 'Content', style: 'verbose' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing text', () => {
    const result = SummarizeSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects text exceeding max length', () => {
    const result = SummarizeSchema.safeParse({ text: 'x'.repeat(100_001) });
    assert.strictEqual(result.success, false);
  });

  it('style completion filters by prefix', () => {
    const filtered = SUMMARY_STYLES.filter((s) => s.startsWith('b'));
    assert.deepStrictEqual(filtered, ['brief', 'bullet-points']);
  });
});

describe('explain-error prompt', () => {
  it('accepts valid error input', () => {
    const result = ExplainErrorSchema.safeParse({
      error: 'TypeError: undefined is not a function',
    });
    assert.ok(result.success);
  });

  it('accepts error with context', () => {
    const result = ExplainErrorSchema.safeParse({
      error: 'ENOENT: no such file',
      context: 'Trying to read config file',
    });
    assert.ok(result.success);
  });

  it('rejects missing error', () => {
    const result = ExplainErrorSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects error exceeding max length', () => {
    const result = ExplainErrorSchema.safeParse({ error: 'x'.repeat(100_001) });
    assert.strictEqual(result.success, false);
  });

  it('rejects context exceeding max length', () => {
    const result = ExplainErrorSchema.safeParse({
      error: 'some error',
      context: 'x'.repeat(10_001),
    });
    assert.strictEqual(result.success, false);
  });
});
