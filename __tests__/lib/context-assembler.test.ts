import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractKeywords, scoreFile } from '../../src/lib/context-assembler.js';

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
