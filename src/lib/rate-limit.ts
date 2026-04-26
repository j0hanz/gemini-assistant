export interface RateLimiter {
  take: (key: string) => boolean;
}

export interface RateLimiterOptions {
  burst: number;
  idleTtlMs?: number;
  maxBuckets?: number;
  now?: () => number;
  rps: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 10_000;

export function createRateLimiter({
  burst,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  maxBuckets = DEFAULT_MAX_BUCKETS,
  now = () => Date.now(),
  rps,
}: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweepAt = 0;

  const setBucket = (key: string, bucket: Bucket): void => {
    buckets.delete(key);
    buckets.set(key, bucket);
  };

  const sweepExpiredBuckets = (currentTime: number): void => {
    if (currentTime - lastSweepAt < idleTtlMs) {
      return;
    }

    lastSweepAt = currentTime;
    const cutoff = currentTime - idleTtlMs;
    for (const [key, bucket] of buckets) {
      if (bucket.updatedAt < cutoff) {
        buckets.delete(key);
      }
    }
  };

  const boundBucketCount = (): void => {
    while (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (typeof oldestKey !== 'string') {
        return;
      }
      buckets.delete(oldestKey);
    }
  };

  return {
    take: (key: string): boolean => {
      const currentTime = now();
      sweepExpiredBuckets(currentTime);
      const bucket = buckets.get(key) ?? { tokens: burst, updatedAt: currentTime };
      const elapsedSeconds = Math.max(0, (currentTime - bucket.updatedAt) / 1000);
      bucket.tokens = Math.min(burst, bucket.tokens + elapsedSeconds * rps);
      bucket.updatedAt = currentTime;

      if (bucket.tokens < 1) {
        setBucket(key, bucket);
        boundBucketCount();
        return false;
      }

      bucket.tokens -= 1;
      setBucket(key, bucket);
      boundBucketCount();
      return true;
    },
  };
}
