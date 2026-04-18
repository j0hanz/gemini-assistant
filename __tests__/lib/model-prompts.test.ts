import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAgenticResearchPrompt,
  buildDiagramGenerationPrompt,
  buildDiffReviewPrompt,
  buildErrorDiagnosisPrompt,
  buildFileAnalysisPrompt,
  buildGroundedAnswerPrompt,
} from '../../src/lib/model-prompts.js';

describe('model-prompts', () => {
  it('builds deterministic grounded-answer prompts', () => {
    const first = buildGroundedAnswerPrompt('latest release', ['https://example.com']);
    const second = buildGroundedAnswerPrompt('latest release', ['https://example.com']);

    assert.deepStrictEqual(first, second);
    assert.ok(first.systemInstruction);
    assert.ok(first.systemInstruction.length < 140);
    assert.ok(first.promptText.includes('latest release'));
    assert.ok(first.promptText.includes('https://example.com'));
  });

  it('keeps grounded-answer cache prompts free of full instruction duplication', () => {
    const prompt = buildGroundedAnswerPrompt(
      'latest release',
      ['https://example.com'],
      'cachedContents/workspace-1',
    );

    assert.strictEqual(prompt.systemInstruction, undefined);
    assert.ok(prompt.promptText.includes('latest release'));
    assert.ok(!prompt.promptText.includes('Answer from grounded search results only'));
  });

  it('builds file-analysis prompts for all supported modes', () => {
    const single = buildFileAnalysisPrompt({ goal: 'Summarize the file', kind: 'single' });
    const multi = buildFileAnalysisPrompt({
      attachedParts: [{ text: 'File: src/index.ts' }],
      goal: 'Compare these files',
      kind: 'multi',
    });
    const url = buildFileAnalysisPrompt({
      goal: 'Summarize the page',
      kind: 'url',
      urls: ['https://example.com'],
    });

    assert.ok(single.systemInstruction?.includes('provided file only'));
    assert.ok(multi.systemInstruction?.includes('provided local files'));
    assert.ok(url.systemInstruction?.includes('retrieved URL content only'));
    assert.deepStrictEqual(multi.promptParts, [
      { text: 'File: src/index.ts' },
      { text: 'Goal: Compare these files' },
    ]);
  });

  it('removes system instruction duplication for diff-review cache mode', () => {
    const prompt = buildDiffReviewPrompt({
      cacheName: 'cachedContents/workspace-1',
      mode: 'review',
      promptText: '## Snapshot\n\n```diff\n+ok\n```',
    });

    assert.strictEqual(prompt.systemInstruction, undefined);
    assert.ok(
      prompt.promptText.startsWith(
        'Review the diff for bugs, regressions, and behavior risk. Ignore formatting-only changes. Output: Findings, Fixes.',
      ),
    );
    assert.ok(prompt.promptText.endsWith('## Snapshot\n\n```diff\n+ok\n```'));
  });

  it('keeps compare-file cache prompts task-specific', () => {
    const prompt = buildDiffReviewPrompt({
      cacheName: 'cachedContents/workspace-1',
      focus: 'Focus authentication differences',
      mode: 'compare',
      promptParts: [{ text: 'File A: src/a.ts' }, { text: 'File B: src/b.ts' }],
    });

    assert.strictEqual(prompt.systemInstruction, undefined);
    assert.deepStrictEqual(prompt.promptParts, [
      {
        text: 'Compare only the provided files. Cite symbols or short quotes. Output: Summary, Differences, Impact.',
      },
      { text: 'File A: src/a.ts' },
      { text: 'File B: src/b.ts' },
      { text: 'Focus: Focus authentication differences' },
    ]);
  });

  it('keeps error-diagnosis cache prompts focused on live task content', () => {
    const prompt = buildErrorDiagnosisPrompt({
      cacheName: 'cachedContents/workspace-1',
      codeContext: 'throw new Error("boom")',
      error: 'boom',
      language: 'ts',
      urls: ['https://example.com/error'],
    });

    assert.strictEqual(prompt.systemInstruction, undefined);
    assert.ok(
      prompt.promptText.startsWith(
        'Diagnose the error and answer with Cause, Fix, and Notes. If search is available, extract distinct error queries before searching.',
      ),
    );
    assert.ok(prompt.promptText.includes('## Error'));
    assert.ok(prompt.promptText.includes('## Code'));
    assert.ok(prompt.promptText.includes('## URLs'));
    assert.ok(!prompt.promptText.includes('Diagnose the provided error. If search is available'));
  });

  it('builds diagram prompts with one live task part and a short stable instruction', () => {
    const prompt = buildDiagramGenerationPrompt({
      attachedParts: [{ text: 'Source file: src/index.ts' }],
      description: 'Show the request flow',
      diagramType: 'mermaid',
      validateSyntax: true,
    });

    assert.ok(prompt.systemInstruction?.includes('Return exactly one fenced'));
    assert.deepStrictEqual(prompt.promptParts, [
      { text: 'Source file: src/index.ts' },
      { text: 'Task: Show the request flow' },
    ]);
  });

  it('keeps a concise diagram cue in cache mode', () => {
    const prompt = buildDiagramGenerationPrompt({
      cacheName: 'cachedContents/workspace-1',
      description: 'Show the request flow',
      diagramType: 'mermaid',
    });

    assert.strictEqual(prompt.systemInstruction, undefined);
    assert.deepStrictEqual(prompt.promptParts, [
      { text: 'Return exactly one fenced ```mermaid block.' },
      { text: 'Task: Show the request flow' },
    ]);
  });

  it('builds agentic-research prompts without duplicating process instructions in cache mode', () => {
    const prompt = buildAgenticResearchPrompt({
      cacheName: 'cachedContents/workspace-1',
      searchDepth: 4,
      topic: 'MCP adoption',
    });

    assert.strictEqual(prompt.systemInstruction, undefined);
    assert.ok(prompt.promptText.includes('Topic: MCP adoption'));
    assert.ok(
      prompt.promptText.includes('Exhaustive: cover as many relevant aspects as possible.'),
    );
    assert.ok(!prompt.promptText.includes('Split the topic into sub-questions'));
  });
});
