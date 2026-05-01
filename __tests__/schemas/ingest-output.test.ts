import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IngestOutputSchema } from '../../src/schemas/ingest-output.js';

describe('IngestOutputSchema', () => {
  describe('valid output', () => {
    it('validates with all fields', () => {
      const output = {
        operation: 'upload',
        storeName: 'my-store',
        documentName: 'doc-123',
        message: 'File uploaded successfully',
        structuredContent: {
          operation: 'upload',
          storeName: 'my-store',
          documentName: 'doc-123',
          message: 'File uploaded successfully',
        },
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

    it('validates with structuredContent', () => {
      const output = {
        operation: 'delete-store',
        storeName: 'my-store',
        message: 'Store deleted',
        structuredContent: {
          operation: 'delete-store',
          storeName: 'my-store',
          message: 'Store deleted',
        },
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, true);
      if (result.success) {
        assert.ok(result.data.structuredContent);
        assert.equal(result.data.structuredContent.operation, 'delete-store');
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
    it('allows any string for operation field', () => {
      const output = {
        operation: 'custom-operation',
        message: 'Operation completed',
      };
      const result = IngestOutputSchema.safeParse(output);
      assert.equal(result.success, true);
    });
  });
});
