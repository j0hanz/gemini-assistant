import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HarmBlockMethod, HarmBlockThreshold, HarmCategory } from '@google/genai';
import { z } from 'zod/v4';

import { AppError } from '../../src/lib/errors.js';
import {
  AnalyzeInputSchema,
  ChatInputSchema,
  parseResponseSchemaJsonValue,
  ResearchInputSchema,
  ReviewInputSchema,
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
      assert.strictEqual(result.data.searchDepth, undefined);
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

  it('leaves diagramType unset when outputKind=diagram is provided', () => {
    const result = AnalyzeInputSchema.safeParse({
      goal: 'Diagram this file',
      filePath: 'src/index.ts',
      outputKind: 'diagram',
    });
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual(result.data.diagramType, undefined);
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
      'Diagram syntax to generate when outputKind=diagram. Defaults to mermaid.',
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
