import assert from 'node:assert';
import { test } from 'node:test';

import {
  appendResourceLinks,
  buildResourceMeta,
  normalizeWorkspacePath,
  validateScanPath,
} from '../../src/resources/metadata.js';

// ────────────────────────────────────────────────────────────────────────────
// appendResourceLinks tests
// ────────────────────────────────────────────────────────────────────────────

test('appendResourceLinks — appends _meta block to content', () => {
  const content = '# Catalog\nFoo bar';
  const uri = 'assistant://discover/catalog';
  const result = appendResourceLinks(content, uri);

  assert(result.startsWith(content));
  assert(result.includes('_meta'));
  assert(result.includes('links'));
  assert(result.includes('self'));
  assert(result.includes(uri));
});

test('appendResourceLinks — includes optional name in meta', () => {
  const content = 'Test content';
  const uri = 'assistant://profiles';
  const result = appendResourceLinks(content, uri, { name: 'Profiles' });

  assert(result.includes('Profiles'));
});

test('appendResourceLinks — includes optional description in meta', () => {
  const content = 'Test content';
  const uri = 'gemini://sessions';
  const result = appendResourceLinks(content, uri, {
    description: 'Session transcript',
  });

  assert(result.includes('Session transcript'));
});

test('appendResourceLinks — includes optional mimeType in meta', () => {
  const content = 'Test content';
  const uri = 'assistant://discover/catalog';
  const result = appendResourceLinks(content, uri, { mimeType: 'text/markdown' });

  assert(result.includes('text/markdown'));
});

test('appendResourceLinks — preserves original content unchanged', () => {
  const content = '# Title\n\nSome content\nWith multiple\nLines';
  const uri = 'assistant://instructions';
  const result = appendResourceLinks(content, uri);

  assert(result.startsWith(content));
  assert(result.split('_meta')[0] === `${content}\n\n`);
});

test('appendResourceLinks — handles special characters in URI', () => {
  const content = 'Content';
  const uri = 'gemini://session/abc%20def/transcript';
  const result = appendResourceLinks(content, uri);

  assert(result.includes('abc%20def'));
});

// ────────────────────────────────────────────────────────────────────────────
// buildResourceMeta tests
// ────────────────────────────────────────────────────────────────────────────

test('buildResourceMeta — returns object with required fields', () => {
  const meta = buildResourceMeta({});

  assert(meta.generatedAt);
  assert.strictEqual(meta.source, 'gemini-assistant');
  assert.strictEqual(meta.cached, false);
});

test('buildResourceMeta — sets generatedAt to current time if not provided', () => {
  const before = new Date().toISOString();
  const meta = buildResourceMeta({});
  const after = new Date().toISOString();

  assert(meta.generatedAt >= before);
  assert(meta.generatedAt <= after);
});

test('buildResourceMeta — uses provided generatedAt if given', () => {
  const timestamp = '2026-01-15T10:30:00Z';
  const meta = buildResourceMeta({ generatedAt: timestamp });

  assert.strictEqual(meta.generatedAt, timestamp);
});

test('buildResourceMeta — includes cached field', () => {
  const meta = buildResourceMeta({ cached: true });

  assert.strictEqual(meta.cached, true);
});

test('buildResourceMeta — includes ttlMs when provided', () => {
  const meta = buildResourceMeta({ ttlMs: 300000 });

  assert.strictEqual(meta.ttlMs, 300000);
});

test('buildResourceMeta — includes size when provided', () => {
  const meta = buildResourceMeta({ size: 12345 });

  assert.strictEqual(meta.size, 12345);
});

test('buildResourceMeta — does not include ttlMs when not provided', () => {
  const meta = buildResourceMeta({});

  assert.strictEqual(meta.ttlMs, undefined);
});

test('buildResourceMeta — does not include size when not provided', () => {
  const meta = buildResourceMeta({});

  assert.strictEqual(meta.size, undefined);
});

test('buildResourceMeta — adds self link when selfUri provided', () => {
  const uri = 'assistant://discover/catalog';
  const meta = buildResourceMeta({ selfUri: uri });

  assert(meta.links);
  assert(meta.links.self);
  assert.strictEqual(meta.links.self.uri, uri);
});

