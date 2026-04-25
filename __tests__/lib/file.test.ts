import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { getMimeType, MAX_FILE_SIZE } from '../../src/lib/file.js';

// Set dummy API key so client.ts doesn't throw
process.env.API_KEY ??= 'test-key-for-file-upload';

const fileModule: typeof import('../../src/lib/file.js') = await import('../../src/lib/file.js');
const { deleteUploadedFiles, uploadFile, withUploadedFilesCleanup } = fileModule;
const { getAI } = await import('../../src/client.js');

// ── MIME / Size ───────────────────────────────────────────────────────

describe('MAX_FILE_SIZE', () => {
  it('is 20 MB', () => {
    assert.strictEqual(MAX_FILE_SIZE, 20 * 1024 * 1024);
  });
});

describe('getMimeType', () => {
  it('returns correct MIME for PDF', () => {
    assert.strictEqual(getMimeType('/docs/report.pdf'), 'application/pdf');
  });

  it('returns correct MIME for PNG', () => {
    assert.strictEqual(getMimeType('screenshot.png'), 'image/png');
  });

  it('returns correct MIME for JPG', () => {
    assert.strictEqual(getMimeType('photo.jpg'), 'image/jpeg');
  });

  it('returns correct MIME for JPEG', () => {
    assert.strictEqual(getMimeType('photo.jpeg'), 'image/jpeg');
  });

  it('returns correct MIME for JSON', () => {
    assert.strictEqual(getMimeType('data.json'), 'application/json');
  });

  it('returns correct MIME for TypeScript', () => {
    assert.strictEqual(getMimeType('index.ts'), 'text/plain');
  });

  it('returns correct MIME for JavaScript', () => {
    assert.strictEqual(getMimeType('index.js'), 'text/javascript');
  });

  it('returns correct MIME for Python', () => {
    assert.strictEqual(getMimeType('script.py'), 'text/plain');
  });

  it('returns correct MIME for CSV', () => {
    assert.strictEqual(getMimeType('data.csv'), 'text/csv');
  });

  it('returns correct MIME for MP4', () => {
    assert.strictEqual(getMimeType('video.mp4'), 'video/mp4');
  });

  it('returns correct MIME for MP3', () => {
    assert.strictEqual(getMimeType('audio.mp3'), 'audio/mpeg');
  });

  it('returns correct MIME for YAML', () => {
    assert.strictEqual(getMimeType('config.yaml'), 'text/plain');
  });

  it('returns correct MIME for DOCX', () => {
    assert.strictEqual(
      getMimeType('doc.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('returns octet-stream for unknown extension', () => {
    assert.strictEqual(getMimeType('file.unknown'), 'application/octet-stream');
  });

  it('returns octet-stream for no extension', () => {
    assert.strictEqual(getMimeType('Makefile'), 'application/octet-stream');
  });

  it('is case-insensitive for extensions', () => {
    assert.strictEqual(getMimeType('IMAGE.PNG'), 'image/png');
    assert.strictEqual(getMimeType('doc.PDF'), 'application/pdf');
  });
});

// ── File Upload ───────────────────────────────────────────────────────

describe('deleteUploadedFiles', () => {
  it('is a no-op for empty array', async () => {
    // Should not throw or call anything
    await deleteUploadedFiles([]);
  });

  it('calls getAI().files.delete for each name', async () => {
    const deleted: string[] = [];
    const client = getAI();
    const original = client.files.delete.bind(client.files);
    // @ts-expect-error mock override for testing
    client.files.delete = async (opts: { name: string }) => {
      deleted.push(opts.name);
    };

    try {
      await deleteUploadedFiles(['file-a', 'file-b']);
      assert.deepStrictEqual(deleted, ['file-a', 'file-b']);
    } finally {
      client.files.delete = original;
    }
  });

  it('handles partial failures without throwing', async () => {
    let callCount = 0;
    const client = getAI();
    const original = client.files.delete.bind(client.files);
    // @ts-expect-error mock override for testing
    client.files.delete = async () => {
      callCount++;
      if (callCount === 1) throw new Error('network failure');
      // second call succeeds
    };

    try {
      // Should not throw even though the first delete fails
      await deleteUploadedFiles(['fail-file', 'ok-file']);
      assert.strictEqual(callCount, 2);
    } finally {
      client.files.delete = original;
    }
  });
});

describe('withUploadedFilesCleanup', () => {
  function makeContext() {
    const logs: { level: string; message: string }[] = [];
    return {
      ctx: {
        mcpReq: {
          log: async (level: string, message: string) => {
            logs.push({ level, message });
          },
        },
      } as never,
      logs,
    };
  }

  it('deletes tracked uploads in insertion order after success', async () => {
    const deleted: string[] = [];
    const client = getAI();
    const original = client.files.delete.bind(client.files);
    const { ctx } = makeContext();

    // @ts-expect-error mock override for testing
    client.files.delete = async (opts: { name: string }) => {
      deleted.push(opts.name);
    };

    try {
      const result = await withUploadedFilesCleanup(ctx, async (uploads) => {
        uploads.addName('file-a');
        uploads.addUploadedFile({ name: 'file-b' });
        return 'ok';
      });

      assert.strictEqual(result, 'ok');
      assert.deepStrictEqual(deleted, ['file-a', 'file-b']);
    } finally {
      client.files.delete = original;
    }
  });

  it('cleans up tracked uploads and logs cleanup failures when the operation throws', async () => {
    const deleted: string[] = [];
    const client = getAI();
    const original = client.files.delete.bind(client.files);
    const { ctx, logs } = makeContext();

    // @ts-expect-error mock override for testing
    client.files.delete = async (opts: { name: string }) => {
      deleted.push(opts.name);
      if (opts.name === 'file-a') {
        throw new Error('delete failed');
      }
    };

    try {
      await assert.rejects(
        () =>
          withUploadedFilesCleanup(ctx, async (uploads) => {
            uploads.addName('file-a');
            uploads.addName('file-b');
            throw new Error('operation failed');
          }),
        { message: 'operation failed' },
      );

      assert.deepStrictEqual(deleted, ['file-a', 'file-b']);
      assert.deepStrictEqual(logs, [
        { level: 'warning', message: 'File cleanup failed: delete failed' },
      ]);
    } finally {
      client.files.delete = original;
    }
  });
});

describe('uploadFile', () => {
  it('accepts relative paths under cwd', async () => {
    const controller = new AbortController();
    const client = getAI();
    const original = client.files.upload.bind(client.files);

    client.files.upload = async (opts: { file: string }) => ({
      uri: 'gs://files/abc',
      mimeType: 'application/json',
      name: 'uploaded-package',
      file: opts.file,
    });

    try {
      const result = await uploadFile('package.json', controller.signal);
      assert.ok(result.path.endsWith('package.json'));
      assert.strictEqual(result.displayPath, 'package.json');
    } finally {
      client.files.upload = original;
    }
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

  it('rejects incomplete upload handles without a name', async () => {
    const controller = new AbortController();
    const client = getAI();
    const original = client.files.upload.bind(client.files);

    client.files.upload = async () => ({
      uri: 'gs://files/abc',
      mimeType: 'text/plain',
      name: '',
    });

    try {
      await assert.rejects(
        () => uploadFile(join(process.cwd(), 'package.json'), controller.signal),
        {
          message: /incomplete file handle/,
        },
      );
    } finally {
      client.files.upload = original;
    }
  });
});
