import { z } from 'zod/v4';

import {
  completableCacheName,
  nonNegativeInt,
  publicHttpUrl,
  publicHttpUrlArray,
  PublicHttpUrlSchema,
  timestamp,
  workspacePath,
} from './fields.js';

const usageMetadataFields = {
  promptTokenCount: nonNegativeInt('Tokens in the prompt').optional(),
  candidatesTokenCount: nonNegativeInt('Tokens in the response').optional(),
  thoughtsTokenCount: nonNegativeInt('Tokens used for thinking').optional(),
  totalTokenCount: nonNegativeInt('Total tokens for the request').optional(),
};

export const UsageMetadataSchema = z.strictObject(usageMetadataFields);

const functionCallEntryFields = {
  name: z.string().describe('Function/tool name'),
  args: z.record(z.string(), z.unknown()).describe('Function call arguments').optional(),
  id: z.string().describe('Function call identifier when present').optional(),
};

export const FunctionCallEntrySchema = z.strictObject(functionCallEntryFields);

const ToolEventKindSchema = z.enum([
  'part',
  'tool_call',
  'tool_response',
  'function_call',
  'function_response',
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
  output: z.string().describe('Code execution output').optional(),
  outcome: z.string().describe('Code execution outcome').optional(),
  text: z
    .string()
    .optional()
    .describe('Part text when a signature-bearing part has no tool payload'),
};

export const ToolEventSchema = z.strictObject(toolEventFields);

export const streamMetadataOutputFields = {
  thoughts: z.string().describe('Internal model reasoning.').optional(),
  usage: UsageMetadataSchema.describe('Token usage').optional(),
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
  status: z.string().describe('Retrieval status (e.g. URL_RETRIEVAL_STATUS_SUCCESS)'),
};

export const UrlMetadataEntrySchema = z.strictObject(urlMetadataEntryFields);

const sourceDetailFields = {
  title: z.string().describe('Source title when Gemini provides one').optional(),
  url: PublicHttpUrlSchema.describe('Source URL'),
};

export const SourceDetailSchema = z.strictObject(sourceDetailFields);

export const diffStatsFields = {
  files: nonNegativeInt('Files changed'),
  additions: nonNegativeInt('Lines added'),
  deletions: nonNegativeInt('Lines deleted'),
};

export const cacheSummaryFields = {
  name: completableCacheName('Cache resource name', true),
  displayName: z.string().describe('Human-readable label').optional(),
  model: z.string().describe('Model used').optional(),
  expireTime: timestamp('Expiration timestamp').optional(),
  createTime: timestamp('Creation timestamp').optional(),
  updateTime: timestamp('Last update timestamp').optional(),
  totalTokenCount: nonNegativeInt('Total cached tokens').optional(),
};

export const CacheSummarySchema = z.strictObject(cacheSummaryFields);

const sessionSummaryFields = {
  id: z.string().describe('Server-managed session identifier'),
  lastAccess: z.number().describe('Last access timestamp in epoch milliseconds'),
};

export const SessionSummarySchema = z.strictObject(sessionSummaryFields);

export function createFilePairFields(firstDescription: string, secondDescription: string) {
  return {
    filePathA: workspacePath(firstDescription),
    filePathB: workspacePath(secondDescription),
  };
}

export function createOptionalCacheReferenceFields(description: string) {
  return {
    cacheName: completableCacheName(description, true),
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
