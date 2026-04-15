import { isAbsolute } from 'node:path';

import { z } from 'zod/v4';

const TTL_SECONDS_PATTERN = /^[1-9]\d*s$/;

export function requiredText(description: string, maxLength?: number) {
  const schema = z.string().trim().min(1);
  return (maxLength === undefined ? schema : schema.max(maxLength)).describe(description);
}

export function optionalText(description: string, maxLength?: number) {
  return requiredText(description, maxLength).optional();
}

export function absolutePath(description: string) {
  return requiredText(description).refine((value) => isAbsolute(value), {
    error: 'Path must be absolute',
  });
}

export function ttlSeconds(description: string) {
  return z
    .string()
    .trim()
    .regex(TTL_SECONDS_PATTERN, {
      error: 'TTL must be a positive integer number of seconds ending in "s" (e.g. "3600s")',
    })
    .describe(description);
}

export function nonNegativeInt(description: string) {
  return z.int().nonnegative().describe(description);
}
