import assert from 'node:assert';
import { test } from 'node:test';

import {
  isPathWithinRoot,
  isPublicHttpUrl,
  normalizeWorkspacePath,
  parseAllowedHosts,
  validateHostHeader,
  validateScanPath,
} from '../../src/lib/validation.js';

test('isPathWithinRoot — path within root returns true', () => {
  const result = isPathWithinRoot('/root/path/file.txt', '/root');
  assert.strictEqual(result, true);
});

test('isPathWithinRoot — path with ../ traversal rejected', () => {
  const result = isPathWithinRoot('/root/../etc/passwd', '/root');
  assert.strictEqual(result, false);
});

test('parseAllowedHosts — returns allowed hosts from env', () => {
  const hosts = parseAllowedHosts();
  // May be undefined or an array
  assert(hosts === undefined || Array.isArray(hosts));
});

test('validateHostHeader — host in allowlist passes', () => {
  const allowed = validateHostHeader('example.com', ['example.com']);
  assert.strictEqual(allowed, true);
});

test('validateHostHeader — host not in allowlist fails', () => {
  const allowed = validateHostHeader('untrusted.com', ['example.com']);
  assert.strictEqual(allowed, false);
});

test('validateHostHeader — null header and empty allowlist', () => {
  const allowed = validateHostHeader(null, []);
  assert.strictEqual(allowed, false);
});

test('isPublicHttpUrl — http URL passes', () => {
  const valid = isPublicHttpUrl('http://example.com');
  assert.strictEqual(valid, true);
});

test('isPublicHttpUrl — https URL passes', () => {
  const valid = isPublicHttpUrl('https://example.com');
  assert.strictEqual(valid, true);
});

test('isPublicHttpUrl — non-http URL fails', () => {
  const valid = isPublicHttpUrl('ftp://example.com');
  assert.strictEqual(valid, false);
});

test('isPublicHttpUrl — relative path fails', () => {
  const valid = isPublicHttpUrl('/path/to/file');
  assert.strictEqual(valid, false);
});

// validateScanPath tests

// normalizeWorkspacePath tests

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
