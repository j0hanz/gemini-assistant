import { z } from 'zod/v4';

const JSON_LITERAL_SCHEMA = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JSON_SCHEMA_TYPE_SCHEMA = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

export const GEMINI_RESPONSE_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'format',
  'minimum',
  'maximum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'title',
  'description',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  '$schema',
  '$id',
  'propertyOrdering',
] as const;

const GEMINI_RESPONSE_SCHEMA_KEYWORD_SET = new Set<string>(GEMINI_RESPONSE_SCHEMA_KEYWORDS);
const RESPONSE_SCHEMA_SHAPE_KEYS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'format',
  'minimum',
  'maximum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  'propertyOrdering',
] as const;

function hasSchemaShape(value: Record<string, unknown>): boolean {
  return RESPONSE_SCHEMA_SHAPE_KEYS.some((key) => key in value);
}

export function isGeminiResponseSchemaKeyword(key: string): boolean {
  return GEMINI_RESPONSE_SCHEMA_KEYWORD_SET.has(key);
}

export const GeminiResponseSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .strictObject({
      type: z.union([JSON_SCHEMA_TYPE_SCHEMA, z.array(JSON_SCHEMA_TYPE_SCHEMA).min(1)]).optional(),
      properties: z.record(z.string(), GeminiResponseSchema).optional(),
      required: z.array(z.string().min(1)).min(1).optional(),
      additionalProperties: z.union([z.boolean(), GeminiResponseSchema]).optional(),
      enum: z.array(JSON_LITERAL_SCHEMA).min(1).optional(),
      format: z.string().min(1).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      items: z.union([GeminiResponseSchema, z.array(GeminiResponseSchema).min(1)]).optional(),
      prefixItems: z.array(GeminiResponseSchema).min(1).optional(),
      minItems: z.int().nonnegative().optional(),
      maxItems: z.int().nonnegative().optional(),
      title: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      anyOf: z.array(GeminiResponseSchema).min(1).optional(),
      oneOf: z.array(GeminiResponseSchema).min(1).optional(),
      allOf: z.array(GeminiResponseSchema).min(1).optional(),
      $ref: z.string().min(1).optional(),
      $schema: z.string().min(1).optional(),
      $id: z.string().min(1).optional(),
      propertyOrdering: z.array(z.string().min(1)).min(1).optional(),
    })
    .refine(hasSchemaShape, {
      error:
        'responseSchema must contain at least one supported JSON Schema keyword (type, properties, required, additionalProperties, enum, format, minimum, maximum, items, prefixItems, minItems, maxItems, anyOf, oneOf, allOf, $ref, or propertyOrdering)',
    }),
);

export type GeminiResponseSchema = z.infer<typeof GeminiResponseSchema>;
