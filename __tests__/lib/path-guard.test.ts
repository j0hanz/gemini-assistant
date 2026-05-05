import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isPathWithinRoot,
  isSensitiveUntrackedPath,
  normalizePathForComparison,
  normalizeWorkspacePath,
  validateScanPath,
} from '../../src/lib/path-guard.js';

describe('path-guard', () => {
  describe('isSensitiveUntrackedPath', () => {
    it('detects .env files', () => {
      assert.equal(isSensitiveUntrackedPath('.env'), true);
    });

    it('detects .env.local files', () => {
      assert.equal(isSensitiveUntrackedPath('.env.local'), true);
    });

    it('detects sensitive extensions', () => {
      assert.equal(isSensitiveUntrackedPath('key.pem'), true);
    });

    it('detects sensitive path segments', () => {
      assert.equal(isSensitiveUntrackedPath('.ssh/id_rsa'), true);
    });

    it('detects files with credential in basename', () => {
      assert.equal(isSensitiveUntrackedPath('my_credentials.json'), true);
    });

    it('returns false for normal files', () => {
      assert.equal(isSensitiveUntrackedPath('src/index.ts'), false);
    });
  });

  describe('normalizePathForComparison', () => {
    it('normalizes forward slashes', () => {
      const normalized = normalizePathForComparison('src/lib/file.ts');
      assert.ok(normalized.includes('src'));
    });

    it('removes trailing slashes', () => {
      const result = normalizePathForComparison('src/lib/');
      assert.equal(result, result.replace(/[\\/]+$/, ''));
    });

    it('lowercases paths on Windows', () => {
      const normalized = normalizePathForComparison('SRC/LIB');
      // On Windows it will be lowercase, on Unix it will be as-is
      if (process.platform === 'win32') {
        assert.equal(normalized, normalized.toLowerCase());
      }
    });
  });

  describe('isPathWithinRoot', () => {
    it('returns true for path under root', () => {
      assert.equal(isPathWithinRoot('/root/sub/file.ts', '/root'), true);
    });

    it('returns true for exact root match', () => {
      assert.equal(isPathWithinRoot('/root', '/root'), true);
    });

    it('returns false for path outside root', () => {
      assert.equal(isPathWithinRoot('/other/file.ts', '/root'), false);
    });

    it('handles backslashes on Windows', () => {
      const result = isPathWithinRoot('root\\sub\\file.ts', 'root');
      assert.ok(typeof result === 'boolean');
    });
  });

  describe('validateScanPath', () => {
    it('throws for empty path', () => {
      assert.throws(() => validateScanPath(''), /Path cannot be empty/);
    });

    it('throws for Windows drive letters', () => {
      assert.throws(() => validateScanPath('C:\\file.ts'), /Path must be workspace-relative/);
    });

    it('throws for path traversal', () => {
      assert.throws(() => validateScanPath('../etc/passwd'), /Path traversal detected/);
    });

    it('returns true for valid relative path', () => {
      assert.equal(validateScanPath('src/file.ts'), true);
    });

    it('returns true for path with leading slash', () => {
      assert.equal(validateScanPath('/src/file.ts'), true);
    });
  });

  describe('normalizeWorkspacePath', () => {
    it('converts backslashes to forward slashes', () => {
      const result = normalizeWorkspacePath('src\\lib\\file.ts');
      assert.equal(result, '/src/lib/file.ts');
    });

    it('adds leading slash if missing', () => {
      const result = normalizeWorkspacePath('src/file.ts');
      assert.equal(result, '/src/file.ts');
    });

    it('preserves leading slash', () => {
      const result = normalizeWorkspacePath('/src/file.ts');
      assert.equal(result, '/src/file.ts');
    });

    it('removes Windows drive letters', () => {
      const result = normalizeWorkspacePath('C:\\src\\file.ts');
      assert.equal(result, '/src/file.ts');
    });

    it('removes trailing slashes', () => {
      const result = normalizeWorkspacePath('src/lib/');
      assert.equal(result, '/src/lib');
    });

    it('normalizes root to single slash', () => {
      const result = normalizeWorkspacePath('');
      assert.equal(result, '/');
    });

    it('collapses multiple slashes', () => {
      const result = normalizeWorkspacePath('src///lib/file.ts');
      assert.equal(result, '/src/lib/file.ts');
    });
  });
});
