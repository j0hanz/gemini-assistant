import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AgenticSearchInputSchema,
  AnalyzeFileInputSchema,
  AnalyzePrInputSchema,
  AnalyzeUrlInputSchema,
  AskInputSchema,
  CompareFilesInputSchema,
  CreateCacheInputSchema,
  DeleteCacheInputSchema,
  ExecuteCodeInputSchema,
  ExplainErrorInputSchema,
  GenerateDiagramInputSchema,
  SearchInputSchema,
  UpdateCacheInputSchema,
} from '../../src/schemas/inputs.js';

const absolutePath = (...segments: string[]) => join(process.cwd(), ...segments);

describe('AskInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = AskInputSchema.safeParse({ message: 'hello' });
    assert.ok(result.success);
  });

  it('accepts the full structured-output surface', () => {
    const result = AskInputSchema.safeParse({
      message: 'return JSON',
      sessionId: 'sess-1',
      systemInstruction: 'Be concise',
      thinkingLevel: 'LOW',
      cacheName: 'cachedContents/abc123',
      responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      temperature: 0.2,
      seed: 42,
      googleSearch: true,
      toolProfile: 'search_url',
      urls: ['https://example.com/docs'],
    });
    assert.ok(result.success);
  });

  it('rejects responseSchema objects without a JSON Schema keyword', () => {
    const result = AskInputSchema.safeParse({
      message: 'test',
      responseSchema: { foo: 'bar' },
    });
    assert.strictEqual(result.success, false);
  });

  it('requires urls for url-capable tool profiles', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
      toolProfile: 'url',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = AskInputSchema.safeParse({ message: 'hello', extra: true });
    assert.strictEqual(result.success, false);
  });

  it('rejects responseSchema required keys missing from properties', () => {
    const result = AskInputSchema.safeParse({
      message: 'return JSON',
      responseSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['missing'],
      },
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects responseSchema with inverted numeric bounds', () => {
    const result = AskInputSchema.safeParse({
      message: 'return JSON',
      responseSchema: { type: 'number', minimum: 10, maximum: 1 },
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

  it('rejects unknown fields', () => {
    const result = ExecuteCodeInputSchema.safeParse({ task: 'sort an array', extra: true });
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

  it('rejects invalid urls', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      urls: ['not-a-url'],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects private urls', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      urls: ['http://localhost:3000'],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects more than 20 urls', () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    const result = SearchInputSchema.safeParse({ query: 'test', urls });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = SearchInputSchema.safeParse({ query: 'weather', extra: true });
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

  it('rejects unknown fields', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test', extra: true });
    assert.strictEqual(result.success, false);
  });
});

describe('AnalyzeFileInputSchema', () => {
  it('accepts valid input', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: absolutePath('fixtures', 'file.pdf'),
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
      filePath: absolutePath('fixtures', 'file.pdf'),
      question: '',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects relative filePath', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: 'relative/file.pdf',
      question: 'Summarize this document',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing fields', () => {
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({}).success, false);
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({ filePath: '/a' }).success, false);
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({ question: 'q' }).success, false);
  });

  it('rejects unknown fields', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: absolutePath('fixtures', 'file.pdf'),
      question: 'Summarize this document',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });
});

describe('CreateCacheInputSchema', () => {
  it('accepts with filePaths', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: [absolutePath('fixtures', 'big-file.pdf')],
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
      filePaths: [absolutePath('fixtures', 'a.pdf')],
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
    const paths = Array.from({ length: 51 }, (_, i) => absolutePath(`file${i}.txt`));
    const result = CreateCacheInputSchema.safeParse({ filePaths: paths });
    assert.strictEqual(result.success, false);
  });

  it('rejects relative filePaths', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: ['relative/file.txt'],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects malformed ttl values', () => {
    const result = CreateCacheInputSchema.safeParse({
      systemInstruction: 'Cache this',
      ttl: '2 hours',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = CreateCacheInputSchema.safeParse({
      systemInstruction: 'Cache this',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });
});

describe('DeleteCacheInputSchema', () => {
  it('accepts cache deletion input', () => {
    const result = DeleteCacheInputSchema.safeParse({ cacheName: 'cachedContents/abc123' });
    assert.ok(result.success);
  });

  it('accepts explicit confirmation override', () => {
    const result = DeleteCacheInputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      confirm: true,
    });
    assert.ok(result.success);
  });

  it('rejects unknown fields', () => {
    const result = DeleteCacheInputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });
});

