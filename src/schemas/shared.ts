import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod/v4';

import { isPublicHttpUrl } from '../lib/validation.js';

const CACHE_NAME_PATTERN = /^cachedContents\/.+$/;
const TTL_SECONDS_PATTERN = /^[1-9]\d*s$/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';
export const CURRENT_WORKSPACE_ROOT = normalize(process.cwd()).replaceAll('\\', '/');

export function withCurrentWorkspaceRoot(description: string) {
  return `${description} (${CURRENT_WORKSPACE_ROOT})`;
}

export function requiredText(description: string, maxLength?: number) {
  const schema = z.string().trim().min(1);
  return (maxLength === undefined ? schema : schema.max(maxLength)).describe(description);
}

export function optionalText(description: string, maxLength?: number) {
  return requiredText(description, maxLength).optional();
}

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

export const TimestampSchema = z.iso.datetime({ offset: true });

export function timestamp(description: string) {
  return TimestampSchema.describe(description);
}
