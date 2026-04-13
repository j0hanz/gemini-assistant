import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnalyzeFileInputSchema,
  AskInputSchema,
  CreateCacheInputSchema,
  ExecuteCodeInputSchema,
  SearchInputSchema,
} from '../../src/schemas/inputs.js';

describe('AskInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = AskInputSchema.safeParse({ message: 'Hello' });
    assert.ok(result.success);
  });

  it('accepts all optional fields', () => {
    const result = AskInputSchema.safeParse({
      message: 'Hello',
      sessionId: 'sess-1',
      systemInstruction: 'Be concise',
      cacheName: 'cachedContents/abc',
    });
    assert.ok(result.success);
  });

  it('rejects missing message', () => {
    const result = AskInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects non-string message', () => {
    const result = AskInputSchema.safeParse({ message: 123 });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty message', () => {
    const result = AskInputSchema.safeParse({ message: '' });
    assert.strictEqual(result.success, false);
  });

  it('rejects sessionId exceeding 256 chars', () => {
    const result = AskInputSchema.safeParse({
      message: 'hi',
      sessionId: 'x'.repeat(257),
    });
    assert.strictEqual(result.success, false);
  });
});

describe('ExecuteCodeInputSchema', () => {
  it('accepts valid input', () => {
    const result = ExecuteCodeInputSchema.safeParse({ task: 'sort an array' });
    assert.ok(result.success);
  });

  it('accepts with language hint', () => {
    const result = ExecuteCodeInputSchema.safeParse({
      task: 'fibonacci',
      language: 'python',
    });
    assert.ok(result.success);
  });

  it('rejects missing task', () => {
    const result = ExecuteCodeInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects empty task', () => {
    const result = ExecuteCodeInputSchema.safeParse({ task: '' });
    assert.strictEqual(result.success, false);
  });
});

describe('SearchInputSchema', () => {
  it('accepts valid input', () => {
    const result = SearchInputSchema.safeParse({ query: 'latest Node.js version' });
    assert.ok(result.success);
  });

  it('accepts with systemInstruction', () => {
    const result = SearchInputSchema.safeParse({
      query: 'weather',
      systemInstruction: 'Be brief',
    });
    assert.ok(result.success);
  });

  it('rejects missing query', () => {
    const result = SearchInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects empty query', () => {
    const result = SearchInputSchema.safeParse({ query: '' });
    assert.strictEqual(result.success, false);
  });
});

describe('AnalyzeFileInputSchema', () => {
  it('accepts valid input', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: '/path/to/file.pdf',
      question: 'Summarize this document',
    });
    assert.ok(result.success);
  });

  it('rejects empty filePath', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: '',
      question: 'What is this?',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty question', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: '/path/to/file.pdf',
      question: '',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing fields', () => {
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({}).success, false);
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({ filePath: '/a' }).success, false);
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({ question: 'q' }).success, false);
  });
});

describe('CreateCacheInputSchema', () => {
  it('accepts with filePaths', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: ['/path/to/big-file.pdf'],
    });
    assert.ok(result.success);
  });

  it('accepts with systemInstruction only', () => {
    const result = CreateCacheInputSchema.safeParse({
      systemInstruction: 'You are a helpful assistant with deep knowledge...',
    });
    assert.ok(result.success);
  });

  it('accepts with both filePaths and systemInstruction', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: ['/a.pdf'],
      systemInstruction: 'Analyze these.',
      ttl: '7200s',
    });
    assert.ok(result.success);
  });

  it('rejects when neither filePaths nor systemInstruction provided', () => {
    const result = CreateCacheInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects empty filePaths without systemInstruction', () => {
    const result = CreateCacheInputSchema.safeParse({ filePaths: [] });
    assert.strictEqual(result.success, false);
  });

  it('rejects filePaths exceeding 50 entries', () => {
    const paths = Array.from({ length: 51 }, (_, i) => `/file${i}.txt`);
    const result = CreateCacheInputSchema.safeParse({ filePaths: paths });
    assert.strictEqual(result.success, false);
  });
});
