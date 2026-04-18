import { z } from 'zod/v4';

import { validateBounds, validatePropertyKeyList } from './validators.js';

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
  'minItems',
  'maxItems',
  'anyOf',
  'oneOf',
  'allOf',
  'propertyOrdering',
] as const;

function hasSchemaShape(value: Record<string, unknown>): boolean {
  return RESPONSE_SCHEMA_SHAPE_KEYS.some((key) => key in value);
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
      minItems: z.int().nonnegative().optional(),
      maxItems: z.int().nonnegative().optional(),
      title: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      anyOf: z.array(GeminiResponseSchema).min(1).optional(),
      oneOf: z.array(GeminiResponseSchema).min(1).optional(),
      allOf: z.array(GeminiResponseSchema).min(1).optional(),
      propertyOrdering: z.array(z.string().min(1)).min(1).optional(),
    })
    .superRefine((schema, ctx) => {
      validateBounds(
        ctx,
        schema.minimum,
        schema.maximum,
        'maximum',
        'maximum must be greater than or equal to minimum.',
      );
      validateBounds(
        ctx,
        schema.minItems,
        schema.maxItems,
        'maxItems',
        'maxItems must be greater than or equal to minItems.',
      );

      const propertyNames = schema.properties ? new Set(Object.keys(schema.properties)) : undefined;

      validatePropertyKeyList(
        ctx,
        propertyNames,
        schema.required,
        'required',
        'required can only be used when properties is present.',
        'required must not contain duplicate property names.',
      );
      validatePropertyKeyList(
        ctx,
        propertyNames,
        schema.propertyOrdering,
        'propertyOrdering',
        'propertyOrdering can only be used when properties is present.',
        'propertyOrdering must not contain duplicate property names.',
      );
    })
    .refine(hasSchemaShape, {
      error:
        'responseSchema must contain at least one supported JSON Schema keyword (type, properties, required, additionalProperties, enum, format, minimum, maximum, items, minItems, maxItems, anyOf, oneOf, allOf, or propertyOrdering)',
    }),
);

export type GeminiResponseSchema = z.infer<typeof GeminiResponseSchema>;
