import { isAbsolute, normalize } from 'node:path';

import { HarmBlockMethod, HarmBlockThreshold, HarmCategory, MediaResolution } from '@google/genai';
import { z } from 'zod/v4';

import { isPublicHttpUrl } from '../lib/validation.js';

import { DEFAULT_TEMPERATURE, PUBLIC_TOOL_NAMES, THINKING_LEVELS } from '../public-contract.js';
import { validateGeminiJsonSchema } from './validators.js';

const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?![\\/])/;
const PUBLIC_HTTP_URL_ERROR = 'URL must be a valid public http:// or https:// URL';
export const DIAGRAM_TYPES = ['mermaid', 'plantuml'] as const;
export const RESEARCH_MODE_OPTIONS = ['quick', 'deep'] as const;
const ANALYZE_TARGET_KIND_OPTIONS = ['file', 'url', 'multi'] as const;
const ANALYZE_OUTPUT_KIND_OPTIONS = ['summary', 'diagram'] as const;
export const REVIEW_SUBJECT_OPTIONS = ['diff', 'comparison', 'failure'] as const;
const SERVER_SIDE_TOOL_INVOCATIONS_OPTIONS = ['auto', 'always', 'never'] as const;
const FUNCTION_CALLING_MODE_OPTIONS = ['AUTO', 'ANY', 'NONE', 'VALIDATED'] as const;

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
  description = 'Optional reasoning depth override. Omit to use the job default.',
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

const FileSearchSpecSchema = z.strictObject({
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

const FunctionsSpecSchema = z.strictObject({
  declarations: withFieldMetadata(
    z.array(FunctionDeclarationSchema).min(1).max(32),
    'Typed function declarations exposed to Gemini. The MCP client executes calls.',
  ),
  mode: withFieldMetadata(
    z.enum(FUNCTION_CALLING_MODE_OPTIONS).optional(),
    'Gemini function-calling mode. `AUTO` (default model choice), `ANY` (must call a declared function), `NONE` (disable calling), `VALIDATED` (stronger default for mixed tool + structured-output flows).',
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
  }, z.unknown())
  .pipe(FileSearchSpecSchema.optional());

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
  }, z.unknown())
  .pipe(FunctionsSpecSchema.optional());

export const ServerSideToolInvocationsSchema = withFieldMetadata(
  z.enum(SERVER_SIDE_TOOL_INVOCATIONS_OPTIONS).default('auto'),
  'Server-side Gemini tool trace policy. `auto` (default): enabled whenever built-in Gemini tools are active. `always`: forces traces regardless of tool mix. `never`: omits traces.',
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

export const SafetySettingsSchema = z
  .array(SafetySettingSchema)
  .optional()
  .describe('Gemini SafetySetting[]');

const functionCallEntryFields = {
  name: z.string().describe('Function/tool name').optional(),
  args: z.record(z.string(), z.unknown()).describe('Function call arguments').optional(),
  id: z.string().describe('Function call identifier when present').optional(),
  thoughtSignature: z
    .string()
    .optional()
    .describe('Thought signature returned by Gemini for this function-call part'),
};

const FunctionCallEntrySchema = z.strictObject(functionCallEntryFields);

const ToolEventKindSchema = z.enum([
  'part',
  'tool_call',
  'tool_response',
  'function_call',
  'function_response',
  'thought',
  'model_text',
  'executable_code',
  'code_execution_result',
]);

const toolEventFields = {
  kind: ToolEventKindSchema.describe('Normalized Gemini tool/function event type'),
  name: z.string().describe('Function name when available').optional(),
  toolType: z.string().describe('Built-in tool type when available').optional(),
  id: z.string().describe('Stable Gemini call identifier when available').optional(),
  thoughtSignature: z
    .string()
    .optional()
    .describe('Thought signature returned by Gemini for the part'),
  args: z.record(z.string(), z.unknown()).describe('Tool or function arguments').optional(),
  response: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Tool or function response payload'),
  code: z.string().describe('Executable code payload').optional(),
  language: z.string().describe('Executable code language when available').optional(),
  output: z.string().describe('Code execution output').optional(),
  outcome: z.string().describe('Code execution outcome').optional(),
  text: z
    .string()
    .optional()
    .describe('Part text when a signature-bearing part has no tool payload'),
};

const ToolEventSchema = z.strictObject(toolEventFields);

const streamMetadataOutputFields = {
  thoughts: z.string().describe('Internal model reasoning.').optional(),
  usage: UsageMetadataSchema.describe('Token usage').optional(),
  safetyRatings: z.array(z.unknown()).describe('Candidate safety ratings').optional(),
  finishMessage: z.string().describe('Candidate finish message when present').optional(),
  citationMetadata: z.unknown().describe('Candidate citation metadata when present').optional(),
  functionCalls: z
    .array(FunctionCallEntrySchema)
    .optional()
    .describe('Server-side function calls.'),
  toolEvents: z
    .array(ToolEventSchema)
    .optional()
    .describe('Normalized tool/function event stream.'),
};

export const completedStatusField = z
  .literal('completed')
  .describe('Stable status for successful tool executions');

export const groundingStatusField = z
  .enum(['completed', 'grounded', 'partially_grounded', 'ungrounded'])
  .describe('Grounding status; `completed` is accepted for legacy successful outputs');

export const publicBaseOutputFieldsWithoutStatus = {
  requestId: z.string().describe('Server-side request or task identifier').optional(),
  warnings: z.array(z.string()).describe('Non-fatal warnings for the result').optional(),
  ...streamMetadataOutputFields,
};

const urlMetadataEntryFields = {
  url: PublicHttpUrlSchema.describe('Retrieved URL'),
  status: z
    .enum([
      'URL_RETRIEVAL_STATUS_SUCCESS',
      'URL_RETRIEVAL_STATUS_ERROR',
      'URL_RETRIEVAL_STATUS_UNSAFE',
      'URL_RETRIEVAL_STATUS_PAYWALL',
      'URL_RETRIEVAL_STATUS_UNSPECIFIED',
    ])
    .or(z.string())
    .describe(
      'Gemini URL retrieval status. Known URL_RETRIEVAL_STATUS_* values are documented while unknown strings remain forward-compatible.',
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

const searchEntryPointFields = {
  renderedContent: z
    .string()
    .optional()
    .describe('Google Search rendered entry point content for display compliance'),
};

export const SearchEntryPointSchema = z.strictObject(searchEntryPointFields);

export const diffStatsFields = {
  files: nonNegativeInt('Files changed'),
  additions: nonNegativeInt('Lines added'),
  deletions: nonNegativeInt('Lines deleted'),
};

export function createFilePairFields(firstDescription: string, secondDescription: string) {
  return {
    filePathA: workspacePath(firstDescription),
    filePathB: workspacePath(secondDescription),
  };
}

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
