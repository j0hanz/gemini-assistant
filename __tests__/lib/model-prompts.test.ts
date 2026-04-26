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
    assert.ok(first.systemInstruction.includes('retrieved sources'));
    assert.ok(first.promptText.includes('latest release'));
    assert.ok(first.promptText.includes('Primary URLs:'));
    assert.ok(first.promptText.includes('https://example.com'));
  });

  it('keeps grounded-answer cache prompts free of full instruction duplication', () => {
    const prompt = buildGroundedAnswerPrompt(
      'latest release',
      ['https://example.com'],
      'cachedContents/workspace-1',
    );

    assert.ok(prompt.systemInstruction?.includes('retrieved sources'));
    assert.ok(prompt.promptText.includes('latest release'));
  });

  it('keeps file-analysis system instructions when cache mode has no cache text', () => {
    const prompt = buildFileAnalysisPrompt({
      cacheName: 'cachedContents/workspace-1',
      goal: 'Summarize the file',
      kind: 'single',
    });

    assert.ok(prompt.systemInstruction?.includes('attached file'));
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

    assert.ok(single.systemInstruction?.includes('attached file'));
    assert.ok(multi.systemInstruction?.includes('attached files'));
    assert.ok(url.systemInstruction?.includes('listed URLs'));
    assert.deepStrictEqual(multi.promptParts, [
      { text: 'File: src/index.ts' },
      { text: 'Goal: Compare these files' },
    ]);
  });

  it('keeps diff-review system instructions when cache mode prepends cache text', () => {
    const prompt = buildDiffReviewPrompt({
      cacheName: 'cachedContents/workspace-1',
      mode: 'review',
      promptText: '## Snapshot\n\n```diff\n+ok\n```',
    });

    assert.ok(prompt.systemInstruction?.includes('Review the unified diff'));
    assert.ok(
      prompt.promptText.startsWith(
        'Review the diff for bugs and behavior risk. Ignore formatting-only changes.',
      ),
    );
    assert.ok(prompt.promptText.endsWith('## Snapshot\n\n```diff\n+ok\n```'));
  });

  it('keeps compare-file system instructions when cache mode prepends cache text', () => {
    const prompt = buildDiffReviewPrompt({
      cacheName: 'cachedContents/workspace-1',
      focus: 'Focus authentication differences',
      mode: 'compare',
      promptParts: [{ text: 'File A: src/a.ts' }, { text: 'File B: src/b.ts' }],
    });

    assert.ok(prompt.systemInstruction?.includes('Compare the files'));
    assert.deepStrictEqual(prompt.promptParts, [
      {
        text: 'Compare the files. Output: Summary, Differences, Impact. Cite short quotes.',
      },
      { text: 'File A: src/a.ts' },
      { text: 'File B: src/b.ts' },
      { text: 'Focus: Focus authentication differences' },
    ]);
  });

  it('keeps error-diagnosis system instructions when cache mode prepends cache text', () => {
    const prompt = buildErrorDiagnosisPrompt({
      cacheName: 'cachedContents/workspace-1',
      codeContext: 'throw new Error("boom")',
      error: 'boom',
      language: 'ts',
      urls: ['https://example.com/error'],
    });

    assert.ok(prompt.systemInstruction?.includes('Diagnose the error'));
    assert.ok(prompt.promptText.startsWith('Diagnose the error. Output: Cause, Fix, Notes.'));
    assert.ok(prompt.promptText.includes('## Error'));
    assert.ok(prompt.promptText.includes('## Code'));
    assert.ok(prompt.promptText.includes('## URLs'));
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

  it('keeps diagram system instructions when cache mode prepends cache text', () => {
    const prompt = buildDiagramGenerationPrompt({
      cacheName: 'cachedContents/workspace-1',
      description: 'Show the request flow',
      diagramType: 'mermaid',
    });

    assert.ok(prompt.systemInstruction?.includes('Generate a mermaid diagram'));
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

    assert.ok(prompt.systemInstruction?.includes('Research with Google Search'));
    assert.ok(prompt.systemInstruction?.includes('Code Execution'));
    assert.ok(prompt.promptText.includes('Topic: MCP adoption'));
  });

  it('builds agentic-research prompts with primary URLs and output shape', () => {
    const prompt = buildAgenticResearchPrompt({
      deliverable: 'a decision memo',
      searchDepth: 3,
      topic: 'MCP adoption',
      urls: ['https://example.com/report'],
    });

    assert.ok(prompt.promptText.includes('Primary URLs:'));
    assert.ok(prompt.promptText.includes('https://example.com/report'));
    assert.ok(prompt.systemInstruction?.includes('Preferred shape:'));
    assert.ok(prompt.systemInstruction?.includes('a decision memo'));
  });
});