test('buildResourceMeta — throws error for invalid source', () => {
  assert.throws(
    () => {
      buildResourceMeta({ source: 'invalid-source' });
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('Invalid source');
    },
  );
});

test('buildResourceMeta — accepts valid source', () => {
  const meta = buildResourceMeta({ source: 'gemini-assistant' });

  assert.strictEqual(meta.source, 'gemini-assistant');
});

// ────────────────────────────────────────────────────────────────────────────
// validateScanPath tests
// ────────────────────────────────────────────────────────────────────────────

test('validateScanPath — accepts valid relative paths', () => {
  assert.doesNotThrow(() => {
    validateScanPath('src/foo.ts');
  });
});

test('validateScanPath — accepts relative paths with leading slash', () => {
  assert.doesNotThrow(() => {
    validateScanPath('/src/foo.ts');
  });
});

test('validateScanPath — accepts nested relative paths', () => {
  assert.doesNotThrow(() => {
    validateScanPath('src/lib/utils/helpers.ts');
  });
});

test('validateScanPath — rejects empty path', () => {
  assert.throws(
    () => {
      validateScanPath('');
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('empty');
    },
  );
});

test('validateScanPath — rejects path traversal with ../', () => {
  assert.throws(
    () => {
      validateScanPath('../etc/passwd');
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('traversal');
    },
  );
});

test('validateScanPath — rejects path traversal with backslashes', () => {
  assert.throws(
    () => {
      validateScanPath('..\\etc\\passwd');
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('traversal');
    },
  );
});

test('validateScanPath — rejects leading traversal in nested path', () => {
  assert.throws(
    () => {
      validateScanPath('src/../../../etc/passwd');
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('traversal');
    },
  );
});

test('validateScanPath — rejects Windows absolute paths', () => {
  assert.throws(
    () => {
      validateScanPath('C:\\Windows\\System32');
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('workspace-relative');
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// normalizeWorkspacePath tests
// ────────────────────────────────────────────────────────────────────────────

test('normalizeWorkspacePath — adds leading slash to relative path', () => {
  const result = normalizeWorkspacePath('src/foo.ts');

  assert.strictEqual(result, '/src/foo.ts');
});

test('normalizeWorkspacePath — preserves leading slash', () => {
  const result = normalizeWorkspacePath('/src/foo.ts');

  assert.strictEqual(result, '/src/foo.ts');
});

test('normalizeWorkspacePath — converts backslashes to forward slashes', () => {
  const result = normalizeWorkspacePath('src\\foo.ts');

  assert.strictEqual(result, '/src/foo.ts');
});

test('normalizeWorkspacePath — converts Windows path to canonical form', () => {
  const result = normalizeWorkspacePath('C:\\src\\foo.ts');

  assert.strictEqual(result, '/src/foo.ts');
});

test('normalizeWorkspacePath — handles multiple backslashes', () => {
  const result = normalizeWorkspacePath('src\\\\lib\\\\foo.ts');

  assert.strictEqual(result, '/src/lib/foo.ts');
});

test('normalizeWorkspacePath — handles multiple forward slashes', () => {
  const result = normalizeWorkspacePath('src//lib//foo.ts');

  assert.strictEqual(result, '/src/lib/foo.ts');
});

test('normalizeWorkspacePath — removes trailing slash', () => {
  const result = normalizeWorkspacePath('src/lib/');

  assert.strictEqual(result, '/src/lib');
});

test('normalizeWorkspacePath — handles root case', () => {
  const result = normalizeWorkspacePath('');

  assert.strictEqual(result, '/');
});

test('normalizeWorkspacePath — handles root path', () => {
  const result = normalizeWorkspacePath('/');

  assert.strictEqual(result, '/');
});

test('normalizeWorkspacePath — handles complex Windows path', () => {
  const result = normalizeWorkspacePath('C:\\Users\\test\\project\\src\\index.ts');

  assert.strictEqual(result, '/Users/test/project/src/index.ts');
});

test('normalizeWorkspacePath — handles single file name', () => {
  const result = normalizeWorkspacePath('README.md');

  assert.strictEqual(result, '/README.md');
});

test('normalizeWorkspacePath — handles paths with dots', () => {
  const result = normalizeWorkspacePath('src/lib.utils/foo.ts');

  assert.strictEqual(result, '/src/lib.utils/foo.ts');
});
