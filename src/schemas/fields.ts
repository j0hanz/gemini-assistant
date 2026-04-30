import { isAbsolute, normalize } from 'node:path';

import {
  HarmBlockMethod,
  HarmBlockThreshold,
  HarmCategory,
  MediaResolution,
  UrlRetrievalStatus,
} from '@google/genai';
import { z } from 'zod/v4';

// ── Profile-driven ToolsSpec schemas ─────────────────────────────────────────

import { TOOL_PROFILE_NAMES } from '../lib/tool-profiles.js';
import { isPublicHttpUrl } from '../lib/validation.js';

import { PUBLIC_TOOL_NAMES, THINKING_LEVELS } from '../public-contract.js';
import { validateGeminiJsonSchema } from './validators.js';

const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?![\\/])/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';
export const DIAGRAM_TYPES = ['mermaid', 'plantuml'] as const;
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

function nonNegativeInt(description: string) {
  return withFieldMetadata(z.int().nonnegative(), description);
}

const PublicHttpUrlSchema = z.httpUrl().refine(isPublicHttpUrl, {
  error: PUBLIC_HTTP_URL_ERROR,
});

function publicHttpUrl(description: string) {
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

function publicHttpUrlArray(
  options: PublicHttpUrlArrayOptions & { optional: true },
): z.ZodOptional<z.ZodArray<ReturnType<typeof publicHttpUrl>>>;
function publicHttpUrlArray(
  options: PublicHttpUrlArrayOptions & { optional?: false | undefined },
): z.ZodArray<ReturnType<typeof publicHttpUrl>>;
function publicHttpUrlArray(options: PublicHttpUrlArrayOptions) {
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

export function thinkingLevel(
  description = 'Thinking level selector. Overrides Gemini defaults for the selected profile.',
) {
  return withFieldMetadata(z.enum(THINKING_LEVELS).optional(), description);
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

const FunctionDeclarationSchema = z.strictObject({
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
    z
      .record(z.string(), z.unknown())
      .superRefine((value, ctx) => {
        if (value.type !== 'object') {
          ctx.addIssue({
            code: 'custom',
            message: 'Function parameters JSON Schema must declare type "object".',
            path: [],
            input: value,
          });
        }

        for (const error of validateGeminiJsonSchema(value)) {
          ctx.addIssue({
            code: 'custom',
            message: error,
            path: [],
            input: value,
          });
        }
      })
      .optional(),
    'Optional JSON Schema object for function parameters. Must be type: "object" and Gemini-compatible.',
  ),
});

const FunctionResponseSchema = z.strictObject({
  id: withFieldMetadata(
    z.string().trim().min(1),
    'Gemini functionCall id this response answers. Required for Gemini 3+.',
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

const usageMetadataFields = {
  promptTokenCount: nonNegativeInt('Tokens in the prompt').optional(),
  candidatesTokenCount: nonNegativeInt('Tokens in the response').optional(),
  thoughtsTokenCount: nonNegativeInt('Tokens used for thinking').optional(),
  cachedContentTokenCount: nonNegativeInt('Tokens reused from cached content').optional(),
  totalTokenCount: nonNegativeInt('Total tokens for the request').optional(),
  toolUsePromptTokenCount: nonNegativeInt('Tokens in tool-use prompts').optional(),
  promptTokensDetails: z
    .array(z.object({ modality: z.string(), tokenCount: z.number() }).partial())
    .optional(),
  cacheTokensDetails: z
    .array(z.object({ modality: z.string(), tokenCount: z.number() }).partial())
    .optional(),
  candidatesTokensDetails: z
    .array(z.object({ modality: z.string(), tokenCount: z.number() }).partial())
    .optional(),
};

export const UsageMetadataSchema = z.strictObject(usageMetadataFields);

const SafetySettingSchema = z.strictObject({
  category: z.enum(HarmCategory).describe('Gemini harm category'),
  method: z.enum(HarmBlockMethod).optional().describe('Gemini harm block method'),
  threshold: z.enum(HarmBlockThreshold).describe('Gemini harm block threshold'),
});

const SafetySettingsSchema = z
  .array(SafetySettingSchema)
  .optional()
  .describe('Gemini SafetySetting[]');

export const completedStatusField = z
  .literal('completed')
  .describe('Stable status for successful tool executions');

export const groundingStatusField = z
  .enum(['grounded', 'partially_grounded', 'ungrounded'])
  .describe('Grounding status derived from retrieval and citation coverage');

export const BaseOutputSchema = z.strictObject({
  warnings: z.array(z.string()).optional().describe('Non-fatal warnings for the result'),
});

// ── JSON value schema for `chat.data` ────────────────────────────────

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

const urlMetadataEntryFields = {
  url: PublicHttpUrlSchema.describe('Retrieved URL'),
  status: z
    .enum(UrlRetrievalStatus)
    .describe(
      'Gemini URL retrieval status (`UrlRetrievalStatus` enum). Unknown SDK values are coerced to `URL_RETRIEVAL_STATUS_UNSPECIFIED` before schema validation.',
    ),
};

export const UrlMetadataEntrySchema = z.strictObject(urlMetadataEntryFields);

const sourceDetailFields = {
  origin: z.enum(['googleSearch', 'urlContext', 'both']).optional().describe('Source provenance'),
  domain: z.string().optional().describe('Source hostname derived from the URL'),
  title: z.string().describe('Source title when Gemini provides one').optional(),
  url: PublicHttpUrlSchema.describe('Source URL'),
};

export const SourceDetailSchema = z.strictObject(sourceDetailFields);

const groundingCitationFields = {
  text: z.string().describe('Grounded claim text supported by retrieved sources'),
  startIndex: nonNegativeInt('Start byte index for the supported claim').optional(),
  endIndex: nonNegativeInt('End byte index for the supported claim').optional(),
  sourceUrls: publicHttpUrlArray({
    description: 'Source URLs supporting this claim',
    itemDescription: 'Public source URL supporting this claim',
  }),
};

export const GroundingCitationSchema = z.strictObject(groundingCitationFields);

export const FindingSchema = z.strictObject({
  claim: z.string().describe('Claim text attributed to one or more sources'),
  supportingSourceUrls: publicHttpUrlArray({
    description: 'URLs supporting this claim',
    itemDescription: 'Public source URL',
  }),
  verificationStatus: z
    .enum(['cited', 'partial', 'unverified'])
    .optional()
    .describe('Claim attribution status derived from available grounding metadata'),
});

export const GroundingSignalsSchema = z.strictObject({
  retrievalPerformed: z.boolean().describe('Whether any source retrieval metadata was surfaced'),
  urlContextUsed: z.boolean().describe('Whether URL Context retrieval succeeded'),
  groundingSupportsCount: z.int().min(0).describe('Count of claim-level grounding supports'),
  confidence: z
    .enum(['high', 'medium', 'low', 'none'])
    .describe('Grounding confidence derived from retrieval and citation coverage'),
});

export const diffStatsFields = {
  files: nonNegativeInt('Files changed'),
  additions: nonNegativeInt('Lines added'),
  deletions: nonNegativeInt('Lines deleted'),
};

interface UrlContextFieldOptions {
  description: string;
  itemDescription: string;
  max?: number;
  min?: number;
  optional?: boolean;
}

export function createUrlContextFields(options: UrlContextFieldOptions & { optional: true }): {
  urls: z.ZodOptional<z.ZodArray<ReturnType<typeof publicHttpUrl>>>;
};
export function createUrlContextFields(
  options: UrlContextFieldOptions & { optional?: false | undefined },
): { urls: z.ZodArray<ReturnType<typeof publicHttpUrl>> };
export function createUrlContextFields(options: UrlContextFieldOptions) {
  if (options.optional === true) {
    return {
      urls: publicHttpUrlArray({ ...options, optional: true }),
    };
  }

  return {
    urls: publicHttpUrlArray({ ...options, optional: false }),
  };
}

export function createGenerationConfigFields() {
  return {
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .max(1_048_576)
      .optional()
      .describe('Maximum Gemini output tokens.'),
    safetySettings: SafetySettingsSchema,
  };
}

const ProfileNameSchema = withFieldMetadata(
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(TOOL_PROFILE_NAMES).optional(),
  ),
  'Gemini tool profile name. Selects the combination of built-in tools and thinking defaults. Optional — omit (or leave empty) to use the per-tool default profile.',
);

const ProfileThinkingLevelSchema = withFieldMetadata(
  z.enum(['minimal', 'low', 'medium', 'high'] as const),
  'Thinking depth override for this profile (lowercase: minimal, low, medium, high). Distinct from the top-level thinkingLevel which uses uppercase.',
);

const FileSearchStoreNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_\-/]+$/);

const OverridesSchema = z.strictObject({
  urls: publicHttpUrlArray({
    description:
      'Public URLs to analyze via URL Context. Only valid with profiles that include urlContext.',
    itemDescription: 'Public URL to fetch via URL Context',
    max: 20,
    optional: true,
  }),
  fileSearchStores: withFieldMetadata(
    z.array(FileSearchStoreNameSchema).min(1).max(32).optional(),
    'Gemini File Search store names. Required when profile is rag.',
  ),
  functions: withFieldMetadata(
    z.array(FunctionDeclarationSchema).min(1).max(20).optional(),
    'Function declarations exposed to Gemini (max 20). Required when profile is agent.',
  ),
  responseSchemaJson: withFieldMetadata(
    z.record(z.string(), z.unknown()).optional(),
    'JSON Schema for structured output. Required when profile is structured.',
  ),
  functionCallingMode: withFieldMetadata(
    z.enum(['AUTO', 'ANY', 'NONE', 'VALIDATED'] as const).optional(),
    'Function-calling mode override. ANY and AUTO are rejected when built-in tools are active.',
  ),
  allowedFunctionNames: withFieldMetadata(
    z.array(z.string()).optional(),
    'Restrict which declared functions the model may call (VALIDATED mode).',
  ),
});

export const ToolsSpecSchema = z.strictObject({
  profile: ProfileNameSchema.optional(),
  thinkingLevel: ProfileThinkingLevelSchema.optional(),
  overrides: OverridesSchema.optional(),
});
