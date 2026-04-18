import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { completeCacheNames } from '../../src/client.js';
import {
  AgenticSearchInputSchema,
  AnalyzeFileInputSchema,
  AnalyzeInputSchema,
  AnalyzePrInputSchema,
  AnalyzeUrlInputSchema,
  AskInputSchema,
  ChatInputSchema,
  CompareFilesInputSchema,
  CreateCacheInputSchema,
  DeleteCacheInputSchema,
  ExecuteCodeInputSchema,
  ExplainErrorInputSchema,
  GenerateDiagramInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
  SearchInputSchema,
  UpdateCacheInputSchema,
} from '../../src/schemas/inputs.js';

const absolutePath = (...segments: string[]) => join(process.cwd(), ...segments);
const COMPLETABLE_SYMBOL = Symbol.for('mcp.completable');

function getCompleter(schema: unknown) {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  return (schema as Record<symbol, { complete?: unknown } | undefined>)[COMPLETABLE_SYMBOL]
    ?.complete;
}

describe('AskInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = AskInputSchema.safeParse({ message: 'hello' });
    assert.ok(result.success);
  });

  it('accepts the explicit non-url tool profile branch', () => {
    const result = AskInputSchema.safeParse({ message: 'hello', toolProfile: 'search' });
    assert.ok(result.success);
  });

  it('accepts explicit none without urls', () => {
    const result = AskInputSchema.safeParse({ message: 'hello', toolProfile: 'none' });
    assert.ok(result.success);
  });

  it('accepts the explicit url-capable tool profile branch', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
      toolProfile: 'search_url',
      urls: ['https://example.com/docs'],
    });
    assert.ok(result.success);
  });

  it('rejects empty sessionId after trim', () => {
    const result = AskInputSchema.safeParse({ message: 'hello', sessionId: '   ' });
    assert.strictEqual(result.success, false);
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

  it('rejects urls without a url-capable tool profile', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
      urls: ['https://example.com/docs'],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects urls on non-url tool profiles', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
      toolProfile: 'search',
      urls: ['https://example.com/docs'],
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

  it('rejects duplicate required keys in responseSchema', () => {
    const result = AskInputSchema.safeParse({
      message: 'return JSON',
      responseSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer', 'answer'],
      },
    });
    assert.strictEqual(result.success, false);
  });
});

