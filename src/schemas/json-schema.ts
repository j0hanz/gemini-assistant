import { z } from 'zod/v4';

import { validatePropertyKeyList } from './validators.js';

const JSON_LITERAL_SCHEMA = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const JSON_SCHEMA_TYPE_SCHEMA = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
]);

const RESPONSE_SCHEMA_SHAPE_KEYS = [
  'type',
  'properties',
  'required',
  'enum',
  'format',
  'items',
  'description',
  'nullable',
] as const;

function hasSchemaShape(value: Record<string, unknown>): boolean {
  return RESPONSE_SCHEMA_SHAPE_KEYS.some((key) => key in value);
}

function propertyNameField(description: string) {
  return z.string().min(1).describe(description);
}

function textField(description: string) {
  return z.string().trim().min(1).describe(description);
}

export const GeminiResponseSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .strictObject({
      type: JSON_SCHEMA_TYPE_SCHEMA.optional().describe('JSON Schema type for the output value.'),

      nullable: z.boolean().optional().describe('Allows the value to be null.'),

      properties: z
        .record(z.string(), GeminiResponseSchema)
        .optional()
        .describe('Property definitions for an object response.'),

      required: z
        .array(propertyNameField('Required property name.'))
        .optional()
        .describe('List of required object property names.'),

      enum: z
        .array(JSON_LITERAL_SCHEMA)
        .min(1)
        .optional()
        .describe('Fixed set of allowed literal values.'),

      format: textField('String format hint (e.g., "date-time", "email").').optional(),

      items: GeminiResponseSchema.optional().describe('Schema for array elements.'),

      title: textField('Short human-readable label.').optional(),

      description: textField(
        'Human-readable explanation of schema node. Crucial for guiding the LLM.',
      ).optional(),
    })
    .superRefine((schema, ctx) => {
      if (schema.required) {
        validatePropertyKeyList(
          ctx,
          schema.properties ? new Set(Object.keys(schema.properties)) : undefined,
          schema.required,
          'required',
          'required can only be used when properties is present.',
          'required must not contain duplicate property names.',
        );
      }
    })
    .refine(hasSchemaShape, {
      error:
        'responseSchema must contain at least one supported JSON Schema keyword (type, properties, required, enum, format, items, or description)',
    }),
);

export type GeminiResponseSchema = z.infer<typeof GeminiResponseSchema>;
