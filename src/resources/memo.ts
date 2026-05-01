interface MemoEntry<V> {
  value: V;
  expiresAt: number;
}

export class ResourceMemo<K, V> {
  private readonly cache = new Map<K, MemoEntry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  async get(key: K, ttlMs: number, build: () => V | Promise<V>): Promise<V> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<V> => {
      try {
        const value = await build();
        const expiresAt =
          ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
        this.cache.set(key, { value, expiresAt });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key?: K): void {
    if (key === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(key);
  }
}
