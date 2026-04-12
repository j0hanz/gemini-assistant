import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getMimeType, MAX_FILE_SIZE } from '../../src/lib/file-utils.js';

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
