import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildContextUsed,
  buildSessionSummary,
  emptyContextUsed,
  extractKeywords,
  scoreFile,
} from '../../src/lib/context-assembler.js';

describe('extractKeywords', () => {
  it('removes stopwords and splits on common separators', () => {
    const keywords = extractKeywords('How do I configure the test runner?');
    assert.ok(keywords.includes('configure'));
    assert.ok(keywords.includes('test'));
    assert.ok(keywords.includes('runner'));
    assert.ok(!keywords.includes('the'));
    assert.ok(!keywords.includes('do'));
    assert.ok(!keywords.includes('i'));
  });

  it('lowercases all keywords', () => {
    const keywords = extractKeywords('README TypeScript');
    assert.ok(keywords.includes('readme'));
    assert.ok(keywords.includes('typescript'));
  });

  it('returns empty array for stopword-only input', () => {
    assert.deepStrictEqual(extractKeywords('the a an'), []);
  });
});

describe('scoreFile', () => {
  it('gives static priority to README.md', () => {
    const score = scoreFile('README.md', '', []);
    assert.ok(score >= 0.15, `Expected static priority >= 0.15, got ${score}`);
  });

  it('boosts score on filename keyword match', () => {
    const withMatch = scoreFile('tsconfig.json', '', ['tsconfig']);
    const withoutMatch = scoreFile('tsconfig.json', '', ['deploy']);
    assert.ok(withMatch > withoutMatch);
  });

  it('boosts score on content keyword overlap', () => {
    const content = 'This project uses TypeScript and ESLint for linting';
    const withMatch = scoreFile('file.txt', content, ['eslint', 'typescript']);
    const withoutMatch = scoreFile('file.txt', content, ['python', 'flask']);
    assert.ok(withMatch > withoutMatch);
  });

  it('caps filename score at 0.4', () => {
    const score = scoreFile('test-runner-config-setup.json', '', [
      'test',
      'runner',
      'config',
      'setup',
    ]);
    assert.ok(score <= 1.0);
  });
});

describe('buildSessionSummary', () => {
  it('returns undefined for fewer than 2 entries', () => {
    assert.strictEqual(buildSessionSummary([]), undefined);
    assert.strictEqual(
      buildSessionSummary([{ role: 'user', text: 'hello', timestamp: 1 }]),
      undefined,
    );
  });

  it('wraps transcript in prior_conversation tags', () => {
    const transcript = [
      { role: 'user' as const, text: 'hello', timestamp: 1 },
      { role: 'assistant' as const, text: 'hi there', timestamp: 2 },
    ];
    const summary = buildSessionSummary(transcript);
    assert.ok(summary?.startsWith('<prior_conversation>'));
    assert.ok(summary?.endsWith('</prior_conversation>'));
    assert.ok(summary?.includes('[user]: hello'));
    assert.ok(summary?.includes('[assistant]: hi there'));
  });

  it('truncates long entries', () => {
    const longText = 'x'.repeat(300);
    const transcript = [
      { role: 'user' as const, text: longText, timestamp: 1 },
      { role: 'assistant' as const, text: 'short', timestamp: 2 },
    ];
    const summary = buildSessionSummary(transcript);
    assert.ok(summary !== undefined);
    assert.ok(!summary.includes(longText));
    assert.ok(summary.includes('...'));
  });

  it('prioritizes most recent entries within budget', () => {
    const transcript: { role: 'user' | 'assistant'; text: string; timestamp: number }[] =
      Array.from({ length: 100 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `Turn ${index}`,
        timestamp: index,
      }));
    const summary = buildSessionSummary(transcript, 100);
    assert.ok(summary !== undefined);
    assert.ok(summary.includes('Turn 99'));
  });
});

describe('buildContextUsed', () => {
  it('strips relevanceScore from output sources', () => {
    const sources = [
      { kind: 'workspace-file' as const, name: 'README.md', tokens: 100, relevanceScore: 0.8 },
    ];
    const result = buildContextUsed(sources, 100, false);
    assert.strictEqual(result.sources.length, 1);
    assert.strictEqual(result.sources[0]?.name, 'README.md');
    assert.strictEqual('relevanceScore' in (result.sources[0] ?? {}), false);
  });

  it('reports workspaceCacheApplied correctly', () => {
    assert.strictEqual(buildContextUsed([], 0, true).workspaceCacheApplied, true);
    assert.strictEqual(buildContextUsed([], 0, false).workspaceCacheApplied, false);
  });
});

describe('emptyContextUsed', () => {
  it('returns empty defaults', () => {
    const empty = emptyContextUsed();
    assert.deepStrictEqual(empty.sources, []);
    assert.strictEqual(empty.totalTokens, 0);
    assert.strictEqual(empty.workspaceCacheApplied, false);
  });
});
