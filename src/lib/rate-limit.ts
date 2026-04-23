export interface RateLimiter {
  take: (key: string) => boolean;
}

export interface RateLimiterOptions {
  burst: number;
  now?: () => number;
  rps: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter({
  burst,
  now = () => Date.now(),
  rps,
}: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();

  return {
    take: (key: string): boolean => {
      const currentTime = now();
      const bucket = buckets.get(key) ?? { tokens: burst, updatedAt: currentTime };
      const elapsedSeconds = Math.max(0, (currentTime - bucket.updatedAt) / 1000);
      bucket.tokens = Math.min(burst, bucket.tokens + elapsedSeconds * rps);
      bucket.updatedAt = currentTime;

      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return false;
      }

      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return true;
    },
  };
}
