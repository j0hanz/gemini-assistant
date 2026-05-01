import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IngestOutputSchema } from '../../src/schemas/ingest-output.js';

describe('IngestOutputSchema', () => {
  describe('valid output', () => {
    it('validates with all fields', () => {
      const output = {
        operation: 'upload' as const,
        storeName: 'my-store',
        documentName: 'doc-123',
        message: 'File uploaded successfully',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.operation, 'upload');
        assert.equal(result.data.storeName, 'my-store');
        assert.equal(result.data.documentName, 'doc-123');
        assert.equal(result.data.message, 'File uploaded successfully');
      }
    });

    it('validates with minimal required fields', () => {
      const output = {
        operation: 'create-store',
        message: 'Store created',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.operation, 'create-store');
        assert.equal(result.data.message, 'Store created');
        assert.equal(result.data.storeName, undefined);
        assert.equal(result.data.documentName, undefined);
      }
    });

    it('accepts all valid operation enum values', () => {
      for (const op of ['create-store', 'upload', 'delete-store', 'delete-document'] as const) {
        const output = { operation: op, message: 'done' };
        const result = IngestOutputSchema.safeParse(output);
        assert.equal(result.success, true, `expected ${op} to be valid`);
      }
    });

    it('validates without structuredContent', () => {
      const output = {
        operation: 'delete-document',
        storeName: 'my-store',
        documentName: 'doc-456',
        message: 'Document deleted',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, true);
    });
  });

  describe('field requirements', () => {
    it('rejects when operation is missing', () => {
      const output = {
        message: 'Success',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, false);
    });

    it('rejects when message is missing', () => {
      const output = {
        operation: 'create-store',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, false);
    });
  });

  describe('strict object validation', () => {
    it('rejects unknown fields', () => {
      const output = {
        operation: 'upload',
        message: 'Success',
        extraField: 'should-fail',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, false);
    });
  });

  describe('type inference', () => {
  });

  describe('structuredContent and operation enum', () => {
    it('rejects unknown structuredContent field', () => {
      const output = {
        operation: 'upload',
        message: 'done',
        structuredContent: { operation: 'upload', message: 'dup' },
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.strictEqual(result.success, false);
    });

    it('rejects non-enum operation value', () => {
      const output = { operation: 'custom-operation', message: 'done' };
      const result = IngestOutputSchema.safeParse(output);
      assert.strictEqual(result.success, false);
    });
  });
});
