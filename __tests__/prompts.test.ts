import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDiscoverPrompt,
  buildMemoryPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  createPromptDefinitions,
  DiscoverPromptSchema,
  MemoryPromptSchema,
  PUBLIC_PROMPT_NAMES,
  ResearchPromptSchema,
  ReviewPromptSchema,
} from '../src/prompts.js';

const promptDefinitions = createPromptDefinitions();

describe('prompt definitions', () => {
  it('exports the full public prompt surface', () => {
    assert.deepStrictEqual(
      promptDefinitions.map((definition) => definition.name),
      [...PUBLIC_PROMPT_NAMES],
    );
  });

  it('keeps prompt titles aligned with stable prompt ordering', () => {
    assert.deepStrictEqual(
      promptDefinitions.map((definition) => definition.title),
      ['Discover', 'Research', 'Review', 'Memory'],
    );
  });
});

describe('discover prompt', () => {
  it('accepts optional job and goal input', () => {
    const result = DiscoverPromptSchema.safeParse({
      goal: 'I need to inspect memory state',
      job: 'memory',
    });
    assert.ok(result.success);
  });

  it('rejects unknown prompt args', () => {
    const result = DiscoverPromptSchema.safeParse({ extra: true });
    assert.strictEqual(result.success, false);
  });

  it('builds a prompt that references discovery resources', () => {
    const text = buildDiscoverPrompt({}).messages[0]?.content.text ?? '';
    assert.match(text, /discover:\/\/catalog/);
    assert.match(text, /discover:\/\/workflows/);
    assert.match(text, /Workflow: `start-here`/);
  });
});

describe('research prompt', () => {
  it('accepts a goal with optional mode and deliverable', () => {
    const result = ResearchPromptSchema.safeParse({
      deliverable: 'Short briefing',
      goal: 'Research MCP server discoverability patterns',
      mode: 'deep',
    });
    assert.ok(result.success);
  });

  it('rejects blank goals', () => {
    const result = ResearchPromptSchema.safeParse({ goal: '   ' });
    assert.strictEqual(result.success, false);
  });

  it('references the research workflow and mode decision', () => {
    const text =
      buildResearchPrompt({ goal: 'Research something current', mode: 'quick' }).messages[0]
        ?.content.text ?? '';
    assert.match(text, /Workflow: `research`/);
    assert.match(text, /quick or deep research/i);
  });
});

describe('review prompt', () => {
  it('accepts optional subject and focus', () => {
    const result = ReviewPromptSchema.safeParse({ focus: 'regressions', subject: 'diff' });
    assert.ok(result.success);
  });

  it('builds a prompt that references review subject variants', () => {
    const text = buildReviewPrompt({ subject: 'failure' }).messages[0]?.content.text ?? '';
    assert.match(text, /Workflow: `review`/);
    assert.match(text, /review subject/i);
  });
});

describe('memory prompt', () => {
  it('accepts optional action and task', () => {
    const result = MemoryPromptSchema.safeParse({
      action: 'sessions.transcript',
      task: 'I need to inspect a recent chat',
    });
    assert.ok(result.success);
  });

  it('references the memory workflow and resources', () => {
    const text = buildMemoryPrompt({ action: 'caches.list' }).messages[0]?.content.text ?? '';
    assert.match(text, /Workflow: `memory`/);
    assert.match(text, /memory:\/\/sessions/);
    assert.match(text, /memory:\/\/caches/);
  });
});
