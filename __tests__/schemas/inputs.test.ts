import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HarmBlockMethod, HarmBlockThreshold, HarmCategory } from '@google/genai';
import { z } from 'zod/v4';

import { AppError } from '../../src/lib/errors.js';
import {
  AgenticSearchInputSchema,
  AnalyzeFileInputSchema,
  AnalyzeInputSchema,
  AnalyzeUrlInputSchema,
  AskInputSchema,
  ChatInputSchema,
  CompareFilesInputSchema,
  ExecuteCodeInputSchema,
  ExplainErrorInputSchema,
  GenerateDiagramInputSchema,
  parseResponseSchemaJsonValue,
  ResearchInputSchema,
  ReviewInputSchema,
  SearchInputSchema,
} from '../../src/schemas/inputs.js';

const absolutePath = (...segments: string[]) => join(process.cwd(), ...segments);

function getObjectShape(schema: unknown): Record<string, z.ZodType> {
  if (schema && typeof schema === 'object' && 'shape' in schema) {
    return (schema as { shape: Record<string, z.ZodType> }).shape;
  }

  if (schema && typeof schema === 'object' && 'in' in schema) {
    try {
      return getObjectShape(schema.in);
    } catch (error) {
      if ('out' in schema) {
        return getObjectShape(schema.out);
      }
      throw error;
    }
  }

  if (schema && typeof schema === 'object' && 'options' in schema) {
    const shape: Record<string, z.ZodType> = {};
    for (const option of (schema as { options?: unknown[] }).options ?? []) {
      Object.assign(shape, getObjectShape(option));
    }
    return shape;
  }

  throw new Error('Expected object-like schema');
}

function assertSchemaIssue(
  result: { success: true } | { success: false; error: z.ZodError },
  path: (string | number)[],
  message: string,
): void {
  assert.strictEqual(result.success, false);
  if (!result.success) {
    assert.ok(
      result.error.issues.some(
        (issue) => issue.message === message && JSON.stringify(issue.path) === JSON.stringify(path),
      ),
      `Expected issue ${JSON.stringify({ path, message })}; got ${JSON.stringify(result.error.issues)}`,
    );
  }
}

