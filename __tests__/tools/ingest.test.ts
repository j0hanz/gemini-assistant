import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { IngestInputSchema } from '../../src/schemas/ingest-input.js';
import type { IngestInput } from '../../src/schemas/ingest-input.js';

test('ingest schema: create-store operation validates correctly', () => {
  const input: IngestInput = {
    operation: 'create-store',
    storeName: 'my-store',
    displayName: 'My Store',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.ok(result.success);
  if (result.success) {
    assert.strictEqual(result.data.operation, 'create-store');
    assert.strictEqual(result.data.storeName, 'my-store');
  }
});

test('ingest schema: create-store requires storeName', () => {
  const input = {
    operation: 'create-store',
    displayName: 'My Store',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.strictEqual(result.success, false);
});

test('ingest schema: upload operation validates correctly', () => {
  const input: IngestInput = {
    operation: 'upload',
    storeName: 'my-store',
    filePath: '/test-file.txt',
    displayName: 'Test File',
    mimeType: 'text/plain',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.ok(result.success);
  if (result.success) {
    assert.strictEqual(result.data.operation, 'upload');
    assert.strictEqual(result.data.storeName, 'my-store');
    assert.strictEqual(result.data.filePath, '/test-file.txt');
  }
});

test('ingest schema: upload requires filePath', () => {
  const input = {
    operation: 'upload',
    storeName: 'my-store',
    displayName: 'Test File',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.strictEqual(result.success, false);
});

test('ingest schema: upload with default mimeType', () => {
  const input: IngestInput = {
    operation: 'upload',
    storeName: 'my-store',
    filePath: '/test-file.txt',
    // mimeType not provided
  };

  const result = IngestInputSchema.safeParse(input);
  assert.ok(result.success);
  if (result.success) {
    assert.strictEqual(result.data.mimeType, undefined);
  }
});

test('ingest schema: delete-store operation validates correctly', () => {
  const input: IngestInput = {
    operation: 'delete-store',
    storeName: 'my-store',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.ok(result.success);
  if (result.success) {
    assert.strictEqual(result.data.operation, 'delete-store');
    assert.strictEqual(result.data.storeName, 'my-store');
  }
});

test('ingest schema: delete-store requires storeName', () => {
  const input = {
    operation: 'delete-store',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.strictEqual(result.success, false);
});

test('ingest schema: delete-document operation validates correctly', () => {
  const input: IngestInput = {
    operation: 'delete-document',
    storeName: 'my-store',
    documentName: 'documents/test-doc-id',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.ok(result.success);
  if (result.success) {
    assert.strictEqual(result.data.operation, 'delete-document');
    assert.strictEqual(result.data.storeName, 'my-store');
    assert.strictEqual(result.data.documentName, 'documents/test-doc-id');
  }
});

test('ingest schema: delete-document requires documentName', () => {
  const input = {
    operation: 'delete-document',
    storeName: 'my-store',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.strictEqual(result.success, false);
});

test('ingest schema: rejects invalid operation', () => {
  const input = {
    operation: 'invalid-op',
    storeName: 'my-store',
  };

  const result = IngestInputSchema.safeParse(input);
  assert.strictEqual(result.success, false);
});
