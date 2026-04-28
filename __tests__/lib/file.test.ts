import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    const previousFallback = process.env.ROOTS_FALLBACK_CWD;
    process.env.ROOTS_FALLBACK_CWD = 'true';

    client.files.upload = async (opts: { file: Blob | string }) => ({
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
      if (previousFallback === undefined) {
        delete process.env.ROOTS_FALLBACK_CWD;
      } else {
        process.env.ROOTS_FALLBACK_CWD = previousFallback;
      }
    }
  });

  it('rejects paths outside allowed roots', async () => {
    const controller = new AbortController();
    const previousFallback = process.env.ROOTS_FALLBACK_CWD;
    process.env.ROOTS_FALLBACK_CWD = 'true';
    // Use a path that's absolute but outside any allowed root
    const outsidePath =
      process.platform === 'win32' ? 'Z:\\nonexistent\\outside\\file.txt' : '/tmp/outside/file.txt';

    try {
      await assert.rejects(() => uploadFile(outsidePath, controller.signal), {
        message: /outside allowed directories/,
      });
    } finally {
      if (previousFallback === undefined) {
        delete process.env.ROOTS_FALLBACK_CWD;
      } else {
        process.env.ROOTS_FALLBACK_CWD = previousFallback;
      }
    }
  });

  it('rejects incomplete upload handles without a name', async () => {
    const controller = new AbortController();
    const client = getAI();
    const original = client.files.upload.bind(client.files);
    const previousFallback = process.env.ROOTS_FALLBACK_CWD;
    process.env.ROOTS_FALLBACK_CWD = 'true';

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
      if (previousFallback === undefined) {
        delete process.env.ROOTS_FALLBACK_CWD;
      } else {
        process.env.ROOTS_FALLBACK_CWD = previousFallback;
      }
    }
  });

  it('rejects binary content masquerading as a text upload', async () => {
    const controller = new AbortController();
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-file-test-'));
    const filePath = join(tempDir, 'binary.txt');
    writeFileSync(filePath, Buffer.from([0x00, 0xff, 0x10, 0x20]));

    await assert.rejects(() => uploadFile(filePath, controller.signal, async () => [tempDir]), {
      message: /binary data/,
    });
  });

  it('accepts a clean SVG upload', async () => {
    const controller = new AbortController();
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-svg-upload-'));
    const filePath = join(tempDir, 'icon.svg');
    writeFileSync(
      filePath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n',
    );

    const client = getAI();
    const original = client.files.upload.bind(client.files);
    client.files.upload = async () => ({
      uri: 'gs://files/svg-clean',
      mimeType: 'image/svg+xml',
      name: 'uploaded-svg',
    });

    try {
      const result = await uploadFile(filePath, controller.signal, async () => [tempDir]);
      assert.strictEqual(result.mimeType, 'image/svg+xml');
    } finally {
      client.files.upload = original;
    }
  });

  it('rejects an SVG upload containing script content', async () => {
    const controller = new AbortController();
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-svg-script-'));
    const filePath = join(tempDir, 'icon.svg');
    writeFileSync(
      filePath,
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    await assert.rejects(() => uploadFile(filePath, controller.signal, async () => [tempDir]), {
      message: /script content/i,
    });
  });

  it('rejects a non-SVG payload masquerading via .svg extension', async () => {
    const controller = new AbortController();
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-svg-fake-'));
    const filePath = join(tempDir, 'fake.svg');
    writeFileSync(filePath, 'not an svg');

    await assert.rejects(() => uploadFile(filePath, controller.signal, async () => [tempDir]), {
      message: /does not start with <\?xml or <svg/,
    });
  });

  it('rejects sensitive upload paths before invoking Gemini uploads', async () => {
    const controller = new AbortController();
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-sensitive-upload-'));
    const filePath = join(tempDir, '.env');
    writeFileSync(filePath, 'API_KEY=secret\n');

    const client = getAI();
    const original = client.files.upload.bind(client.files);
    let uploadCalled = false;
    client.files.upload = async () => {
      uploadCalled = true;
      return {
        uri: 'gs://files/ignored',
        mimeType: 'text/plain',
        name: 'ignored',
      };
    };

    try {
      await assert.rejects(() => uploadFile(filePath, controller.signal, async () => [tempDir]), {
        message: /sensitive file/i,
      });
      assert.strictEqual(uploadCalled, false);
    } finally {
      client.files.upload = original;
    }
  });

  it('uploads the originally validated bytes even if the file changes before SDK submission', async () => {
    const controller = new AbortController();
    const tempDir = mkdtempSync(join(tmpdir(), 'gemini-upload-buffer-'));
    const filePath = join(tempDir, 'payload.txt');
    writeFileSync(filePath, 'original payload\n');

    const client = getAI();
    const original = client.files.upload.bind(client.files);
    let uploadedText = '';

    client.files.upload = async (opts: { file: Blob | string }) => {
      await writeFileAsync(filePath, 'mutated payload\n');
      uploadedText =
        typeof opts.file === 'string'
          ? await readFileAsync(opts.file, 'utf8')
          : await opts.file.text();

      return {
        uri: 'gs://files/payload',
        mimeType: 'text/plain',
        name: 'payload',
      };
    };

    try {
      await uploadFile(filePath, controller.signal, async () => [tempDir]);
      assert.strictEqual(uploadedText, 'original payload\n');
    } finally {
      client.files.upload = original;
    }
  });
});
