import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Set dummy API key so client.ts doesn't throw
process.env.API_KEY ??= 'test-key-for-file-upload';

const { deleteUploadedFiles, uploadFile } = await import('../../src/lib/file-upload.js');
const { ai } = await import('../../src/client.js');

describe('deleteUploadedFiles', () => {
  it('is a no-op for empty array', async () => {
    // Should not throw or call anything
    await deleteUploadedFiles([]);
  });

  it('calls ai.files.delete for each name', async () => {
    const deleted: string[] = [];
    const original = ai.files.delete.bind(ai.files);
    ai.files.delete = async (opts: { name: string }) => {
      deleted.push(opts.name);
    };

    try {
      await deleteUploadedFiles(['file-a', 'file-b']);
      assert.deepStrictEqual(deleted, ['file-a', 'file-b']);
    } finally {
      ai.files.delete = original;
    }
  });

  it('handles partial failures without throwing', async () => {
    let callCount = 0;
    const original = ai.files.delete.bind(ai.files);
    ai.files.delete = async () => {
      callCount++;
      if (callCount === 1) throw new Error('network failure');
      // second call succeeds
    };

    try {
      // Should not throw even though the first delete fails
      await deleteUploadedFiles(['fail-file', 'ok-file']);
      assert.strictEqual(callCount, 2);
    } finally {
      ai.files.delete = original;
    }
  });
});

describe('uploadFile', () => {
  it('rejects relative paths', async () => {
    const controller = new AbortController();
    await assert.rejects(() => uploadFile('relative/path.txt', controller.signal), {
      message: /Path must be absolute/,
    });
  });

  it('rejects paths outside allowed roots', async () => {
    const controller = new AbortController();
    // Use a path that's absolute but outside any allowed root
    const outsidePath =
      process.platform === 'win32' ? 'Z:\\nonexistent\\outside\\file.txt' : '/tmp/outside/file.txt';

    await assert.rejects(() => uploadFile(outsidePath, controller.signal), {
      message: /outside allowed directories/,
    });
  });
});
