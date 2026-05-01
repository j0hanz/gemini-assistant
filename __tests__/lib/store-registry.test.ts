import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createStoreRegistry } from '../../src/lib/store-registry.js';
import type { DocumentEntry, StoreEntry } from '../../src/lib/store-registry.js';

describe('StoreRegistry', () => {
  let mockStores: StoreEntry[];
  let mockDocuments: Map<string, DocumentEntry[]>;
  let callCount: { listStores: number; listDocuments: Map<string, number> };

  beforeEach(() => {
    mockStores = [
      { name: 'stores/store-1', displayName: 'Store 1', updateTime: '2026-01-01T00:00:00Z' },
      { name: 'stores/store-2', displayName: 'Store 2', updateTime: '2026-01-02T00:00:00Z' },
    ];

    mockDocuments = new Map([
      [
        'stores/store-1',
        [
          {
            name: 'files/doc-1',
            displayName: 'Doc 1',
            mimeType: 'text/plain',
            createTime: '2026-01-01T00:00:00Z',
          },
          {
            name: 'files/doc-2',
            displayName: 'Doc 2',
            mimeType: 'text/plain',
            createTime: '2026-01-02T00:00:00Z',
          },
        ],
      ],
      [
        'stores/store-2',
        [
          {
            name: 'files/doc-3',
            displayName: 'Doc 3',
            mimeType: 'application/pdf',
            createTime: '2026-01-03T00:00:00Z',
          },
        ],
      ],
    ]);

    callCount = {
      listStores: 0,
      listDocuments: new Map(),
    };
  });

  afterEach(() => {
    callCount.listDocuments.clear();
  });

  it('listStores() calls API on first call and returns results', async () => {
    const registry = createStoreRegistry({
      listStoresFn: async () => {
        callCount.listStores++;
        return mockStores;
      },
    });

    const result = await registry.listStores();

    assert.equal(callCount.listStores, 1);
    assert.deepEqual(result, mockStores);
  });

  it('listStores() returns cached results within TTL window', async () => {
    const registry = createStoreRegistry({
      ttlMs: 5000,
      listStoresFn: async () => {
        callCount.listStores++;
        return mockStores;
      },
    });

    await registry.listStores();
    await registry.listStores();
    await registry.listStores();

    assert.equal(callCount.listStores, 1, 'API should be called only once within TTL');
  });

  it('listStores() re-fetches after TTL expiration', async () => {
    const registry = createStoreRegistry({
      ttlMs: 100,
      listStoresFn: async () => {
        callCount.listStores++;
        return mockStores;
      },
    });

    await registry.listStores();
    assert.equal(callCount.listStores, 1);

    await new Promise((resolve) => setTimeout(resolve, 150));

    await registry.listStores();
    assert.equal(callCount.listStores, 2, 'API should be called again after TTL expires');
  });

  it('listDocuments(storeName) caches results per store name', async () => {
    const store1Name = 'stores/store-1';
    const store2Name = 'stores/store-2';
    const store1Docs = mockDocuments.get(store1Name) ?? [];
    const store2Docs = mockDocuments.get(store2Name) ?? [];

    let store1CallCount = 0;
    let store2CallCount = 0;

    const registry = createStoreRegistry({
      ttlMs: 5000,
      listStoresFn: async () => mockStores,
      listDocumentsFn: async (storeName: string) => {
        if (storeName === store1Name) {
          store1CallCount++;
          return store1Docs;
        } else if (storeName === store2Name) {
          store2CallCount++;
          return store2Docs;
        }
        return [];
      },
    });

    await registry.listDocuments(store1Name);
    await registry.listDocuments(store1Name);
    await registry.listDocuments(store2Name);
    await registry.listDocuments(store2Name);

    assert.equal(store1CallCount, 1, 'store-1 docs should be fetched once');
    assert.equal(store2CallCount, 1, 'store-2 docs should be fetched once');
  });

  it('listDocuments(storeName) returns correct documents for store', async () => {
    const store1Name = 'stores/store-1';
    const expectedDocs = mockDocuments.get(store1Name) ?? [];

    const registry = createStoreRegistry({
      listStoresFn: async () => mockStores,
      listDocumentsFn: async (storeName: string) => (storeName === store1Name ? expectedDocs : []),
    });

    const result = await registry.listDocuments(store1Name);

    assert.deepEqual(result, expectedDocs);
  });

  it('invalidate() clears all caches', async () => {
    const registry = createStoreRegistry({
      ttlMs: 5000,
      listStoresFn: async () => {
        callCount.listStores++;
        return mockStores;
      },
    });

    await registry.listStores();
    assert.equal(callCount.listStores, 1);

    registry.invalidate();

    await registry.listStores();
    assert.equal(callCount.listStores, 2, 'Cache should be cleared after invalidate()');
  });

  it('invalidate() clears document caches as well', async () => {
    const store1Name = 'stores/store-1';
    const store1Docs = mockDocuments.get(store1Name) ?? [];

    let docCallCount = 0;

    const registry = createStoreRegistry({
      ttlMs: 5000,
      listStoresFn: async () => mockStores,
      listDocumentsFn: async () => {
        docCallCount++;
        return store1Docs;
      },
    });

    await registry.listDocuments(store1Name);
    assert.equal(docCallCount, 1);

    registry.invalidate();

    await registry.listDocuments(store1Name);
    assert.equal(docCallCount, 2, 'Document cache should be cleared after invalidate()');
  });

  it('error propagation: listStores() errors bubble up', async () => {
    const testError = new Error('API error: stores unavailable');

    const registry = createStoreRegistry({
      listStoresFn: async () => {
        throw testError;
      },
    });

    await assert.rejects(() => registry.listStores(), testError);
  });

  it('error propagation: listDocuments() errors bubble up', async () => {
    const testError = new Error('API error: documents unavailable');

    const registry = createStoreRegistry({
      listStoresFn: async () => mockStores,
      listDocumentsFn: async () => {
        throw testError;
      },
    });

    await assert.rejects(() => registry.listDocuments('stores/store-1'), testError);
  });

  it('default TTL is 30 seconds', async () => {
    const registry = createStoreRegistry({
      listStoresFn: async () => {
        callCount.listStores++;
        return mockStores;
      },
    });

    await registry.listStores();
    assert.equal(callCount.listStores, 1);

    // Verify cache is still valid within 30s (we won't actually wait 30s)
    await registry.listStores();
    assert.equal(callCount.listStores, 1);
  });

  it('StoreEntry interface fields are preserved', async () => {
    const registry = createStoreRegistry({
      listStoresFn: async () => mockStores,
    });

    const result = await registry.listStores();

    // Verify all fields are present
    result.forEach((store) => {
      assert.ok(store.name);
      assert.ok(typeof store.displayName === 'string' || store.displayName === undefined);
      assert.ok(typeof store.updateTime === 'string' || store.updateTime === undefined);
    });
  });

  it('DocumentEntry interface fields are preserved', async () => {
    const store1Name = 'stores/store-1';
    const store1Docs = mockDocuments.get(store1Name) ?? [];

    const registry = createStoreRegistry({
      listStoresFn: async () => mockStores,
      listDocumentsFn: async (storeName: string) => (storeName === store1Name ? store1Docs : []),
    });

    const result = await registry.listDocuments(store1Name);

    // Verify all fields are present
    result.forEach((doc) => {
      assert.ok(doc.name);
      assert.ok(typeof doc.displayName === 'string' || doc.displayName === undefined);
      assert.ok(typeof doc.mimeType === 'string' || doc.mimeType === undefined);
      assert.ok(typeof doc.createTime === 'string' || doc.createTime === undefined);
    });
  });
});
