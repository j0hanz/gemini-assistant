import { z } from 'zod/v4';

import { textField } from './fields.js';
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

function propertyNameField(description: string) {
  return z.string().min(1).describe(description);
}

export const GeminiResponseSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .strictObject({
      type: z
        .union([JSON_SCHEMA_TYPE_SCHEMA, z.array(JSON_SCHEMA_TYPE_SCHEMA).min(1)])
        .optional()
        .describe('JSON Schema type for the output value.'),
      properties: z
        .record(z.string(), GeminiResponseSchema)
        .optional()
        .describe('Property definitions for an object response.'),
      required: z
        .array(propertyNameField('Required property name.'))
        .min(1)
        .optional()
        .describe('List of required object property names.'),
      additionalProperties: z
        .union([z.boolean(), GeminiResponseSchema])
        .optional()
        .describe('Controls whether object keys outside properties are allowed.'),
      enum: z
        .array(JSON_LITERAL_SCHEMA)
        .min(1)
        .optional()
        .describe('Fixed set of allowed literal values.'),
      format: textField('String format hint (e.g., "date-time", "email").').optional(),
      minimum: z.number().optional().describe('Inclusive minimum numeric value.'),
      maximum: z.number().optional().describe('Inclusive maximum numeric value.'),
      items: z
        .union([GeminiResponseSchema, z.array(GeminiResponseSchema).min(1)])
        .optional()
        .describe('Schema for array elements.'),
      minItems: z.int().nonnegative().optional().describe('Minimum number of items in array.'),
      maxItems: z.int().nonnegative().optional().describe('Maximum number of items in array.'),
      title: textField('Short human-readable label.').optional(),
      description: textField('Human-readable explanation of schema node.').optional(),
      anyOf: z
        .array(GeminiResponseSchema)
        .min(1)
        .optional()
        .describe('Alternative schemas (matches any one).'),
      oneOf: z
        .array(GeminiResponseSchema)
        .min(1)
        .optional()
        .describe('Alternative schemas (matches exactly one).'),
      allOf: z
        .array(GeminiResponseSchema)
        .min(1)
        .optional()
        .describe('Schemas that all apply to the same value.'),
      propertyOrdering: z
        .array(propertyNameField('Property name for ordering.'))
        .min(1)
        .optional()
        .describe('Preferred property order for object output.'),
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
