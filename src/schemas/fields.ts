import { completable, type CompletableSchema } from '@modelcontextprotocol/server';

import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod/v4';

import { isPublicHttpUrl } from '../lib/validation.js';

import { completeCacheNames, DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from '../client.js';
import { PUBLIC_TOOL_NAMES } from '../public-contract.js';

const CACHE_NAME_PATTERN = /^cachedContents\/.+$/;
const TTL_SECONDS_PATTERN = /^[1-9]\d*s$/;
const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?![\\/])/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';
const MEDIA_RESOLUTIONS = [
  'MEDIA_RESOLUTION_LOW',
  'MEDIA_RESOLUTION_MEDIUM',
  'MEDIA_RESOLUTION_HIGH',
] as const;
export const DIAGRAM_TYPES = ['mermaid', 'plantuml'] as const;
export const ASK_URL_TOOL_PROFILES = ['url', 'search_url'] as const;
export const ASK_NON_URL_TOOL_PROFILES = ['none', 'search', 'code', 'search_code'] as const;
export const RESEARCH_MODE_OPTIONS = ['quick', 'deep'] as const;
export const REVIEW_SUBJECT_OPTIONS = ['diff', 'comparison', 'failure'] as const;
export const MEMORY_ACTION_OPTIONS = [
  'sessions.list',
  'sessions.get',
  'sessions.transcript',
  'sessions.events',
  'caches.list',
  'caches.get',
  'caches.create',
  'caches.update',
  'caches.delete',
  'workspace.context',
  'workspace.cache',
] as const;

export function enumField<const Values extends readonly [string, ...string[]]>(
  values: Values,
  description: string,
) {
  return z.enum(values).describe(description);
}

export const PublicJobNameSchema = enumField(PUBLIC_TOOL_NAMES, 'Public job name');

export function textField(description: string, maxLength?: number) {
  const schema = z.string().trim().min(1);
  return (maxLength === undefined ? schema : schema.max(maxLength)).describe(description);
}

export function requiredText(description: string, maxLength?: number) {
  return textField(description, maxLength);
}

export function goalText(description = 'User goal or requested outcome', maxLength = 100_000) {
  return textField(description, maxLength);
}

export function boundedFloat(description: string, minimum: number, maximum: number) {
  return z.number().min(minimum).max(maximum).describe(description);
}

export function boundedInt(description: string, minimum: number, maximum: number) {
  return z.int().min(minimum).max(maximum).describe(description);
}

function escapesRelativeRoot(value: string): boolean {
  const normalized = normalize(value);
  return normalized === '..' || normalized.startsWith(`..\\`) || normalized.startsWith('../');
}

function isWindowsDriveRelativePath(value: string): boolean {
  return WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(value);
}

export function workspacePath(description: string) {
  return requiredText(description).refine(
    (value) =>
      !isWindowsDriveRelativePath(value) && (isAbsolute(value) || !escapesRelativeRoot(value)),
    {
      error: 'Path must be workspace-relative or absolute',
    },
  );
}

export function ttlSeconds(description: string) {
  return textField(description).regex(TTL_SECONDS_PATTERN, {
    error: 'TTL must be a positive integer number of seconds ending in "s" (e.g. "3600s")',
  });
}

export function nonNegativeInt(description: string) {
  return z.int().nonnegative().describe(description);
}

export function cacheName(description: string) {
  return textField(description).regex(CACHE_NAME_PATTERN, {
    error: 'Cache name must start with "cachedContents/".',
  });
}

export function completableCacheName(
  description: string,
  optional?: false,
): CompletableSchema<ReturnType<typeof cacheName>>;
export function completableCacheName(
  description: string,
  optional: true,
): CompletableSchema<z.ZodOptional<ReturnType<typeof cacheName>>>;
export function completableCacheName(description: string, optional = false) {
  if (optional) {
    return completable(cacheName(description).optional(), completeCacheNames);
  }

  return completable(cacheName(description), completeCacheNames);
}

export const PublicHttpUrlSchema = z.httpUrl().refine(isPublicHttpUrl, {
  error: PUBLIC_HTTP_URL_ERROR,
});

export function publicHttpUrl(description: string) {
  return PublicHttpUrlSchema.describe(description);
}

interface PublicHttpUrlArrayOptions {
  description: string;
  itemDescription: string;
  max?: number;
  min?: number;
  optional?: boolean;
}

interface ArrayFieldOptions {
  max?: number;
  min?: number;
}

function buildArrayField<T extends z.ZodType>(itemSchema: T, options: ArrayFieldOptions) {
  const { max, min } = options;
  let schema = z.array(itemSchema);

  if (min !== undefined) {
    schema = schema.min(min);
  }

  if (max !== undefined) {
    schema = schema.max(max);
  }

  return schema;
}

export function publicHttpUrlArray(
  options: PublicHttpUrlArrayOptions & { optional: true },
): z.ZodOptional<z.ZodArray<ReturnType<typeof publicHttpUrl>>>;
export function publicHttpUrlArray(
  options: PublicHttpUrlArrayOptions & { optional?: false | undefined },
): z.ZodArray<ReturnType<typeof publicHttpUrl>>;
export function publicHttpUrlArray(options: PublicHttpUrlArrayOptions) {
  const { itemDescription, optional = false, ...rest } = options;
  const schema = buildArrayField(publicHttpUrl(itemDescription), rest);
  return optional
    ? schema.optional().describe(rest.description)
    : schema.describe(rest.description);
}

interface WorkspacePathArrayOptions {
  description: string;
  itemDescription: string;
  max?: number;
  min?: number;
  optional?: boolean;
}

export function workspacePathArray(
  options: WorkspacePathArrayOptions & { optional: true },
): z.ZodOptional<z.ZodArray<ReturnType<typeof workspacePath>>>;
export function workspacePathArray(
  options: WorkspacePathArrayOptions & { optional?: false | undefined },
): z.ZodArray<ReturnType<typeof workspacePath>>;
export function workspacePathArray(options: WorkspacePathArrayOptions) {
  const { itemDescription, optional = false, ...rest } = options;
  const schema = buildArrayField(workspacePath(itemDescription), rest);
  return optional
    ? schema.optional().describe(rest.description)
    : schema.describe(rest.description);
}

export function timestamp(description: string) {
  return z.iso.datetime({ offset: true }).describe(description);
}

export function sessionId(description: string) {
  return textField(description, 256);
}

export function thinkingLevel(
  description = 'Reasoning depth. Default: MEDIUM. MINIMAL is fastest; HIGH is deepest.',
) {
  return z
    .enum(THINKING_LEVELS)
    .meta({ default: DEFAULT_THINKING_LEVEL })
    .default(DEFAULT_THINKING_LEVEL)
    .describe(description);
}

export function mediaResolution(description: string) {
  return enumField(MEDIA_RESOLUTIONS, description).optional();
}
