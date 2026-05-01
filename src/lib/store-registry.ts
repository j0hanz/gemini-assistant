/**
 * StoreRegistry provides caching for Gemini File Search Stores with 30-second TTL.
 */

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

export interface StoreRegistryOptions {
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
			// In production, this would use the Gemini SDK:
			// const response = await ai.fileSearchStores.list();
			// stores = response.stores.map(store => ({
			//   name: store.name,
			//   displayName: store.displayName,
			//   updateTime: store.updateTime,
			// }));
			throw new Error('listStoresFn must be provided for store listing');
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
			// In production, this would use the Gemini SDK:
			// const response = await ai.fileSearchStores.documents.list(storeName);
			// documents = response.documents.map(doc => ({
			//   name: doc.name,
			//   displayName: doc.displayName,
			//   mimeType: doc.mimeType,
			//   createTime: doc.createTime,
			// }));
			throw new Error(`listDocuments(${storeName}) not implemented`);
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
