/**
 * StoreRegistry provides caching for Gemini File Search Stores with 30-second TTL.
 */
import { getAI } from '../client.js';

export interface StoreEntry {
  name: string;
  displayName?: string;
  updateTime?: string;
}

export interface DocumentEntry {
  name: string;
  displayName?: string;
  mimeType?: string;
  createTime?: string;
}

interface StoreRegistryOptions {
  ttlMs?: number;
  listStoresFn?: () => Promise<StoreEntry[]>;
  listDocumentsFn?: (storeName: string) => Promise<DocumentEntry[]>;
}

export interface StoreRegistry {
  listStores(): Promise<StoreEntry[]>;
  listDocuments(storeName: string): Promise<DocumentEntry[]>;
  invalidate(): void;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Creates a StoreRegistry with configurable TTL caching for File Search Stores.
 *
 * @param options Configuration options
 * @param options.ttlMs Cache TTL in milliseconds (default: 30000)
 * @param options.listStoresFn Optional function to fetch stores (for testing)
 * @param options.listDocumentsFn Optional function to fetch documents for a store (for testing)
 * @returns A StoreRegistry instance
 */
export function createStoreRegistry(options: StoreRegistryOptions = {}): StoreRegistry {
  const ttlMs = options.ttlMs ?? 30_000;
  const listStoresFn = options.listStoresFn;
  const listDocumentsFn = options.listDocumentsFn;

  // Cache storage: null key for listStores, string keys for per-store documents
  const storesCache = new Map<null, CacheEntry<StoreEntry[]>>();
  const documentsCache = new Map<string, CacheEntry<DocumentEntry[]>>();

  function isCacheValid<T>(entry: CacheEntry<T>, ttl: number): boolean {
    return Date.now() - entry.timestamp < ttl;
  }

  async function listStores(): Promise<StoreEntry[]> {
    const now = Date.now();
    const cached = storesCache.get(null);

    if (cached && isCacheValid(cached, ttlMs)) {
      return cached.data;
    }

    let stores: StoreEntry[];
    if (listStoresFn) {
      stores = await listStoresFn();
    } else {
      stores = await defaultListStores();
    }

    storesCache.set(null, { data: stores, timestamp: now });
    return stores;
  }

  async function listDocuments(storeName: string): Promise<DocumentEntry[]> {
    const now = Date.now();
    const cached = documentsCache.get(storeName);

    if (cached && isCacheValid(cached, ttlMs)) {
      return cached.data;
    }

    let documents: DocumentEntry[];
    if (listDocumentsFn) {
      documents = await listDocumentsFn(storeName);
    } else {
      documents = await defaultListDocuments(storeName);
    }

    documentsCache.set(storeName, { data: documents, timestamp: now });
    return documents;
  }

  function invalidate(): void {
    storesCache.clear();
    documentsCache.clear();
  }

  return {
    listStores,
    listDocuments,
    invalidate,
  };
}

/**
 * Default implementation: lists all File Search Stores via the Gemini SDK.
 */
async function defaultListStores(): Promise<StoreEntry[]> {
  const ai = getAI();
  const pager = await ai.fileSearchStores.list();
  const out: StoreEntry[] = [];
  for await (const store of pager) {
    if (typeof store.name !== 'string') continue;
    out.push({
      name: store.name,
      ...(typeof store.displayName === 'string' ? { displayName: store.displayName } : {}),
      ...(typeof store.updateTime === 'string' ? { updateTime: store.updateTime } : {}),
    });
  }
  return out;
}

/**
 * Default implementation: lists all documents in a File Search Store via the Gemini SDK.
 *
 * @param storeName Short store name (without the `fileSearchStores/` prefix). The full resource
 *   name is constructed automatically.
 */
async function defaultListDocuments(storeName: string): Promise<DocumentEntry[]> {
  const ai = getAI();
  const parent = storeName.startsWith('fileSearchStores/')
    ? storeName
    : `fileSearchStores/${storeName}`;
  const pager = await ai.fileSearchStores.documents.list({ parent });
  const out: DocumentEntry[] = [];
  for await (const doc of pager) {
    if (typeof doc.name !== 'string') continue;
    out.push({
      name: doc.name,
      ...(typeof doc.displayName === 'string' ? { displayName: doc.displayName } : {}),
      ...(typeof doc.mimeType === 'string' ? { mimeType: doc.mimeType } : {}),
      ...(typeof doc.createTime === 'string' ? { createTime: doc.createTime } : {}),
    });
  }
  return out;
}
