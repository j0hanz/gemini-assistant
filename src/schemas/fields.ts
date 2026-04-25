import { isAbsolute, normalize } from 'node:path';

import { MediaResolution } from '@google/genai';
import { z } from 'zod/v4';

import { isPublicHttpUrl } from '../lib/validation.js';

import { DEFAULT_TEMPERATURE, THINKING_LEVELS } from '../client.js';
import { PUBLIC_TOOL_NAMES } from '../public-contract.js';

const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?![\\/])/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';
export const DIAGRAM_TYPES = ['mermaid', 'plantuml'] as const;
export const RESEARCH_MODE_OPTIONS = ['quick', 'deep'] as const;
const ANALYZE_TARGET_KIND_OPTIONS = ['file', 'url', 'multi'] as const;
const ANALYZE_OUTPUT_KIND_OPTIONS = ['summary', 'diagram'] as const;
export const REVIEW_SUBJECT_OPTIONS = ['diff', 'comparison', 'failure'] as const;
export const SERVER_SIDE_TOOL_INVOCATIONS_OPTIONS = ['auto', 'always', 'never'] as const;
export const FUNCTION_CALLING_MODE_OPTIONS = ['AUTO', 'ANY', 'NONE', 'VALIDATED'] as const;

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

export function temperatureField(description = 'Sampling temperature 0-2 (default 1).') {
  return withFieldMetadata(
    z.number().min(0).max(2).multipleOf(0.1).default(DEFAULT_TEMPERATURE),
    description,
  );
}

export function thinkingLevel(
  description = 'Reasoning depth: MINIMAL, LOW, MEDIUM, HIGH. Omit to use the job-specific default cost profile.',
) {
  return withFieldMetadata(z.enum(THINKING_LEVELS).optional(), description);
}

export function thinkingBudget(
  description = 'Override thinking token budget. Applied only when `thinkingLevel` is omitted; `thinkingLevel` takes precedence when both are set.',
) {
  return withFieldMetadata(z.number().int().min(0).optional(), description);
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

export const FileSearchSpecSchema = z.strictObject({
  fileSearchStoreNames: withFieldMetadata(
    z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_\-/]+$/),
      )
      .min(1)
      .max(32),
    'Gemini File Search store names to retrieve from.',
  ),
  metadataFilter: withFieldMetadata(
    z.unknown().optional(),
    'Optional Gemini File Search metadata filter.',
  ),
});
export type FileSearchSpecInput = z.infer<typeof FileSearchSpecSchema>;

export const FunctionDeclarationSchema = z.strictObject({
  name: withFieldMetadata(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    'Function name the model may call.',
  ),
  description: withFieldMetadata(
    z.string().min(1).max(1024),
    'Function purpose. The MCP client owns execution and returns function responses.',
  ),
  parametersJsonSchema: withFieldMetadata(
    z.record(z.string(), z.unknown()).optional(),
    'Optional JSON Schema object for function parameters.',
  ),
});

export const FunctionsSpecSchema = z.strictObject({
  declarations: withFieldMetadata(
    z.array(FunctionDeclarationSchema).min(1).max(32),
    'Typed function declarations exposed to Gemini. The MCP client executes calls.',
  ),
  mode: withFieldMetadata(
    z.enum(FUNCTION_CALLING_MODE_OPTIONS).optional(),
    'Gemini function-calling mode. `AUTO` (default model choice), `ANY` (must call a declared function), `NONE` (disable calling), `VALIDATED` (stronger default for mixed tool + structured-output flows).',
  ),
});
export type FunctionsSpecInput = z.infer<typeof FunctionsSpecSchema>;

export const FunctionResponseSchema = z.strictObject({
  id: withFieldMetadata(
    z.string().trim().min(1).optional(),
    'Optional Gemini function call ID this response answers.',
  ),
  name: withFieldMetadata(
    z.string().trim().min(1).max(64),
    'Function name matching the Gemini functionCall name.',
  ),
  response: withFieldMetadata(
    z.record(z.string(), z.unknown()),
    'Function response JSON object. Use output and error keys when possible.',
  ),
});

export const FunctionResponsesSchema = withFieldMetadata(
  z.array(FunctionResponseSchema).min(1).max(32),
  'Caller-executed Gemini function responses for an existing session.',
);
export type FunctionResponseInput = z.infer<typeof FunctionResponseSchema>;

/**
 * Tolerant wrapper around `FileSearchSpecSchema.optional()` that treats a
 * wrapper object carrying an empty `fileSearchStoreNames` array as "unset",
 * i.e. equivalent to omitting the `fileSearch` field. This makes the surface
 * friendlier to clients that emit placeholder objects for optional wrappers.
 */
export const OptionalFileSearchSpecSchema = z
  .preprocess((value) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'fileSearchStoreNames' in value
    ) {
      const names = (value as { fileSearchStoreNames?: unknown }).fileSearchStoreNames;
      if (Array.isArray(names) && names.length === 0) {
        return undefined;
      }
    }
    return value;
  }, FileSearchSpecSchema.optional())
  .optional();

/**
 * Tolerant wrapper around `FunctionsSpecSchema.optional()` that treats a
 * wrapper object carrying an empty `declarations` array as "unset".
 */
export const OptionalFunctionsSpecSchema = z
  .preprocess((value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'declarations' in value) {
      const declarations = (value as { declarations?: unknown }).declarations;
      if (Array.isArray(declarations) && declarations.length === 0) {
        return undefined;
      }
    }
    return value;
  }, FunctionsSpecSchema.optional())
  .optional();

export const ServerSideToolInvocationsSchema = withFieldMetadata(
  z.enum(SERVER_SIDE_TOOL_INVOCATIONS_OPTIONS).default('auto'),
  'Server-side Gemini tool trace policy. `auto` (default): enabled only when built-in tools AND function declarations are both active. `always`: forces traces regardless of tool mix. `never`: omits traces.',
);
