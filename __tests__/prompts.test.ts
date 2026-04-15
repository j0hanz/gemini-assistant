import assert from 'node:assert/strict';
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

const promptDefinitions = createPromptDefinitions(async () => ['C:\\workspace']);

describe('prompt definitions', () => {
  it('exports the full public prompt surface', () => {
    assert.deepStrictEqual(
      promptDefinitions.map((definition) => definition.name),
      [...PUBLIC_PROMPT_NAMES],
    );
  });
});

describe('analyze-file prompt', () => {
  const schema = createAnalyzeFilePromptSchema(async () => ['C:\\workspace']);

  it('accepts valid analyze-file input', () => {
    const result = schema.safeParse({
      filePath: 'C:\\workspace\\src\\index.ts',
      question: 'What does this file do?',
    });
    assert.ok(result.success);
  });

  it('rejects missing filePath', () => {
    const result = schema.safeParse({ question: 'Missing path' });
    assert.strictEqual(result.success, false);
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
});

describe('workflow prompts', () => {
  it('keeps getting-started argument-free', () => {
    const result = GettingStartedPromptSchema.safeParse({});
    assert.ok(result.success);
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
