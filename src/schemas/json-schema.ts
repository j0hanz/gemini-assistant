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

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
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
    .superRefine((schema, ctx) => {
      if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        schema.minimum > schema.maximum
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'maximum must be greater than or equal to minimum.',
          path: ['maximum'],
          input: schema.maximum,
        });
      }

      if (
        schema.minItems !== undefined &&
        schema.maxItems !== undefined &&
        schema.minItems > schema.maxItems
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'maxItems must be greater than or equal to minItems.',
          path: ['maxItems'],
          input: schema.maxItems,
        });
      }

      const propertyNames = schema.properties ? new Set(Object.keys(schema.properties)) : undefined;

      if (schema.required) {
        if (!propertyNames) {
          ctx.addIssue({
            code: 'custom',
            message: 'required can only be used when properties is present.',
            path: ['required'],
            input: schema.required,
          });
        } else {
          for (const [index, key] of schema.required.entries()) {
            if (!propertyNames.has(key)) {
              ctx.addIssue({
                code: 'custom',
                message: `required property "${key}" is not defined in properties.`,
                path: ['required', index],
                input: key,
              });
            }
          }
        }

        if (hasDuplicates(schema.required)) {
          ctx.addIssue({
            code: 'custom',
            message: 'required must not contain duplicate property names.',
            path: ['required'],
            input: schema.required,
          });
        }
      }

      if (schema.propertyOrdering) {
        if (!propertyNames) {
          ctx.addIssue({
            code: 'custom',
            message: 'propertyOrdering can only be used when properties is present.',
            path: ['propertyOrdering'],
            input: schema.propertyOrdering,
          });
        } else {
          for (const [index, key] of schema.propertyOrdering.entries()) {
            if (!propertyNames.has(key)) {
              ctx.addIssue({
                code: 'custom',
                message: `propertyOrdering entry "${key}" is not defined in properties.`,
                path: ['propertyOrdering', index],
                input: key,
              });
            }
          }
        }

        if (hasDuplicates(schema.propertyOrdering)) {
          ctx.addIssue({
            code: 'custom',
            message: 'propertyOrdering must not contain duplicate property names.',
            path: ['propertyOrdering'],
            input: schema.propertyOrdering,
          });
        }
      }
    })
    .refine(hasSchemaShape, {
      error:
        'responseSchema must contain at least one supported JSON Schema keyword (type, properties, required, additionalProperties, enum, format, minimum, maximum, items, prefixItems, minItems, maxItems, anyOf, oneOf, allOf, $ref, or propertyOrdering)',
    }),
);

export type GeminiResponseSchema = z.infer<typeof GeminiResponseSchema>;
