import type { CallToolResult } from '@modelcontextprotocol/server';

import { strict as assert } from 'node:assert';
import { dirname, relative } from 'node:path';
import { test } from 'node:test';

import { safeValidateStructuredContent } from '../../src/lib/response.js';
import { IngestInputSchema } from '../../src/schemas/ingest-input.js';
import type { IngestInput } from '../../src/schemas/ingest-input.js';
import { IngestOutputSchema } from '../../src/schemas/ingest-output.js';
import type { IngestOutput } from '../../src/schemas/ingest-output.js';
import { uploadOne } from '../../src/tools/ingest.js';

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

test('ingestWork: seeding structuredContent enables safeValidateStructuredContent to attach it', () => {
  const output: IngestOutput = {
    operation: 'create-store',
    storeName: 'fileSearchStores/abc123',
    message: "Store 'fileSearchStores/abc123' created successfully.",
  };

  // Simulate the pattern ingestWork must use after the fix
  const baseResult: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };

  const validated = safeValidateStructuredContent('ingest', IngestOutputSchema, output, baseResult);

  assert.ok(validated.structuredContent !== undefined, 'structuredContent must be attached');
  const sc = validated.structuredContent as IngestOutput;
  assert.strictEqual(sc.operation, 'create-store');
  assert.strictEqual(sc.storeName, 'fileSearchStores/abc123');
});

test('ingestWork: NOT seeding structuredContent causes safeValidateStructuredContent to skip attachment', () => {
  const output: IngestOutput = {
    operation: 'create-store',
    storeName: 'fileSearchStores/abc123',
    message: "Store 'fileSearchStores/abc123' created successfully.",
  };

  // Simulate the CURRENT (broken) pattern: no structuredContent on the base result
  const baseResult: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    // structuredContent intentionally absent
  };

  const validated = safeValidateStructuredContent('ingest', IngestOutputSchema, output, baseResult);

  assert.strictEqual(
    validated.structuredContent,
    undefined,
    'structuredContent must be absent when not seeded',
  );
});

test('ingest schema: output with created field validates correctly', () => {
  const output: IngestOutput = {
    operation: 'upload',
    storeName: 'fileSearchStores/abc123',
    created: true,
    message: 'Store auto-created and file uploaded successfully.',
  };

  const result = IngestOutputSchema.safeParse(output);
  assert.ok(result.success);
  if (result.success) {
    assert.strictEqual(result.data.operation, 'upload');
    assert.strictEqual(result.data.storeName, 'fileSearchStores/abc123');
    assert.strictEqual(result.data.created, true);
  }
});

test('single-file display name: relative(dirname(target), target) yields basename', () => {
  const target = '/workspace/project/src/config.ts';
  const displayName = relative(dirname(target), target) || target;
  assert.strictEqual(displayName, 'config.ts');
});

test('uploadOne: fails fast when SDK returns no documentName or name', async () => {
  // Mock AI object with uploadToFileSearchStore that returns no documentName or name
  const mockAI = {
    fileSearchStores: {
      uploadToFileSearchStore: async () => ({
        response: undefined, // no documentName
        // no name field either
      }),
    },
  };

  const result = await uploadOne(
    mockAI as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    'fileSearchStores/store-123',
    '/workspace/test-file.txt',
    '/workspace',
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'SDK returned no documentName');
});
