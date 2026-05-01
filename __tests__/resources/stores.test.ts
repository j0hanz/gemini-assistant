import { ProtocolError } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import type { StoreRegistry } from '../../src/lib/store-registry.js';
import { registerStoreResources } from '../../src/resources/stores.js';
import { storeDocumentsUri, STORES_LIST_URI } from '../../src/resources/uris.js';

interface MockServer {
  registerResource: (
    id: string,
    uri: string | Record<string, unknown>,
    opts: unknown,
    handler: (uri: { href: string }) => Promise<unknown>,
  ) => void;
}

test('store resources — registers gemini://stores resources', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [
      { name: 'store1', displayName: 'Store 1' },
      { name: 'store2', displayName: 'Store 2' },
    ],
    listDocuments: async () => [],
    invalidate: () => {},
  };

  const registeredResources: string[] = [];
  const mockServer: MockServer = {
    registerResource: (id: string): void => {
      registeredResources.push(id);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  // Verify resources were registered
  assert(registeredResources.includes('stores-list-gemini'));
  assert(registeredResources.includes('store-documents-gemini'));
});

test('store resources — reads gemini://stores list', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [
      { name: 'store1', displayName: 'Store 1', updateTime: '2026-01-01T00:00:00Z' },
      { name: 'store2', displayName: 'Store 2', updateTime: '2026-01-02T00:00:00Z' },
    ],
    listDocuments: async () => [],
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('stores-list-gemini');
  assert(handler);

  const result = (await handler({ href: STORES_LIST_URI })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert(result.contents.length > 0);

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const stores = JSON.parse(jsonPart) as unknown[];
  assert(Array.isArray(stores));
  assert(stores.length === 2);
  assert(stores[0] && typeof stores[0] === 'object' && 'name' in stores[0]);
});

test('store resources — reads gemini://stores/{storeName}/documents', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [],
    listDocuments: async (storeName: string) => {
      if (storeName === 'store1') {
        return [
          { name: 'doc1', displayName: 'Document 1', mimeType: 'text/plain' },
          { name: 'doc2', displayName: 'Document 2', mimeType: 'application/pdf' },
        ];
      }
      return [];
    },
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('store-documents-gemini');
  assert(handler);

  const uri = storeDocumentsUri('store1');
  const result = (await handler({ href: uri })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert(result.contents.length > 0);

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const documents = JSON.parse(jsonPart) as unknown[];
  assert(Array.isArray(documents));
  assert(documents.length === 2);
  assert(documents[0] && typeof documents[0] === 'object' && 'name' in documents[0]);
});

test('store resources — encodes/decodes store name with special characters', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [],
    listDocuments: async (storeName: string) => {
      if (storeName === 'my store with spaces') {
        return [{ name: 'doc1', displayName: 'Document 1' }];
      }
      return [];
    },
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('store-documents-gemini');
  assert(handler);

  // Build URI with encoded store name
  const uri = storeDocumentsUri('my store with spaces');
  const result = (await handler({ href: uri })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert(result.contents.length > 0);

  // Extract JSON content
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const documents = JSON.parse(jsonPart) as unknown[];
  assert(Array.isArray(documents));
  assert(documents.length === 1);
});

test('store resources — handles registry error when listing stores', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => {
      throw new Error('API error: permission denied');
    },
    listDocuments: async () => [],
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('stores-list-gemini');
  assert(handler);

  await assert.rejects(async () => {
    await handler({ href: STORES_LIST_URI });
  }, ProtocolError);
});

test('store resources — handles registry error when listing documents', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [],
    listDocuments: async () => {
      throw new Error('API error: store not found');
    },
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('store-documents-gemini');
  assert(handler);

  const uri = storeDocumentsUri('nonexistent-store');
  await assert.rejects(async () => {
    await handler({ href: uri });
  }, ProtocolError);
});

test('store resources — rejects missing storeName parameter', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [],
    listDocuments: async () => [],
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('store-documents-gemini');
  assert(handler);

  // URI without storeName parameter
  const invalidUri = `gemini://stores//documents`;
  await assert.rejects(async () => {
    await handler({ href: invalidUri });
  }, ProtocolError);
});

test('store resources — handles invalid percent-encoding in storeName', async () => {
  const mockRegistry: StoreRegistry = {
    listStores: async () => [],
    listDocuments: async () => [],
    invalidate: () => {},
  };

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerStoreResources(mockServer as never, mockRegistry);

  const handler = resourceHandlers.get('store-documents-gemini');
  assert(handler);

  // URI with invalid percent-encoding
  const invalidUri = `gemini://stores/%ZZ/documents`;
  await assert.rejects(async () => {
    await handler({ href: invalidUri });
  }, ProtocolError);
});
