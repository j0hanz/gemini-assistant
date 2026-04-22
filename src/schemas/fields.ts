import { isAbsolute, normalize } from 'node:path';

import { MediaResolution } from '@google/genai';
import { z } from 'zod/v4';

import { isPublicHttpUrl } from '../lib/validation.js';

import { DEFAULT_TEMPERATURE, DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from '../client.js';
import { PUBLIC_TOOL_NAMES } from '../public-contract.js';

const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?![\\/])/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';
export const DIAGRAM_TYPES = ['mermaid', 'plantuml'] as const;
export const ASK_URL_TOOL_PROFILES = ['url', 'search_url', 'url_code', 'search_url_code'] as const;
export const ASK_NON_URL_TOOL_PROFILES = ['none', 'search', 'code', 'search_code'] as const;
export const RESEARCH_MODE_OPTIONS = ['quick', 'deep'] as const;
const ANALYZE_TARGET_KIND_OPTIONS = ['file', 'url', 'multi'] as const;
const ANALYZE_OUTPUT_KIND_OPTIONS = ['summary', 'diagram'] as const;
export const REVIEW_SUBJECT_OPTIONS = ['diff', 'comparison', 'failure'] as const;

function buildTextSchema(maxLength?: number) {
  const schema = z.string().trim().min(1);
  return maxLength === undefined ? schema : schema.max(maxLength);
}

export function withFieldMetadata<T extends z.ZodType>(schema: T, description: string): T {
  return schema.describe(description);
}

export function optionalField<T extends z.ZodType>(schema: T): z.ZodOptional<T> {
  const metadata = schema.meta();
  let optionalSchema = schema.optional();

  if (schema.description) {
    optionalSchema = optionalSchema.describe(schema.description);
  }

  return metadata ? optionalSchema.meta(metadata) : optionalSchema;
}

export function enumField<const Values extends readonly [string, ...string[]]>(
  values: Values,
  description: string,
) {
  return withFieldMetadata(z.enum(values), description);
}

export const PublicJobNameSchema = enumField(PUBLIC_TOOL_NAMES, 'Public job name');

export function textField(description: string, maxLength?: number) {
  return withFieldMetadata(buildTextSchema(maxLength), description);
}

export function requiredText(description: string, maxLength?: number) {
  return textField(description, maxLength);
}

export function goalText(description = 'User goal or requested outcome', maxLength = 100_000) {
  return textField(description, maxLength);
}

function escapesRelativeRoot(value: string): boolean {
  const normalized = normalize(value);
  return normalized === '..' || normalized.startsWith(`..\\`) || normalized.startsWith('../');
}

function isWindowsDriveRelativePath(value: string): boolean {
  return WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(value);
}

export function workspacePath(description: string) {
  const schema = buildTextSchema().refine(
    (value) =>
      !isWindowsDriveRelativePath(value) && (isAbsolute(value) || !escapesRelativeRoot(value)),
    {
      error: 'Path must be workspace-relative or absolute',
    },
  );
  return withFieldMetadata(schema, description);
}

export function nonNegativeInt(description: string) {
  return withFieldMetadata(z.int().nonnegative(), description);
}

export const PublicHttpUrlSchema = z.httpUrl().refine(isPublicHttpUrl, {
  error: PUBLIC_HTTP_URL_ERROR,
});

export function publicHttpUrl(description: string) {
  return withFieldMetadata(PublicHttpUrlSchema, description);
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
  return withFieldMetadata(optional ? schema.optional() : schema, rest.description);
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
  return withFieldMetadata(optional ? schema.optional() : schema, rest.description);
}

export function sessionId(description: string) {
  return textField(description, 256);
}

export function temperatureField(
  description = 'Sampling temperature (0.0 to 2.0). Default: 1.0. Values < 1.0 cause reasoning loops.',
) {
  return withFieldMetadata(
    z.number().min(0).max(2).multipleOf(0.1).default(DEFAULT_TEMPERATURE),
    description,
  );
}

export function thinkingLevel(
  description = 'Reasoning depth. Default: MEDIUM. MINIMAL is fastest; HIGH is deepest.',
) {
  return withFieldMetadata(z.enum(THINKING_LEVELS).default(DEFAULT_THINKING_LEVEL), description);
}

export function researchMode(description = 'Research mode selector (`quick` or `deep`).') {
  return withFieldMetadata(z.enum(RESEARCH_MODE_OPTIONS).default('quick'), description);
}

export function analyzeTargetKind(
  description = 'What to analyze: one file, one or more public URLs, or a small local file set.',
) {
  return withFieldMetadata(z.enum(ANALYZE_TARGET_KIND_OPTIONS).default('file'), description);
}

export function analyzeOutputKind(
  description = 'Requested output format: summary text or a generated diagram.',
) {
  return withFieldMetadata(z.enum(ANALYZE_OUTPUT_KIND_OPTIONS).default('summary'), description);
}

export function mediaResolution(description: string) {
  return withFieldMetadata(
    z.enum(MediaResolution).default(MediaResolution.MEDIA_RESOLUTION_MEDIUM),
    description,
  );
}