describe('ChatInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = ChatInputSchema.safeParse({ goal: 'help me debug this' });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, 'MEDIUM');
    }
  });

  it('accepts the flat sessionId and responseSchemaJson fields', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'continue this thread',
      sessionId: 'sess-1',
      cacheName: 'cachedContents/abc123',
      responseSchemaJson: JSON.stringify({
        type: 'object',
        properties: { answer: { type: 'string' } },
      }),
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.sessionId, 'sess-1');
      assert.strictEqual(result.data.cacheName, 'cachedContents/abc123');
    }
  });

  it('rejects empty sessionId after trim', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'continue this thread',
      sessionId: '   ',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects removed nested session and memory fields', () => {
    const sessionResult = ChatInputSchema.safeParse({
      goal: 'continue this thread',
      session: { id: 'sess-1' },
    });
    assert.strictEqual(sessionResult.success, false);

    const memoryResult = ChatInputSchema.safeParse({
      goal: 'continue this thread',
      memory: { cacheName: 'cachedContents/abc123' },
    });
    assert.strictEqual(memoryResult.success, false);
  });

  it('rejects invalid responseSchemaJson', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'return JSON',
      responseSchemaJson: '{not valid json}',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects responseSchemaJson that fails supported schema validation', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'return JSON',
      responseSchemaJson: JSON.stringify({
        type: 'object',
        properties: { ok: { type: 42 } },
      }),
    });
    assert.strictEqual(result.success, false);
  });

  it('formats nested responseSchemaJson validation failures with Zod error text', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'return JSON',
      responseSchemaJson: JSON.stringify({
        type: 'object',
        properties: { ok: { type: 42 } },
      }),
    });
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0]?.message ?? '', /responseSchemaJson must match/i);
      assert.match(
        result.error.issues[0]?.message ?? '',
        /properties\.ok\.type|properties\["ok"\]\.type/i,
      );
    }
  });

  it('rejects temperature above the bounded range', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'help me debug this',
      temperature: 2.1,
    });
    assert.strictEqual(result.success, false);
  });

  it('keeps standard field descriptions on the public contract', () => {
    assert.strictEqual(ChatInputSchema.shape.goal.description, 'User goal or requested outcome');
    assert.strictEqual(
      ChatInputSchema.shape.thinkingLevel.description,
      'Reasoning depth. Default: MEDIUM. MINIMAL is fastest; HIGH is deepest.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.responseSchemaJson.description,
      'Structured output schema as JSON. Use JSON input instead of nested form fields.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.temperature.description,
      'Sampling temperature (0.0 to 2.0). Lower is more deterministic.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.seed.description,
      'Fixed random seed for reproducible outputs.',
    );
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

describe('ResearchInputSchema', () => {
  it('accepts quick research input', () => {
    const result = ResearchInputSchema.safeParse({
      mode: 'quick',
      goal: 'What changed in Node.js 24?',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, 'MEDIUM');
    }
  });

  it('accepts deep research input with the default search depth', () => {
    const result = ResearchInputSchema.safeParse({
      mode: 'deep',
      goal: 'Trace the rollout plan',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.searchDepth, 3);
    }
  });

  it('rejects unknown fields', () => {
    const result = ResearchInputSchema.safeParse({
      mode: 'quick',
      goal: 'test',
      extra: true,
    });
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

  it('accepts relative filePath', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: 'fixtures/file.pdf',
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

  it('rejects root-escaping relative filePath', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: '../file.pdf',
      question: 'Summarize this document',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing fields', () => {
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({}).success, false);
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({ filePath: '/a' }).success, false);
    assert.strictEqual(AnalyzeFileInputSchema.safeParse({ question: 'q' }).success, false);
  });

  it('rejects the removed CURRENT_WORKSPACE_ROOT field', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      CURRENT_WORKSPACE_ROOT: process.cwd(),
      filePath: absolutePath('fixtures', 'file.pdf'),
      question: 'Summarize this document',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = AnalyzeFileInputSchema.safeParse({
      filePath: absolutePath('fixtures', 'file.pdf'),
      question: 'Summarize this document',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects Windows drive-relative filePath forms', () => {
    assert.strictEqual(
      AnalyzeFileInputSchema.safeParse({
        filePath: 'C:temp.txt',
        question: 'Summarize this document',
      }).success,
      false,
    );
    assert.strictEqual(
      AnalyzeFileInputSchema.safeParse({
        filePath: 'C:..\\temp.txt',
        question: 'Summarize this document',
      }).success,
      false,
    );
  });
});

describe('CreateCacheInputSchema', () => {
  it('accepts with filePaths', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: [absolutePath('fixtures', 'big-file.pdf')],
    });
    assert.ok(result.success);
  });

  it('accepts relative filePaths', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: ['fixtures/big-file.pdf'],
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

  it('rejects empty filePaths when systemInstruction is present', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: [],
      systemInstruction: 'Cache this instruction',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects filePaths exceeding 50 entries', () => {
    const paths = Array.from({ length: 51 }, (_, i) => absolutePath(`file${i}.txt`));
    const result = CreateCacheInputSchema.safeParse({ filePaths: paths });
    assert.strictEqual(result.success, false);
  });

  it('rejects root-escaping relative filePaths', () => {
    const result = CreateCacheInputSchema.safeParse({
      filePaths: ['../file.txt'],
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

  it('rejects the removed CURRENT_WORKSPACE_ROOT field', () => {
    const result = CreateCacheInputSchema.safeParse({
      CURRENT_WORKSPACE_ROOT: process.cwd(),
      systemInstruction: 'Cache this',
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
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, 'MEDIUM');
    }
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

  it('keeps cacheName wired to live cache completion', () => {
    assert.strictEqual(getCompleter(AnalyzePrInputSchema.shape.cacheName), completeCacheNames);
  });
});

describe('shared thinkingLevel defaults', () => {
  it('defaults analyze input to MEDIUM', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize the architecture',
      targetKind: 'file',
      filePath: 'src/index.ts',
      outputKind: 'summary',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, 'MEDIUM');
    }
  });

  it('defaults review input to MEDIUM', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'diff',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, 'MEDIUM');
    }
  });

  it('keeps shared thinkingLevel metadata consistent across public tools', () => {
    const chatThinking = ChatInputSchema.shape.thinkingLevel;
    const analyzeThinking = AnalyzeInputSchema.shape.thinkingLevel;
    const reviewThinking = ReviewInputSchema.shape.thinkingLevel;

    assert.strictEqual(analyzeThinking.description, chatThinking.description);
    assert.strictEqual(reviewThinking.description, chatThinking.description);
    assert.strictEqual(analyzeThinking.safeParse(undefined).data, 'MEDIUM');
    assert.strictEqual(reviewThinking.safeParse(undefined).data, 'MEDIUM');
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

describe('AnalyzeInputSchema', () => {
  it('accepts a file summary request', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize this file',
      targetKind: 'file',
      filePath: absolutePath('src', 'index.ts'),
      outputKind: 'summary',
    });
    assert.ok(result.success);
  });

  it('accepts a diagram request for multiple files', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Diagram the flow',
      targetKind: 'multi',
      filePaths: [absolutePath('src', 'a.ts'), absolutePath('src', 'b.ts')],
      outputKind: 'diagram',
      diagramType: 'mermaid',
    });
    assert.ok(result.success);
  });

  it('rejects irrelevant fields for the selected target kind', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize this file',
      targetKind: 'file',
      filePath: absolutePath('src', 'index.ts'),
      urls: ['https://example.com'],
      outputKind: 'summary',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects diagram-only fields when outputKind=summary', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize this file',
      targetKind: 'file',
      filePath: absolutePath('src', 'index.ts'),
      outputKind: 'summary',
      diagramType: 'mermaid',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown fields', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'test',
      targetKind: 'file',
      filePath: absolutePath('src', 'index.ts'),
      outputKind: 'summary',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });

  it('keeps standard descriptions for flat selector fields', () => {
    assert.strictEqual(
      AnalyzeInputSchema.shape.targetKind.description,
      'What to analyze: one file, one or more public URLs, or a small local file set.',
    );
    assert.strictEqual(
      AnalyzeInputSchema.shape.outputKind.description,
      'Requested output format: summary text or a generated diagram.',
    );
  });
});

