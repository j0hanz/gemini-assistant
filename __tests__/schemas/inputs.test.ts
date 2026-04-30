import { test } from 'node:test';
import assert from 'node:assert';
import { ChatInputSchema, ResearchInputSchema, AnalyzeInputSchema, ReviewInputSchema } from '../../src/schemas/inputs.js';

test('ChatInputSchema — valid minimal input passes', () => {
  const result = ChatInputSchema.safeParse({ goal: 'hello' });
  assert.strictEqual(result.success, true);
});

test('ChatInputSchema — missing goal field throws', () => {
  const result = ChatInputSchema.safeParse({});
  assert.strictEqual(result.success, false);
});

test('ChatInputSchema — extra properties rejected', () => {
  const result = ChatInputSchema.safeParse({ goal: 'hello', unknownField: 'value' });
  assert.strictEqual(result.success, false);
});

test('ChatInputSchema — invalid thinkingLevel value rejected', () => {
  const result = ChatInputSchema.safeParse({
    goal: 'hello',
    thinkingLevel: 'invalid',
  });
  assert.strictEqual(result.success, false);
});

test('ResearchInputSchema — valid quick mode passes', () => {
  const result = ResearchInputSchema.safeParse({ goal: 'what is X?' });
  assert.strictEqual(result.success, true);
});

test('ResearchInputSchema — valid with explicit deep mode passes', () => {
  const result = ResearchInputSchema.safeParse({ goal: 'what is X?', mode: 'deep' });
  assert.strictEqual(result.success, true);
});

test('ResearchInputSchema — missing goal field throws', () => {
  const result = ResearchInputSchema.safeParse({ mode: 'quick' });
  assert.strictEqual(result.success, false);
});

test('ResearchInputSchema — extra properties rejected', () => {
  const result = ResearchInputSchema.safeParse({ goal: 'what?', mode: 'quick', unknown: 'field' });
  assert.strictEqual(result.success, false);
});

test('AnalyzeInputSchema — valid file target passes', () => {
  const result = AnalyzeInputSchema.safeParse({ goal: 'analyze', targetKind: 'file', filePath: '/path/to/file.txt' });
  assert.strictEqual(result.success, true);
});

test('AnalyzeInputSchema — missing goal field throws', () => {
  const result = AnalyzeInputSchema.safeParse({ targetKind: 'file', filePath: '/file' });
  assert.strictEqual(result.success, false);
});

test('AnalyzeInputSchema — missing filePath for file target throws', () => {
  const result = AnalyzeInputSchema.safeParse({ goal: 'analyze', targetKind: 'file' });
  assert.strictEqual(result.success, false);
});

test('AnalyzeInputSchema — extra properties rejected', () => {
  const result = AnalyzeInputSchema.safeParse({ goal: 'analyze', targetKind: 'file', filePath: '/file', extra: 'field' });
  assert.strictEqual(result.success, false);
});

test('ReviewInputSchema — valid diff subject passes', () => {
  const result = ReviewInputSchema.safeParse({ subjectKind: 'diff' });
  assert.strictEqual(result.success, true);
});

test('ReviewInputSchema — missing subjectKind defaults to diff', () => {
  const result = ReviewInputSchema.safeParse({});
  assert.strictEqual(result.success, true);
});

test('ReviewInputSchema — extra properties rejected', () => {
  const result = ReviewInputSchema.safeParse({ subjectKind: 'diff', extra: 'field' });
  assert.strictEqual(result.success, false);
});
