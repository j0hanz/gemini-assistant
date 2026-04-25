import { z } from 'zod/v4';

import {
  nonNegativeInt,
  publicHttpUrl,
  publicHttpUrlArray,
  PublicHttpUrlSchema,
  workspacePath,
} from './fields.js';

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

const SafetySettingPassthroughSchema = z
  .array(z.unknown())
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

export const publicBaseOutputFields = {
  status: z.literal('completed').describe('Stable status for successful tool executions'),
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
    .enum(['supported', 'partial', 'unverified'])
    .optional()
    .describe('Claim verification status derived from available grounding evidence'),
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
    safetySettings: SafetySettingPassthroughSchema,
  };
}
