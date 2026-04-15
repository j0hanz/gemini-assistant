import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AgenticSearchInputSchema,
  AnalyzeFileInputSchema,
  AnalyzePrInputSchema,
  AnalyzeUrlInputSchema,
  CompareFilesInputSchema,
  CreateCacheInputSchema,
  ExecuteCodeInputSchema,
  ExplainErrorInputSchema,
  GenerateDiagramInputSchema,
  SearchInputSchema,
} from '../../src/schemas/inputs.js';

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

  it('accepts with urls', () => {
    const result = SearchInputSchema.safeParse({
      query: 'compare recipes',
      urls: ['https://example.com/recipe1', 'https://example.com/recipe2'],
    });
    assert.ok(result.success);
  });

  it('accepts without urls (backward compatible)', () => {
    const result = SearchInputSchema.safeParse({ query: 'latest news' });
    assert.ok(result.success);
  });

  it('accepts any string as url (validated at handler level)', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      urls: ['not-a-url'],
    });
    assert.strictEqual(result.success, true);
  });

  it('rejects more than 20 urls', () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    const result = SearchInputSchema.safeParse({ query: 'test', urls });
    assert.strictEqual(result.success, false);
  });
});

describe('AgenticSearchInputSchema', () => {
  it('accepts valid input with topic only', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'AI market trends' });
    assert.ok(result.success);
  });

  it('accepts with searchDepth', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test', searchDepth: 5 });
    assert.ok(result.success);
  });

  it('defaults searchDepth to 3', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test' });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.searchDepth, 3);
    }
  });

  it('rejects searchDepth > 5', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test', searchDepth: 6 });
    assert.strictEqual(result.success, false);
  });

  it('rejects searchDepth < 1', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test', searchDepth: 0 });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing topic', () => {
    const result = AgenticSearchInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects empty topic', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: '' });
    assert.strictEqual(result.success, false);
  });

  it('accepts with thinkingLevel', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test', thinkingLevel: 'HIGH' });
    assert.ok(result.success);
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

describe('AnalyzePrInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = AnalyzePrInputSchema.safeParse({});
    assert.ok(result.success);
  });

  it('accepts supported fields', () => {
    const result = AnalyzePrInputSchema.safeParse({
      dryRun: true,
      cacheName: 'cachedContents/abc123',
      thinkingLevel: 'HIGH',
      language: 'TypeScript',
    });
    assert.ok(result.success);
  });

  it('rejects removed mode field', () => {
    const result = AnalyzePrInputSchema.safeParse({ mode: 'unstaged' });
    assert.strictEqual(result.success, false);
  });

  it('rejects removed base field', () => {
    const result = AnalyzePrInputSchema.safeParse({ base: 'origin/main' });
    assert.strictEqual(result.success, false);
  });

  it('rejects removed paths field', () => {
    const result = AnalyzePrInputSchema.safeParse({ paths: ['src/'] });
    assert.strictEqual(result.success, false);
  });
});

describe('AnalyzeUrlInputSchema', () => {
  it('accepts valid input', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['https://example.com'],
      question: 'Summarize this page',
    });
    assert.ok(result.success);
  });

  it('accepts multiple urls', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['https://example.com/a', 'https://example.com/b'],
      question: 'Compare these',
    });
    assert.ok(result.success);
  });

  it('accepts with systemInstruction', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['https://example.com'],
      question: 'Summarize',
      systemInstruction: 'Be concise',
    });
    assert.ok(result.success);
  });

  it('rejects empty urls array', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: [],
      question: 'test',
    });
    assert.strictEqual(result.success, false);
  });

  it('accepts any string as url (validated at handler level)', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['not-a-url'],
      question: 'test',
    });
    assert.strictEqual(result.success, true);
  });

  it('rejects more than 20 urls', () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    const result = AnalyzeUrlInputSchema.safeParse({ urls, question: 'test' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing question', () => {
    const result = AnalyzeUrlInputSchema.safeParse({ urls: ['https://example.com'] });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty question', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['https://example.com'],
      question: '',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing urls', () => {
    const result = AnalyzeUrlInputSchema.safeParse({ question: 'test' });
    assert.strictEqual(result.success, false);
  });
});

