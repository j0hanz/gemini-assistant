import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IngestInputSchema } from '../../src/schemas/ingest-input.js';

describe('IngestInputSchema', () => {
  describe('create-store operation', () => {
    it('validates with required fields', () => {
      const input = {
        operation: 'create-store',
        storeName: 'my-store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.operation, 'create-store');
        assert.equal(result.data.storeName, 'my-store');
      }
    });

    it('validates with optional displayName', () => {
      const input = {
        operation: 'create-store',
        storeName: 'my-store',
        displayName: 'My Store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.displayName, 'My Store');
      }
    });

    it('rejects when storeName is missing', () => {
      const input = {
        operation: 'create-store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });

    it('rejects unknown fields (strict object)', () => {
      const input = {
        operation: 'create-store',
        storeName: 'my-store',
        extraField: 'should-fail',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });
  });

  describe('upload operation', () => {
    it('validates with required fields', () => {
      const input = {
        operation: 'upload',
        storeName: 'my-store',
        filePath: '/path/to/file.txt',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.operation, 'upload');
        assert.equal(result.data.storeName, 'my-store');
        assert.equal(result.data.filePath, '/path/to/file.txt');
      }
    });

    it('validates with all optional fields', () => {
      const input = {
        operation: 'upload',
        storeName: 'my-store',
        filePath: '/path/to/file.txt',
        displayName: 'My File',
        mimeType: 'text/plain',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.displayName, 'My File');
        assert.equal(result.data.mimeType, 'text/plain');
      }
    });

    it('rejects when filePath is missing', () => {
      const input = {
        operation: 'upload',
        storeName: 'my-store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });

    it('rejects unknown fields (strict object)', () => {
      const input = {
        operation: 'upload',
        storeName: 'my-store',
        filePath: '/path/to/file.txt',
        extraField: 'should-fail',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });
  });

  describe('delete-store operation', () => {
    it('validates with required fields', () => {
      const input = {
        operation: 'delete-store',
        storeName: 'my-store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.operation, 'delete-store');
        assert.equal(result.data.storeName, 'my-store');
      }
    });

    it('rejects unknown fields (strict object)', () => {
      const input = {
        operation: 'delete-store',
        storeName: 'my-store',
        extraField: 'should-fail',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });
  });

  describe('delete-document operation', () => {
    it('validates with required fields', () => {
      const input = {
        operation: 'delete-document',
        storeName: 'my-store',
        documentName: 'doc-name',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.operation, 'delete-document');
        assert.equal(result.data.storeName, 'my-store');
        assert.equal(result.data.documentName, 'doc-name');
      }
    });

    it('rejects when documentName is missing', () => {
      const input = {
        operation: 'delete-document',
        storeName: 'my-store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });

    it('rejects unknown fields (strict object)', () => {
      const input = {
        operation: 'delete-document',
        storeName: 'my-store',
        documentName: 'doc-name',
        extraField: 'should-fail',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });
  });

  describe('discriminator validation', () => {
    it('rejects unknown operation', () => {
      const input = {
        operation: 'unknown-op',
        storeName: 'my-store',
      };
      const result = IngestInputSchema.safeParse(input);
      assert.equal(result.success, false);
    });
  });

  describe('store name validation', () => {
    it('rejects invalid store names', () => {
      const invalidNames = ['', ' ', 'store@invalid', 'store#bad'];
      invalidNames.forEach((name) => {
        const input = {
          operation: 'create-store',
          storeName: name,
        };
        const result = IngestInputSchema.safeParse(input);
        assert.equal(result.success, false, `Should reject store name: "${name}"`);
      });
    });

    it('accepts valid store names', () => {
      const validNames = ['my-store', 'my_store', 'store123', 'my/sub/store'];
      validNames.forEach((name) => {
        const input = {
          operation: 'create-store',
          storeName: name,
        };
        const result = IngestInputSchema.safeParse(input);
        assert.equal(result.success, true, `Should accept store name: "${name}"`);
      });
    });
  });
});
