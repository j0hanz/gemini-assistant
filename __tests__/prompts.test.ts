import assert from 'node:assert';
import { test } from 'node:test';

import { buildDiscover, registerPrompts } from '../src/prompts.js';
import {
  AnalyzeInputSchema,
  ChatInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../src/schemas/inputs.js';

test('buildDiscover — emits 2 message parts', () => {
  const result = buildDiscover({});

  assert(result !== undefined, 'Should return a result');
  assert('messages' in result && result.messages !== undefined, 'Result should have messages');
  const messages = result.messages;
  assert.strictEqual(messages.length, 2, 'Should have 2 message parts');
});

test('buildDiscover — contains all XML tags', () => {
  const result = buildDiscover({});

  const messages = result.messages;
  const textMessage = messages[0];
  const content = textMessage.content;
  if (content.type !== 'text') {
    throw new Error('Expected text content');
  }
  const text = content.text;

  const requiredTags = [
    '<role>',
    '<goal>',
    '<context>',
    '<constraints>',
    '<output_format>',
    '<next_action>',
  ];

  for (const tag of requiredTags) {
    assert(text.includes(tag), `Text should contain ${tag}`);
  }
});

test('buildDiscover — resource URI is correct', () => {
  const result = buildDiscover({});

  const messages = result.messages;
  const resourceMessage = messages[1];
  const content = resourceMessage.content;
  if (content.type !== 'resource_link') {
    throw new Error('Expected resource_link content');
  }
  assert.strictEqual(content.uri, 'assistant://discover/catalog', 'Resource URI should be correct');
});

test('buildDiscover — _meta.thinkingLevel is MINIMAL', () => {
  const result = buildDiscover({});

  assert.strictEqual(result._meta['gemini-assistant/thinkingLevel'], 'MINIMAL');
});

test('buildDiscover — _meta.nextTool is undefined', () => {
  const result = buildDiscover({});

  assert.strictEqual(result._meta['gemini-assistant/nextTool'], undefined);
});

// ── Test Helpers ────────────────────────────────────────────────────────────

interface CapturedPrompt {
  name: string;
  cb: (args: Record<string, unknown>) => unknown;
}

function makeFakeServer() {
  const captured: CapturedPrompt[] = [];
  const server = {
    registerPrompt: (
      name: string,
      _options: unknown,
      cb: (args: Record<string, unknown>) => unknown,
    ) => {
      captured.push({ name, cb });
    },
  };
  return { server, captured };
}

// ── Prompt Tests ────────────────────────────────────────────────────────────

for (const tk of ['file', 'url', 'multi'] as const) {
  test(`analyze prompt — variant ${tk} renders <variant>`, () => {
    const { server, captured } = makeFakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPrompts(server as any);
    const analyze = captured.find((c) => c.name === 'analyze');
    assert(analyze !== undefined);
    const args: Record<string, unknown> = { goal: 'g', targetKind: tk };
    if (tk === 'file') args['filePath'] = 'a.ts';
    const r = analyze.cb(args) as {
      messages: { content: { text?: string } }[];
      _meta: Record<string, unknown>;
    };
    assert.ok(r.messages[0]?.content.text?.includes(`<variant>Analyze ${tk}</variant>`));
    assert.strictEqual(r._meta['gemini-assistant/nextTool'], 'analyze');
  });
}

test('research prompt — deep mode picks HIGH thinkingLevel', () => {
  const { server, captured } = makeFakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPrompts(server as any);
  const research = captured.find((c) => c.name === 'research');
  assert(research !== undefined);
  const r = research.cb({ goal: 'q', mode: 'deep' }) as { _meta: Record<string, unknown> };
  assert.strictEqual(r._meta['gemini-assistant/thinkingLevel'], 'HIGH');
});

test('chat prompt — thinkingLevel arg overrides default', () => {
  const { server, captured } = makeFakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPrompts(server as any);
  const chat = captured.find((c) => c.name === 'chat');
  assert(chat !== undefined);
  const r = chat.cb({ goal: 'g', thinkingLevel: 'HIGH' }) as { _meta: Record<string, unknown> };
  assert.strictEqual(r._meta['gemini-assistant/thinkingLevel'], 'HIGH');
});

// ── Forward-Flow Contract Tests ─────────────────────────────────────────────
// These tests verify that prompt suggestedArgs can be piped directly to tool input schemas

test('forward-flow — chat prompt suggestedArgs ⊆ ChatInputSchema', () => {
  const { server, captured } = makeFakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPrompts(server as any);
  const chat = captured.find((c) => c.name === 'chat');
  assert(chat);
  const r = chat.cb({ goal: 'explain recursion' }) as {
    _meta: Record<string, unknown>;
  };
  const suggestedArgs = r._meta['gemini-assistant/suggestedArgs'];
  const parsed = ChatInputSchema.safeParse(suggestedArgs);
  assert.ok(
    parsed.success,
    `ChatInputSchema validation failed: ${
      parsed.success
        ? ''
        : JSON.stringify(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
    }`,
  );
});

test('forward-flow — research prompt suggestedArgs ⊆ ResearchInputSchema (deep mode)', () => {
  const { server, captured } = makeFakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPrompts(server as any);
  const research = captured.find((c) => c.name === 'research');
  assert(research);
  const r = research.cb({
    goal: 'latest React hooks',
    mode: 'deep',
    deliverable: 'report',
  }) as { _meta: Record<string, unknown> };
  const suggestedArgs = r._meta['gemini-assistant/suggestedArgs'];
  const parsed = ResearchInputSchema.safeParse(suggestedArgs);
  assert.ok(
    parsed.success,
    `ResearchInputSchema validation failed: ${
      parsed.success
        ? ''
        : JSON.stringify(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
    }`,
  );
});

test('forward-flow — analyze prompt suggestedArgs ⊆ AnalyzeInputSchema (file/diagram)', () => {
  const { server, captured } = makeFakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPrompts(server as any);
  const analyze = captured.find((c) => c.name === 'analyze');
  assert(analyze);
  const r = analyze.cb({
    goal: 'visualize architecture',
    targetKind: 'file',
    filePath: 'src/index.ts',
    outputKind: 'diagram',
    diagramType: 'mermaid',
  }) as { _meta: Record<string, unknown> };
  const suggestedArgs = r._meta['gemini-assistant/suggestedArgs'];
  const parsed = AnalyzeInputSchema.safeParse(suggestedArgs);
  assert.ok(
    parsed.success,
    `AnalyzeInputSchema validation failed: ${
      parsed.success
        ? ''
        : JSON.stringify(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
    }`,
  );
});

test('forward-flow — review prompt suggestedArgs ⊆ ReviewInputSchema (comparison)', () => {
  const { server, captured } = makeFakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPrompts(server as any);
  const review = captured.find((c) => c.name === 'review');
  assert(review);
  const r = review.cb({
    subjectKind: 'comparison',
    filePathA: 'src/old.ts',
    filePathB: 'src/new.ts',
    question: 'what changed?',
  }) as { _meta: Record<string, unknown> };
  const suggestedArgs = r._meta['gemini-assistant/suggestedArgs'];
  const parsed = ReviewInputSchema.safeParse(suggestedArgs);
  assert.ok(
    parsed.success,
    `ReviewInputSchema validation failed: ${
      parsed.success
        ? ''
        : JSON.stringify(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
    }`,
  );
});