describe('ExplainErrorInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = ExplainErrorInputSchema.safeParse({ error: 'TypeError: x is not a function' });
    assert.ok(result.success);
  });

  it('accepts with codeContext and language', () => {
    const result = ExplainErrorInputSchema.safeParse({
      error: 'NullPointerException',
      codeContext: 'const x = null; x.foo();',
      language: 'typescript',
    });
    assert.ok(result.success);
  });

  it('accepts with googleSearch enabled', () => {
    const result = ExplainErrorInputSchema.safeParse({
      error: 'ECONNREFUSED',
      googleSearch: true,
    });
    assert.ok(result.success);
  });

  it('accepts with urls', () => {
    const result = ExplainErrorInputSchema.safeParse({
      error: 'Module not found',
      urls: ['https://github.com/issue/123'],
    });
    assert.ok(result.success);
  });

  it('accepts with cacheName', () => {
    const result = ExplainErrorInputSchema.safeParse({
      error: 'Build failed',
      cacheName: 'cachedContents/abc123',
    });
    assert.ok(result.success);
  });

  it('rejects more than 20 urls', () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    const result = ExplainErrorInputSchema.safeParse({ error: 'test', urls });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty error', () => {
    const result = ExplainErrorInputSchema.safeParse({ error: '' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing error', () => {
    const result = ExplainErrorInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });
});

describe('CompareFilesInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: '/path/to/a.ts',
      filePathB: '/path/to/b.ts',
    });
    assert.ok(result.success);
  });

  it('accepts with question', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: '/a.ts',
      filePathB: '/b.ts',
      question: 'security differences',
    });
    assert.ok(result.success);
  });

  it('accepts with googleSearch', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: '/a.ts',
      filePathB: '/b.ts',
      googleSearch: true,
    });
    assert.ok(result.success);
  });

  it('accepts with cacheName', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: '/a.ts',
      filePathB: '/b.ts',
      cacheName: 'cachedContents/abc',
    });
    assert.ok(result.success);
  });

  it('rejects missing filePathA', () => {
    const result = CompareFilesInputSchema.safeParse({ filePathB: '/b.ts' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing filePathB', () => {
    const result = CompareFilesInputSchema.safeParse({ filePathA: '/a.ts' });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty filePathA', () => {
    const result = CompareFilesInputSchema.safeParse({ filePathA: '', filePathB: '/b.ts' });
    assert.strictEqual(result.success, false);
  });
});

describe('GenerateDiagramInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = GenerateDiagramInputSchema.safeParse({ description: 'auth flow' });
    assert.ok(result.success);
  });

  it('defaults diagramType to mermaid', () => {
    const result = GenerateDiagramInputSchema.safeParse({ description: 'test' });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.diagramType, 'mermaid');
    }
  });

  it('accepts with sourceFilePath', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'class diagram',
      sourceFilePath: '/src/index.ts',
    });
    assert.ok(result.success);
  });

  it('accepts with sourceFilePaths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'architecture',
      sourceFilePaths: ['/src/a.ts', '/src/b.ts'],
    });
    assert.ok(result.success);
  });

  it('rejects both sourceFilePath and sourceFilePaths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      sourceFilePath: '/a.ts',
      sourceFilePaths: ['/b.ts'],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects more than 10 sourceFilePaths', () => {
    const paths = Array.from({ length: 11 }, (_, i) => `/file${i}.ts`);
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      sourceFilePaths: paths,
    });
    assert.strictEqual(result.success, false);
  });

  it('accepts with validateSyntax', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'sequence diagram',
      validateSyntax: true,
    });
    assert.ok(result.success);
  });

  it('accepts with googleSearch', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'ER diagram',
      googleSearch: true,
    });
    assert.ok(result.success);
  });

  it('accepts with cacheName', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      cacheName: 'cachedContents/xyz',
    });
    assert.ok(result.success);
  });

  it('rejects empty description', () => {
    const result = GenerateDiagramInputSchema.safeParse({ description: '' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing description', () => {
    const result = GenerateDiagramInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });
});
