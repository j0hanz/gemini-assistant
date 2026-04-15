import { isCompletable } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildDeepResearchPrompt,
  buildDiffReviewPrompt,
  buildGettingStartedPrompt,
  buildProjectMemoryPrompt,
  CodeReviewPromptSchema,
  COMMON_LANGUAGES,
  createAnalyzeFilePromptSchema,
  createPromptDefinitions,
  DeepResearchPromptSchema,
  DiffReviewPromptSchema,
  ExplainErrorPromptSchema,
  GettingStartedPromptSchema,
  ProjectMemoryPromptSchema,
  PUBLIC_PROMPT_NAMES,
  SummarizePromptSchema,
  SUMMARY_STYLES,
} from '../src/prompts.js';

const workspaceRoot = process.cwd();
const absolutePath = (...segments: string[]) => join(workspaceRoot, ...segments);
const promptDefinitions = createPromptDefinitions(async () => [workspaceRoot]);

function getCompletionCallback(schema: ReturnType<typeof createAnalyzeFilePromptSchema>) {
  const filePathSchema = schema.shape.filePath;
  assert.ok(isCompletable(filePathSchema));

  const completionMeta = Object.getOwnPropertySymbols(filePathSchema)
    .map((symbol) => (filePathSchema as Record<symbol, unknown>)[symbol])
    .find(
      (value): value is { complete: (value: string | undefined) => Promise<string[]> | string[] } =>
        !!value &&
        typeof value === 'object' &&
        'complete' in value &&
        typeof value.complete === 'function',
    );

  assert.ok(completionMeta);
  return completionMeta.complete;
}

describe('prompt definitions', () => {
  it('exports the full public prompt surface', () => {
    assert.deepStrictEqual(
      promptDefinitions.map((definition) => definition.name),
      [...PUBLIC_PROMPT_NAMES],
    );
  });
});