describe('UpdateCacheInputSchema', () => {
  it('accepts cache ttl updates', () => {
    const result = UpdateCacheInputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      ttl: '7200s',
    });
    assert.ok(result.success);
  });

  it('rejects empty ttl', () => {
    const result = UpdateCacheInputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      ttl: '',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects malformed ttl', () => {
    const result = UpdateCacheInputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      ttl: 'ten minutes',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = UpdateCacheInputSchema.safeParse({
      cacheName: 'cachedContents/abc123',
      ttl: '7200s',
      extra: true,
    });
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

  it('ignores removed mode field', () => {
    const result = AnalyzePrInputSchema.safeParse({ mode: 'unstaged' });
    assert.strictEqual(result.success, true);
  });

  it('ignores removed base field', () => {
    const result = AnalyzePrInputSchema.safeParse({ base: 'origin/main' });
    assert.strictEqual(result.success, true);
  });

  it('ignores removed paths field', () => {
    const result = AnalyzePrInputSchema.safeParse({ paths: ['src/'] });
    assert.strictEqual(result.success, true);
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

  it('rejects invalid urls', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['not-a-url'],
      question: 'test',
    });
    assert.strictEqual(result.success, false);
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

  it('rejects unknown fields', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['https://example.com'],
      question: 'Summarize this page',
      extra: true,
    });
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

  it('rejects invalid urls', () => {
    const result = ExplainErrorInputSchema.safeParse({
      error: 'test',
      urls: ['ftp://example.com'],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = ExplainErrorInputSchema.safeParse({
      error: 'test',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });
});

describe('CompareFilesInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: absolutePath('src', 'a.ts'),
      filePathB: absolutePath('src', 'b.ts'),
    });
    assert.ok(result.success);
  });

  it('accepts with question', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: absolutePath('a.ts'),
      filePathB: absolutePath('b.ts'),
      question: 'security differences',
    });
    assert.ok(result.success);
  });

  it('accepts with googleSearch', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: absolutePath('a.ts'),
      filePathB: absolutePath('b.ts'),
      googleSearch: true,
    });
    assert.ok(result.success);
  });

  it('accepts with cacheName', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: absolutePath('a.ts'),
      filePathB: absolutePath('b.ts'),
      cacheName: 'cachedContents/abc',
    });
    assert.ok(result.success);
  });

  it('rejects missing filePathA', () => {
    const result = CompareFilesInputSchema.safeParse({ filePathB: '/b.ts' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing filePathB', () => {
    const result = CompareFilesInputSchema.safeParse({ filePathA: absolutePath('a.ts') });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty filePathA', () => {
    const result = CompareFilesInputSchema.safeParse({ filePathA: '', filePathB: '/b.ts' });
    assert.strictEqual(result.success, false);
  });

  it('rejects relative file paths', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: 'a.ts',
      filePathB: absolutePath('b.ts'),
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: absolutePath('a.ts'),
      filePathB: absolutePath('b.ts'),
      extra: true,
    });
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
      sourceFilePath: absolutePath('src', 'index.ts'),
    });
    assert.ok(result.success);
  });

  it('accepts with sourceFilePaths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'architecture',
      sourceFilePaths: [absolutePath('src', 'a.ts'), absolutePath('src', 'b.ts')],
    });
    assert.ok(result.success);
  });

  it('rejects both sourceFilePath and sourceFilePaths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      sourceFilePath: absolutePath('a.ts'),
      sourceFilePaths: [absolutePath('b.ts')],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects more than 10 sourceFilePaths', () => {
    const paths = Array.from({ length: 11 }, (_, i) => absolutePath(`file${i}.ts`));
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

  it('rejects relative source file paths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      sourceFilePath: 'src/index.ts',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects empty description', () => {
    const result = GenerateDiagramInputSchema.safeParse({ description: '' });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing description', () => {
    const result = GenerateDiagramInputSchema.safeParse({});
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown input fields', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });
});
