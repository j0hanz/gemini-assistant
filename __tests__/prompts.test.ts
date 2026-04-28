import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDiscoverPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  DiscoverPromptSchema,
  PUBLIC_JOB_OPTIONS,
  PUBLIC_PROMPT_NAMES,
  registerPrompts,
  renderWorkflowSection,
  ResearchPromptSchema,
  ReviewPromptSchema,
} from '../src/prompts.js';

function createPromptCaptureServer() {
  const prompts: { description?: string; name: string; title?: string }[] = [];

  return {
    prompts,
    server: {
      registerPrompt: (
        name: string,
        config: { description?: string; title?: string },
        _cb: unknown,
      ) => {
        prompts.push({
          name,
          ...(config.title ? { title: config.title } : {}),
          ...(config.description ? { description: config.description } : {}),
        });
      },
    },
  };
}

describe('prompt registration', () => {
  it('registers exactly the public prompt names in order', () => {
    const { prompts, server } = createPromptCaptureServer();

    registerPrompts(server as never);

    assert.deepStrictEqual(
      prompts.map((prompt) => prompt.name),
      [...PUBLIC_PROMPT_NAMES],
    );
  });

  it('registers prompts with correct titles', () => {
    const { prompts, server } = createPromptCaptureServer();

    registerPrompts(server as never);

    assert.deepStrictEqual(
      prompts.map((prompt) => prompt.title),
      ['Discover', 'Research', 'Review'],
    );
  });
});

describe('discover prompt', () => {
  it('accepts optional job and goal input', () => {
    const result = DiscoverPromptSchema.safeParse({
      goal: 'I need to inspect workspace state',
      job: 'chat',
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

  it('derives the public job options from the public job schema', () => {
    assert.deepStrictEqual(PUBLIC_JOB_OPTIONS, ['chat', 'research', 'analyze', 'review']);
  });

  it('gracefully degrades when a workflow entry is unavailable', () => {
    const text = renderWorkflowSection('missing-workflow' as never);
    assert.match(text, /Workflow: `missing-workflow`/);
    assert.match(text, /discover:\/\/workflows/);
    assert.match(text, /Catalog entry unavailable/);
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
