import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';

import type { StoreRegistry } from '../lib/store-registry.js';

import { buildResourceMeta } from './metadata.js';
import { registerStaticResource, registerTemplateResource } from './registry.js';
import { decodeTemplateParam, STORE_DOCUMENTS_TEMPLATE, STORES_LIST_URI } from './uris.js';

/**
 * Parse a URI and extract template parameters.
 * Returns an object with the extracted parameters.
 */
function parseStoreUri(uri: string): { type: 'list' } | { type: 'documents'; storeName: string } {
  // Handle stores list
  if (uri === STORES_LIST_URI) {
    return { type: 'list' };
  }

  // Parse stores/{storeName}/documents URIs
  const documentsMatch = /^gemini:\/\/stores\/([^/]+)\/documents$/.exec(uri);
  if (documentsMatch?.[1]) {
    return { type: 'documents', storeName: documentsMatch[1] };
  }

  throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
}

class StoreResourceHandler {
  constructor(private storeRegistry: StoreRegistry) {}

  async readResource(uri: string): Promise<string> {
    const parsed = parseStoreUri(uri);

    switch (parsed.type) {
      case 'list':
        return this.readStoresList(uri);

      case 'documents':
        return this.readStoreDocuments(uri, parsed.storeName);
    }
  }

  private async readStoresList(uri: string): Promise<string> {
    let stores;
    try {
      stores = await this.storeRegistry.listStores();
    } catch (err) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Failed to list stores: ${String(err)}`,
      );
    }

    const meta = buildResourceMeta({
      cached: true,
      ttlMs: 30_000, // 30 seconds (matches registry TTL)
      size: JSON.stringify(stores).length,
      selfUri: uri,
    });

    return `${JSON.stringify(stores, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
  }

  private async readStoreDocuments(uri: string, encodedStoreName: string): Promise<string> {
    // Decode the store name from URI encoding
    const storeName = decodeTemplateParam(encodedStoreName);
    if (!storeName) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Store name required');
    }

    let documents;
    try {
      documents = await this.storeRegistry.listDocuments(storeName);
    } catch (err) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Failed to list documents in store: ${String(err)}`,
      );
    }

    const meta = buildResourceMeta({
      cached: true,
      ttlMs: 30_000, // 30 seconds (matches registry TTL)
      size: JSON.stringify(documents).length,
      selfUri: uri,
    });

    return `${JSON.stringify(documents, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
  }
}

/**
 * Register store resources with the MCP server.
 * Registers 2 gemini://stores resources:
 *   - gemini://stores (list of all stores)
 *   - gemini://stores/{storeName}/documents (documents in a store)
 */
export function registerStoreResources(server: McpServer, storeRegistry: StoreRegistry): void {
  const handler = new StoreResourceHandler(storeRegistry);

  registerStaticResource(server, STORES_LIST_URI, {
    id: 'stores-list-gemini',
    description: 'File Search Store list',
    mimeType: 'application/json',
    read: (uri) => handler.readResource(uri),
  });

  registerTemplateResource(server, STORE_DOCUMENTS_TEMPLATE, {
    id: 'store-documents-gemini',
    description: 'Documents in a File Search Store',
    mimeType: 'application/json',
    read: (uri) => handler.readResource(uri),
  });
}