describe('ReviewInputSchema', () => {
  it('accepts the flat diff selection shape', () => {
    const result = ReviewInputSchema.safeParse({ subjectKind: 'diff' });
    assert.ok(result.success);
  });

  it('accepts the flat comparison selection shape', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'comparison',
      filePathA: absolutePath('src', 'a.ts'),
      filePathB: absolutePath('src', 'b.ts'),
    });
    assert.ok(result.success);
  });

  it('rejects irrelevant fields for subjectKind=diff', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'diff',
      filePathA: absolutePath('src', 'a.ts'),
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects missing comparison file paths', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'comparison',
      filePathA: absolutePath('src', 'a.ts'),
    });
    assert.strictEqual(result.success, false);
  });

  it('keeps the standard description for subject selection', () => {
    assert.strictEqual(
      ReviewInputSchema.shape.subjectKind.description,
      'What to review: the current diff, a file comparison, or a failure report.',
    );
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

  it('keeps cacheName wired to live cache completion', () => {
    assert.strictEqual(getCompleter(ExplainErrorInputSchema.shape.cacheName), completeCacheNames);
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

  it('accepts relative file paths', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: 'src/a.ts',
      filePathB: 'src/b.ts',
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

  it('rejects root-escaping relative file paths', () => {
    const result = CompareFilesInputSchema.safeParse({
      filePathA: '../a.ts',
      filePathB: absolutePath('b.ts'),
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects the removed CURRENT_WORKSPACE_ROOT field', () => {
    const result = CompareFilesInputSchema.safeParse({
      CURRENT_WORKSPACE_ROOT: process.cwd(),
      filePathA: absolutePath('a.ts'),
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

  it('rejects Windows drive-relative file paths', () => {
    assert.strictEqual(
      CompareFilesInputSchema.safeParse({
        filePathA: 'C:temp-a.ts',
        filePathB: absolutePath('b.ts'),
      }).success,
      false,
    );
    assert.strictEqual(
      CompareFilesInputSchema.safeParse({
        filePathA: absolutePath('a.ts'),
        filePathB: 'C:..\\temp-b.ts',
      }).success,
      false,
    );
  });

  it('keeps cacheName wired to live cache completion', () => {
    assert.strictEqual(getCompleter(CompareFilesInputSchema.shape.cacheName), completeCacheNames);
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

  it('accepts relative source file paths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'class diagram',
      sourceFilePath: 'src/index.ts',
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

  it('rejects root-escaping relative source file paths', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      sourceFilePath: '../src/index.ts',
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

  it('rejects the removed CURRENT_WORKSPACE_ROOT field', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      CURRENT_WORKSPACE_ROOT: process.cwd(),
      description: 'test',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown input fields', () => {
    const result = GenerateDiagramInputSchema.safeParse({
      description: 'test',
      extra: true,
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects Windows drive-relative source file paths', () => {
    assert.strictEqual(
      GenerateDiagramInputSchema.safeParse({
        description: 'test',
        sourceFilePath: 'C:diagram.ts',
      }).success,
      false,
    );
    assert.strictEqual(
      GenerateDiagramInputSchema.safeParse({
        description: 'test',
        sourceFilePaths: ['C:..\\diagram.ts'],
      }).success,
      false,
    );
  });

  it('keeps cacheName wired to live cache completion', () => {
    assert.strictEqual(
      getCompleter(GenerateDiagramInputSchema.shape.cacheName),
      completeCacheNames,
    );
  });
});
