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

    assert.ok(prompt.systemInstruction?.includes('grounded search results only'));
    assert.ok(prompt.promptText.includes('latest release'));
    assert.ok(!prompt.promptText.includes('Answer from grounded search results only'));
  });

  it('keeps file-analysis system instructions when cache mode has no cache text', () => {
    const prompt = buildFileAnalysisPrompt({
      cacheName: 'cachedContents/workspace-1',
      goal: 'Summarize the file',
      kind: 'single',
    });

    assert.ok(prompt.systemInstruction?.includes('provided file only'));
    assert.strictEqual(prompt.promptText, 'Summarize the file');
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
        'TASK: Review the diff for bugs, regressions, and behavior risk.\nOUTPUT: Findings, Fixes.\nCONSTRAINTS: Ignore formatting-only changes.',
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
        text: 'TASK: Compare the provided files.\nOUTPUT: Summary, Differences, Impact.\nCONSTRAINTS: Cite symbols or short quotes.',
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
        'TASK: Diagnose the error.\nOUTPUT: Cause, Fix, Notes.\nCONSTRAINTS: Extract distinct error queries before searching.',
      ),
    );
    assert.ok(prompt.promptText.includes('## Error'));
    assert.ok(prompt.promptText.includes('## Code'));
    assert.ok(prompt.promptText.includes('## URLs'));
    assert.ok(!prompt.promptText.includes('TASK: Diagnose the provided error.'));
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

    assert.ok(prompt.systemInstruction?.includes('Research with Google Search and Code Execution'));
    assert.ok(prompt.promptText.includes('Topic: MCP adoption'));
    assert.ok(
      prompt.promptText.includes('Exhaustive: cover as many relevant aspects as possible.'),
    );
    assert.ok(!prompt.promptText.includes('Split the topic into sub-questions'));
  });
});
