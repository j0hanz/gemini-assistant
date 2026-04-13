import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveAndValidatePath } from '../../src/lib/path-validation.js';

describe('resolveAndValidatePath', () => {
  it('rejects relative paths', async () => {
    await assert.rejects(() => resolveAndValidatePath('relative/path.txt'), {
      message: /must be absolute/,
    });
  });

  it('rejects relative dot paths', async () => {
    await assert.rejects(() => resolveAndValidatePath('./file.txt'), {
      message: /must be absolute/,
    });
  });

  it('accepts absolute paths under cwd', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const result = await resolveAndValidatePath(testPath);
    assert.ok(result.endsWith('package.json'));
  });

  it('rejects paths outside allowed roots', async () => {
    // Use a path that is definitely outside cwd
    const outsidePath =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
    // Only test if this is actually outside cwd
    const cwd = process.cwd().toLowerCase();
    if (!outsidePath.toLowerCase().startsWith(cwd)) {
      await assert.rejects(() => resolveAndValidatePath(outsidePath), {
        message: /outside allowed directories/,
      });
    }
  });

  it('resolves normalized paths', async () => {
    const testPath = join(process.cwd(), 'src', '..', 'package.json');
    const result = await resolveAndValidatePath(testPath);
    // Should resolve to the actual path without ..
    assert.ok(!result.includes('..'));
    assert.ok(result.endsWith('package.json'));
  });

  it('handles non-existent files under allowed root gracefully', async () => {
    const testPath = join(process.cwd(), 'nonexistent-test-file-12345.txt');
    // Should not throw — just validate it's under allowed root
    const result = await resolveAndValidatePath(testPath);
    assert.ok(result.includes('nonexistent-test-file-12345.txt'));
  });

  it('uses rootsFetcher roots when provided', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const fetcher = async () => [process.cwd()];
    const result = await resolveAndValidatePath(testPath, fetcher);
    assert.ok(result.endsWith('package.json'));
  });

  it('rejects path outside rootsFetcher roots', async () => {
    const outsidePath =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
    const fetcher = async () => [process.cwd()];
    await assert.rejects(() => resolveAndValidatePath(outsidePath, fetcher), {
      message: /outside allowed directories/,
    });
  });

  it('falls back to env roots when rootsFetcher returns empty', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const fetcher = async () => [] as string[];
    const result = await resolveAndValidatePath(testPath, fetcher);
    assert.ok(result.endsWith('package.json'));
  });

  it('falls back to env roots when rootsFetcher throws', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const fetcher = async () => {
      throw new Error('client does not support roots');
    };
    const result = await resolveAndValidatePath(testPath, fetcher);
    assert.ok(result.endsWith('package.json'));
  });
});
