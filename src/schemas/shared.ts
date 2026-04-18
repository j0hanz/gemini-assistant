import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod/v4';

import { isPublicHttpUrl } from '../lib/validation.js';

import { PUBLIC_TOOL_NAMES } from '../public-contract.js';

const CACHE_NAME_PATTERN = /^cachedContents\/.+$/;
const TTL_SECONDS_PATTERN = /^[1-9]\d*s$/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';

export function requiredText(description: string, maxLength?: number) {
  const schema = z.string().trim().min(1);
  return (maxLength === undefined ? schema : schema.max(maxLength)).describe(description);
}

export function optionalText(description: string, maxLength?: number) {
  return requiredText(description, maxLength).optional();
}

export const PublicJobNameSchema = z.enum(PUBLIC_TOOL_NAMES);

export function goalText(description = 'User goal or requested outcome', maxLength = 100_000) {
  return requiredText(description, maxLength);
}

export const MemoryRefSchema = z
  .strictObject({
    cacheName: cacheName('Gemini cache resource name to attach as reusable context').optional(),
  })
  .optional()
  .describe('Reusable memory inputs for the current request.');

function escapesRelativeRoot(value: string): boolean {
  const normalized = normalize(value);
  return normalized === '..' || normalized.startsWith(`..\\`) || normalized.startsWith('../');
}

export function workspacePath(description: string) {
  return requiredText(description).refine(
    (value) => isAbsolute(value) || !escapesRelativeRoot(value),
    {
      error: 'Path must be workspace-relative or absolute',
    },
  );
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

export function cacheName(description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .regex(CACHE_NAME_PATTERN, {
      error: 'Cache name must start with "cachedContents/".',
    })
    .describe(description);
}

export const PublicHttpUrlSchema = z.httpUrl().refine(isPublicHttpUrl, {
  error: PUBLIC_HTTP_URL_ERROR,
});

export function publicHttpUrl(description: string) {
  return PublicHttpUrlSchema.describe(description);
}

export function timestamp(description: string) {
  return z.iso.datetime({ offset: true }).describe(description);
}