describe('analyze-file prompt', () => {
  const schema = createAnalyzeFilePromptSchema(async () => [workspaceRoot]);

  it('accepts valid analyze-file input', () => {
    const result = schema.safeParse({
      filePath: absolutePath('src', 'index.ts'),
      question: 'What does this file do?',
    });
    assert.ok(result.success);
  });

  it('accepts relative filePath', () => {
    const result = schema.safeParse({
      filePath: 'src/index.ts',
      question: 'What does this file do?',
    });
    assert.ok(result.success);
  });

  it('rejects missing filePath', () => {
    const result = schema.safeParse({ question: 'Missing path' });
    assert.strictEqual(result.success, false);
  });

  it('rejects root-escaping relative filePath', () => {
    const result = schema.safeParse({
      filePath: '../src/index.ts',
      question: 'What does this file do?',
    });
    assert.strictEqual(result.success, false);
  });

  it('does not expose CURRENT_WORKSPACE_ROOT as a prompt arg', () => {
    const result = schema.safeParse({
      CURRENT_WORKSPACE_ROOT: workspaceRoot,
      filePath: 'src/index.ts',
      question: 'What does this file do?',
    });
    assert.strictEqual(result.success, false);
  });

  it('returns workspace-relative completion suggestions', async () => {
    const complete = getCompletionCallback(schema);
    const suggestions = await complete('src/');

    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((suggestion) => suggestion.startsWith('src/')));
  });

  it('handles nested completion prefixes', async () => {
    const complete = getCompletionCallback(schema);
    const suggestions = await complete('src/lib/');

    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((suggestion) => suggestion.startsWith('src/lib/')));
  });

  it('shows the workspace root in the prompt description instead of as an arg', () => {
    const definition = promptDefinitions.find((entry) => entry.name === 'analyze-file');
    const portableWorkspaceRoot = workspaceRoot.replaceAll('\\', '/');

    assert.ok(definition);
    assert.match(definition.description, /\(.*\)/);
    assert.match(
      definition.description,
      new RegExp(portableWorkspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});

describe('code-review prompt', () => {
  it('accepts valid code input', () => {
    const result = CodeReviewPromptSchema.safeParse({ code: 'console.log("hi")' });
    assert.ok(result.success);
  });

  it('accepts code with language', () => {
    const result = CodeReviewPromptSchema.safeParse({ code: 'print("hi")', language: 'python' });
    assert.ok(result.success);
  });

  it('rejects code exceeding max length', () => {
    const result = CodeReviewPromptSchema.safeParse({ code: 'x'.repeat(100_001) });
    assert.strictEqual(result.success, false);
  });

  it('rejects blank code', () => {
    const result = CodeReviewPromptSchema.safeParse({ code: '   ' });
    assert.strictEqual(result.success, false);
  });

  it('rejects unknown prompt args', () => {
    const result = CodeReviewPromptSchema.safeParse({ code: 'x', extra: true });
    assert.strictEqual(result.success, false);
  });

  it('language completion filters by prefix', () => {
    const filtered = COMMON_LANGUAGES.filter((language) => language.startsWith('py'));
    assert.deepStrictEqual(filtered, ['python']);
  });
});

describe('summarize prompt', () => {
  it('accepts valid text input', () => {
    const result = SummarizePromptSchema.safeParse({ text: 'Some long text here.' });
    assert.ok(result.success);
  });

  it('accepts all valid styles', () => {
    for (const style of SUMMARY_STYLES) {
      const result = SummarizePromptSchema.safeParse({ text: 'Content', style });
      assert.ok(result.success, `Style '${style}' should be valid`);
    }
  });

  it('rejects invalid style', () => {
    const result = SummarizePromptSchema.safeParse({ text: 'Content', style: 'verbose' });
    assert.strictEqual(result.success, false);
  });

  it('rejects blank text', () => {
    const result = SummarizePromptSchema.safeParse({ text: '   ' });
    assert.strictEqual(result.success, false);
  });
});

describe('explain-error prompt', () => {
  it('accepts valid error input', () => {
    const result = ExplainErrorPromptSchema.safeParse({
      error: 'TypeError: undefined is not a function',
    });
    assert.ok(result.success);
  });

  it('rejects context exceeding max length', () => {
    const result = ExplainErrorPromptSchema.safeParse({
      error: 'some error',
      context: 'x'.repeat(10_001),
    });
    assert.strictEqual(result.success, false);
  });

  it('rejects blank error input', () => {
    const result = ExplainErrorPromptSchema.safeParse({
      error: '   ',
    });
    assert.strictEqual(result.success, false);
  });
});

describe('workflow prompts', () => {
  it('keeps getting-started argument-free', () => {
    const result = GettingStartedPromptSchema.safeParse({});
    assert.ok(result.success);
  });

  it('rejects unexpected getting-started args', () => {
    const result = GettingStartedPromptSchema.safeParse({ extra: true });
    assert.strictEqual(result.success, false);
  });

  it('builds a getting-started prompt that references discovery resources', () => {
    const text = buildGettingStartedPrompt().messages[0]?.content.text ?? '';
    assert.match(text, /tools:\/\/list/);
    assert.match(text, /workflows:\/\/list/);
    assert.match(text, /Recommended tools: `ask`, `search`, `analyze_file`/);
  });

  it('accepts deep-research topic input and references research tools', () => {
    const result = DeepResearchPromptSchema.safeParse({ topic: 'MCP discoverability patterns' });
    assert.ok(result.success);

    const text =
      buildDeepResearchPrompt({ topic: 'MCP discoverability patterns' }).messages[0]?.content
        .text ?? '';
    assert.match(text, /agentic_search/);
    assert.match(text, /search/);
    assert.match(text, /workflows:\/\/list/);
  });

  it('rejects blank deep-research topic', () => {
    const result = DeepResearchPromptSchema.safeParse({ topic: '   ' });
    assert.strictEqual(result.success, false);
  });

  it('accepts optional project-memory fields and references transcript inspection', () => {
    const result = ProjectMemoryPromptSchema.safeParse({
      project: 'gemini-assistant',
      currentTask: 'package the discovery layer',
    });
    assert.ok(result.success);

    const text =
      buildProjectMemoryPrompt({
        project: 'gemini-assistant',
        currentTask: 'package the discovery layer',
      }).messages[0]?.content.text ?? '';
    assert.match(text, /create_cache/);
    assert.match(text, /sessions:\/\/\{sessionId\}\/transcript/);
    assert.match(text, /caches:\/\/list/);
  });

  it('accepts optional diff-review focus and references local review tools', () => {
    const result = DiffReviewPromptSchema.safeParse({ focus: 'regressions' });
    assert.ok(result.success);

    const text = buildDiffReviewPrompt({ focus: 'regressions' }).messages[0]?.content.text ?? '';
    assert.match(text, /analyze_pr/);
    assert.match(text, /compare_files/);
    assert.match(text, /explain_error/);
  });
});