describe('AskInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = AskInputSchema.safeParse({ message: 'hello' });
    assert.ok(result.success);
  });

  it('accepts googleSearch without urls', () => {
    const result = AskInputSchema.safeParse({ message: 'hello', googleSearch: true });
    assert.ok(result.success);
  });

  it('accepts bare message as the minimal branch', () => {
    const result = AskInputSchema.safeParse({ message: 'hello' });
    assert.ok(result.success);
  });

  it('accepts the url branch with urls', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
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
      responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      temperature: 0.2,
      seed: 42,
      googleSearch: true,
      urls: ['https://example.com/docs'],
    });
    assert.ok(result.success);
  });

  it('accepts function responses for session continuation', () => {
    const result = AskInputSchema.safeParse({
      message: 'continue',
      sessionId: 'sess-1',
      functionResponses: [
        {
          id: 'call-1',
          name: 'lookup_order',
          response: { output: { status: 'shipped' } },
        },
      ],
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

  it('rejects toolProfile (no longer a supported field)', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
      toolProfile: 'search',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects urls below the minimum length', () => {
    const result = AskInputSchema.safeParse({
      message: 'analyze these pages',
      urls: [],
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects url arrays combined with unknown toolProfile', () => {
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
      assert.strictEqual(result.data.thinkingLevel, undefined);
    }
  });

  it('accepts public chat grounding inputs', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'Summarize this page',
      googleSearch: true,
      urls: ['https://example.com/docs'],
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.googleSearch, true);
      assert.deepStrictEqual(result.data.urls, ['https://example.com/docs']);
    }
  });

  it('rejects invalid public chat URL inputs', () => {
    assert.strictEqual(ChatInputSchema.safeParse({ goal: 'test', urls: [] }).success, false);
    assert.strictEqual(
      ChatInputSchema.safeParse({ goal: 'test', urls: ['not-a-url'] }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({ goal: 'test', urls: ['http://localhost:3000'] }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'test',
        urls: Array.from({ length: 21 }, (_, index) => `https://example.com/${index}`),
      }).success,
      false,
    );
  });

  it('accepts the flat sessionId and responseSchemaJson fields', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'continue this thread',
      sessionId: 'sess-1',
      responseSchemaJson: JSON.stringify({
        type: 'object',
        properties: { answer: { type: 'string' } },
      }),
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.sessionId, 'sess-1');
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
      memory: { sessionId: 'sess-1' },
    });
    assert.strictEqual(memoryResult.success, false);
  });

  it('rejects invalid responseSchemaJson', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'return JSON',
      responseSchemaJson: '{not valid json}',
    });
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.strictEqual(result.error.issues[0]?.message, 'responseSchemaJson must be valid JSON.');
    }
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

  it('parseResponseSchemaJsonValue throws ZodError for parsed but invalid schemas', () => {
    assert.throws(
      () => parseResponseSchemaJsonValue(JSON.stringify({ type: 'unknown' })),
      z.ZodError,
    );
  });

  it('rejects responseSchemaJson with unsupported $ref usage', () => {
    assert.throws(
      () =>
        parseResponseSchemaJsonValue(
          JSON.stringify({
            type: 'object',
            properties: {
              answer: { $ref: '#/$defs/Answer' },
            },
            $defs: {
              Answer: { type: 'string' },
            },
          }),
        ),
      (error) => error instanceof AppError && error.message.includes('$ref is not supported'),
    );
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
      'Optional reasoning depth override. Omit to use the job default.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.responseSchemaJson.description,
      'JSON Schema (2020-12) for structured output. Single-turn / new-session only.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.temperature.description,
      'Sampling temperature 0-2 (default 1).',
    );
    assert.strictEqual(
      ChatInputSchema.shape.seed.description,
      'Fixed random seed for reproducible outputs.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.googleSearch.description,
      'Enable Google Search grounding for chat. Optional; additive. Combine with `urls` for URL Context.',
    );
    assert.strictEqual(
      ChatInputSchema.shape.urls.description,
      'Public URLs to analyze with URL Context during chat.',
    );
  });

  it('validates fileSearch, functions, functionResponses, and serverSideToolInvocations', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'Use tools',
      sessionId: 'sess-1',
      fileSearch: { fileSearchStoreNames: ['fileSearchStores/docs_1'] },
      functions: {
        declarations: [
          {
            name: 'lookup_doc',
            description: 'Lookup a document',
            parametersJsonSchema: { type: 'object' },
          },
        ],
        mode: 'AUTO',
      },
      functionResponses: [
        {
          name: 'lookup_doc',
          response: { output: { title: 'Doc' } },
        },
      ],
      serverSideToolInvocations: 'never',
    });
    assert.ok(result.success);
  });

  it('rejects invalid fileSearch, functions, and serverSideToolInvocations values', () => {
    // Empty arrays are tolerated: the wrapper object is treated as "unset"
    // so clients that emit placeholder wrappers don't get validation errors.
    const emptyFileSearch = ChatInputSchema.safeParse({
      goal: 'empty stores',
      fileSearch: { fileSearchStoreNames: [] },
    });
    assert.strictEqual(emptyFileSearch.success, true);
    assert.strictEqual(
      (emptyFileSearch as { data: { fileSearch?: unknown } }).data.fileSearch,
      undefined,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad store chars',
        fileSearch: { fileSearchStoreNames: ['bad store'] },
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad store length',
        fileSearch: { fileSearchStoreNames: ['x'.repeat(257)] },
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad function',
        functions: {
          declarations: [{ name: '1bad', description: 'Bad identifier' }],
        },
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad function key',
        functions: {
          declarations: [{ name: 'valid', description: 'Has extra key', extra: true }],
        },
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad mode',
        functions: {
          declarations: [{ name: 'valid', description: 'Valid declaration' }],
          mode: 'FORCED',
        },
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad function response',
        functionResponses: [{ name: 'lookup_doc', response: 'not an object' }],
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'empty function responses',
        functionResponses: [],
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'missing function response name',
        functionResponses: [{ response: { output: 'ok' } }],
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'missing function response payload',
        functionResponses: [{ name: 'lookup_doc' }],
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'unknown function response key',
        functionResponses: [{ name: 'lookup_doc', response: {}, extra: true }],
      }).success,
      false,
    );
    assert.strictEqual(
      ChatInputSchema.safeParse({
        goal: 'bad trace policy',
        serverSideToolInvocations: 'sometimes',
      }).success,
      false,
    );
  });

  it('treats empty fileSearch.fileSearchStoreNames and functions.declarations as unset', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'placeholder wrappers',
      fileSearch: { fileSearchStoreNames: [] },
      functions: { declarations: [] },
      serverSideToolInvocations: 'auto',
    });
    assert.ok(result.success);
    assert.strictEqual(result.data.fileSearch, undefined);
    assert.strictEqual(result.data.functions, undefined);
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

  it('accepts fileSearch', () => {
    const result = SearchInputSchema.safeParse({
      query: 'latest news',
      fileSearch: { fileSearchStoreNames: ['fileSearchStores/research'] },
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
      goal: 'What changed in Node.js 24?',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.mode, 'quick');
      assert.strictEqual(result.data.thinkingLevel, undefined);
    }
  });

  it('accepts deep research input with the default search depth', () => {
    const result = ResearchInputSchema.safeParse({
      mode: 'deep',
      goal: 'Trace the rollout plan',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.searchDepth, 2);
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

  it('allows declarative searchDepth default in quick mode', () => {
    const result = ResearchInputSchema.safeParse({
      mode: 'quick',
      goal: 'test',
      searchDepth: 3,
    });
    assert.strictEqual(result.success, true);
  });

  it('accepts URLs in deep mode and still rejects systemInstruction', () => {
    const withUrls = ResearchInputSchema.safeParse({
      mode: 'deep',
      goal: 'test',
      urls: ['https://example.com'],
    });
    assert.strictEqual(withUrls.success, true);

    const result = ResearchInputSchema.safeParse({
      mode: 'deep',
      goal: 'test',
      systemInstruction: 'format as bullets',
    });
    assert.strictEqual(result.success, false);
  });

  it('accepts fileSearch on research input', () => {
    const result = ResearchInputSchema.safeParse({
      mode: 'quick',
      goal: 'test',
      fileSearch: { fileSearchStoreNames: ['fileSearchStores/research'] },
    });
    assert.strictEqual(result.success, true);
  });

  it('reports exact selector issue paths and messages', () => {
    assertSchemaIssue(
      ResearchInputSchema.safeParse({ mode: 'quick', goal: 'test', deliverable: 'report' }),
      ['deliverable'],
      'deliverable is not allowed when mode=quick.',
    );
    assertSchemaIssue(
      ResearchInputSchema.safeParse({
        mode: 'deep',
        goal: 'test',
        systemInstruction: 'brief',
      }),
      ['systemInstruction'],
      'systemInstruction is not allowed when mode=deep.',
    );
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

  it('defaults searchDepth to 2', () => {
    const result = AgenticSearchInputSchema.safeParse({ topic: 'test' });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.searchDepth, 2);
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

  it('accepts fileSearch', () => {
    const result = AgenticSearchInputSchema.safeParse({
      topic: 'test',
      fileSearch: { fileSearchStoreNames: ['fileSearchStores/agentic'] },
    });
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

describe('shared thinkingLevel metadata', () => {
  it('leaves analyze input thinkingLevel unset when omitted', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize the architecture',
      targetKind: 'file',
      filePath: 'src/index.ts',
      outputKind: 'summary',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, undefined);
    }
  });

  it('leaves review input thinkingLevel unset when omitted', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'diff',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingLevel, undefined);
    }
  });

  it('accepts thinkingBudget without injecting thinkingLevel', () => {
    const result = ChatInputSchema.safeParse({
      goal: 'Use a fixed reasoning budget',
      thinkingBudget: 64,
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.thinkingBudget, 64);
      assert.strictEqual(result.data.thinkingLevel, undefined);
    }
  });

  it('keeps shared thinkingLevel metadata consistent across public tools', () => {
    const chatThinking = getObjectShape(ChatInputSchema).thinkingLevel;
    const analyzeThinking = getObjectShape(AnalyzeInputSchema).thinkingLevel;
    const reviewThinking = getObjectShape(ReviewInputSchema).thinkingLevel;

    assert.strictEqual(analyzeThinking.description, chatThinking.description);
    assert.strictEqual(reviewThinking.description, chatThinking.description);
    assert.strictEqual(analyzeThinking.safeParse(undefined).data, undefined);
    assert.strictEqual(reviewThinking.safeParse(undefined).data, undefined);
  });
});

describe('shared safetySettings validation', () => {
  const validSafetySetting = {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  };
  const validSafetySettingWithMethod = {
    ...validSafetySetting,
    method: HarmBlockMethod.SEVERITY,
  };

  const publicSchemaCases = [
    {
      name: 'chat',
      schema: ChatInputSchema,
      input: { goal: 'test' },
    },
    {
      name: 'research',
      schema: ResearchInputSchema,
      input: { goal: 'test' },
    },
    {
      name: 'analyze',
      schema: AnalyzeInputSchema,
      input: { goal: 'test', filePath: 'src/index.ts' },
    },
    {
      name: 'review',
      schema: ReviewInputSchema,
      input: {},
    },
  ] as const;

  it('accepts valid SafetySetting objects on all public generation schemas', () => {
    for (const testCase of publicSchemaCases) {
      assert.strictEqual(
        testCase.schema.safeParse({
          ...testCase.input,
          safetySettings: [validSafetySetting, validSafetySettingWithMethod],
        }).success,
        true,
        testCase.name,
      );
    }
  });

  it('rejects invalid SafetySetting objects on all public generation schemas', () => {
    const invalidSafetySettings = [
      [{ category: 'BAD', threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH }],
      [{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: 'BAD' }],
      [
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          method: 'BAD',
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
      ],
      ['not-an-object'],
      [
        {
          ...validSafetySetting,
          extra: true,
        },
      ],
    ];

    for (const testCase of publicSchemaCases) {
      for (const safetySettings of invalidSafetySettings) {
        assert.strictEqual(
          testCase.schema.safeParse({
            ...testCase.input,
            safetySettings,
          }).success,
          false,
          `${testCase.name}: ${JSON.stringify(safetySettings)}`,
        );
      }
    }
  });
});

describe('shared selector defaults', () => {
  it('defaults research mode to quick', () => {
    const result = ResearchInputSchema.safeParse({ goal: 'Summarize the latest release notes' });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.mode, 'quick');
    }
  });

  it('defaults analyze selectors to file and summary', () => {
    const summaryResult = AnalyzeInputSchema.safeParse({
      goal: 'Summarize the architecture',
      filePath: 'src/index.ts',
    });
    assert.ok(summaryResult.success);
    if (summaryResult.success) {
      assert.strictEqual(summaryResult.data.targetKind, 'file');
      assert.strictEqual(summaryResult.data.outputKind, 'summary');
      assert.strictEqual(summaryResult.data.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
    }
  });

  it('rejects invalid mediaResolution values', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize the architecture',
      filePath: 'src/index.ts',
      mediaResolution: 'MEDIA_RESOLUTION_TINY',
    });
    assert.strictEqual(result.success, false);
  });

  it('defaults analyze diagramType to mermaid when outputKind=diagram', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Diagram this file',
      filePath: 'src/index.ts',
      outputKind: 'diagram',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.diagramType, 'mermaid');
    }
  });

  it('defaults review subjectKind to diff', () => {
    const result = ReviewInputSchema.safeParse({});
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.subjectKind, 'diff');
    }
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

  it('accepts fileSearch', () => {
    const result = AnalyzeUrlInputSchema.safeParse({
      urls: ['https://example.com'],
      question: 'Summarize',
      fileSearch: { fileSearchStoreNames: ['fileSearchStores/url'] },
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
      filePath: absolutePath('src', 'index.ts'),
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
      filePaths: [absolutePath('src', 'a.ts')],
      outputKind: 'summary',
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects validateSyntax when outputKind=summary', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Summarize this file',
      targetKind: 'file',
      filePath: absolutePath('src', 'index.ts'),
      outputKind: 'summary',
      validateSyntax: true,
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

  it('reports exact selector issue paths and messages', () => {
    assertSchemaIssue(
      AnalyzeInputSchema.safeParse({ goal: 'test', targetKind: 'file' }),
      ['filePath'],
      'filePath is required when targetKind=file.',
    );
    assertSchemaIssue(
      AnalyzeInputSchema.safeParse({ goal: 'test', targetKind: 'url' }),
      ['urls'],
      'urls is required when targetKind=url.',
    );
    assertSchemaIssue(
      AnalyzeInputSchema.safeParse({ goal: 'test', targetKind: 'multi' }),
      ['filePaths'],
      'filePaths is required when targetKind=multi.',
    );
    assertSchemaIssue(
      AnalyzeInputSchema.safeParse({
        goal: 'test',
        targetKind: 'url',
        urls: ['https://example.com'],
        filePath: absolutePath('src', 'index.ts'),
      }),
      ['filePath'],
      'filePath is not allowed when targetKind=url.',
    );
    assertSchemaIssue(
      AnalyzeInputSchema.safeParse({
        goal: 'test',
        targetKind: 'file',
        filePath: absolutePath('src', 'index.ts'),
        outputKind: 'summary',
        validateSyntax: true,
      }),
      ['validateSyntax'],
      'validateSyntax is not allowed when outputKind=summary.',
    );
  });

  it('keeps standard descriptions for flat selector fields', () => {
    const analyzeShape = getObjectShape(AnalyzeInputSchema);

    assert.strictEqual(
      analyzeShape.targetKind?.description,
      'What to analyze: one file, one or more public URLs, or a small local file set.',
    );
    assert.strictEqual(
      analyzeShape.outputKind?.description,
      'Requested output format: summary text or a generated diagram.',
    );
    assert.strictEqual(
      analyzeShape.diagramType?.description,
      'Diagram syntax to generate when outputKind=diagram.',
    );
    assert.strictEqual(
      analyzeShape.mediaResolution?.description,
      'Resolution for image/video processing. Higher = more detail, more tokens.',
    );
  });
});

describe('ReviewInputSchema', () => {
  it('accepts the flat diff selection shape', () => {
    const result = ReviewInputSchema.safeParse({});
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

  it('rejects missing failure error text', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'failure',
      codeContext: 'throw new Error("boom")',
    });
    assert.strictEqual(result.success, false);
  });

  it('reports exact selector issue paths and messages', () => {
    assertSchemaIssue(
      ReviewInputSchema.safeParse({
        subjectKind: 'comparison',
        filePathA: absolutePath('src', 'a.ts'),
      }),
      ['filePathB'],
      'filePathB is required when subjectKind=comparison.',
    );
    assertSchemaIssue(
      ReviewInputSchema.safeParse({ subjectKind: 'failure' }),
      ['error'],
      'error is required when subjectKind=failure.',
    );
    assertSchemaIssue(
      ReviewInputSchema.safeParse({ subjectKind: 'diff', googleSearch: true }),
      ['googleSearch'],
      'googleSearch is not allowed when subjectKind=diff.',
    );
    assertSchemaIssue(
      ReviewInputSchema.safeParse({
        subjectKind: 'comparison',
        filePathA: absolutePath('src', 'a.ts'),
        filePathB: absolutePath('src', 'b.ts'),
        dryRun: true,
      }),
      ['dryRun'],
      'dryRun is not allowed when subjectKind=comparison.',
    );
  });

  it('keeps the standard description for subject selection', () => {
    assert.strictEqual(
      getObjectShape(ReviewInputSchema).subjectKind.description,
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
});
