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
        .describe(
          'JSON Schema type for the output value. Use a single type such as "object" or "string", or an array of types when multiple types are allowed.',
        ),
      properties: z
        .record(z.string(), GeminiResponseSchema)
        .optional()
        .describe(
          'Property definitions for an object response. Use when type is "object" and each key should have its own nested schema.',
        ),
      required: z
        .array(propertyNameField('Property name that must be present in the object response.'))
        .min(1)
        .optional()
        .describe(
          'List of object property names that must be included. Use only together with properties.',
        ),
      additionalProperties: z
        .union([z.boolean(), GeminiResponseSchema])
        .optional()
        .describe(
          'Controls whether object keys outside properties are allowed. Use false to forbid extras, true to allow any extras, or provide a schema to validate additional values.',
        ),
      enum: z
        .array(JSON_LITERAL_SCHEMA)
        .min(1)
        .optional()
        .describe(
          'Fixed set of allowed literal values. Use when the response must be one of a known list of strings, numbers, booleans, or null.',
        ),
      format: textField(
        'String format hint such as "date-time", "email", or another JSON Schema format. Use when a string should follow a standard format.',
      ).optional(),
      minimum: z
        .number()
        .optional()
        .describe('Inclusive minimum numeric value. Use for number or integer schemas.'),
      maximum: z
        .number()
        .optional()
        .describe('Inclusive maximum numeric value. Use for number or integer schemas.'),
      items: z
        .union([GeminiResponseSchema, z.array(GeminiResponseSchema).min(1)])
        .optional()
        .describe(
          'Schema for array elements. Use a single schema when all items share one shape, or an array of schemas for tuple-style arrays.',
        ),
      minItems: z
        .int()
        .nonnegative()
        .optional()
        .describe(
          'Minimum number of items allowed in an array. Use when array length has a lower bound.',
        ),
      maxItems: z
        .int()
        .nonnegative()
        .optional()
        .describe(
          'Maximum number of items allowed in an array. Use when array length has an upper bound.',
        ),
      title: textField(
        'Short human-readable label for this schema node. Use when clients should display a friendly title for the field or object.',
      ).optional(),
      description: textField(
        'Human-readable explanation of what this schema node represents. Use to document the meaning, constraints, or intended usage of the field.',
      ).optional(),
      anyOf: z
        .array(GeminiResponseSchema)
        .min(1)
        .optional()
        .describe(
          'Alternative schemas where the value may match any one of them. Use when multiple different shapes are acceptable.',
        ),
      oneOf: z
        .array(GeminiResponseSchema)
        .min(1)
        .optional()
        .describe(
          'Alternative schemas where the value should match exactly one branch. Use for mutually exclusive output shapes.',
        ),
      allOf: z
        .array(GeminiResponseSchema)
        .min(1)
        .optional()
        .describe(
          'Schemas that all apply to the same value. Use to combine constraints from multiple schema fragments.',
        ),
      propertyOrdering: z
        .array(
          propertyNameField('Property name in the order Gemini should emit it in object output.'),
        )
        .min(1)
        .optional()
        .describe(
          'Preferred property order for object output. Use with properties when stable key ordering matters for Gemini responses.',
        ),
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
