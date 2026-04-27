import type { z } from 'zod/v4';

type IssuePath = (string | number)[];

function addCustomIssue(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  message: string,
  path: IssuePath,
  input: unknown,
): void {
  ctx.addIssue({
    code: 'custom',
    message,
    path,
    input,
  });
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatSchemaPath(path: (string | number)[]): string {
  return path.length === 0 ? 'root' : path.join('.');
}

function addSchemaError(errors: string[], path: (string | number)[], message: string): void {
  errors.push(`${formatSchemaPath(path)}: ${message}`);
}

function collectLocalDefRefs(schema: unknown): string[] {
  const refs = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isRecord(value)) return;

    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
      refs.add(value.$ref.slice('#/$defs/'.length));
    }

    for (const nestedValue of Object.values(value)) {
      visit(nestedValue);
    }
  };

  visit(schema);
  return [...refs];
}

function hasCircularDefRefs(defs: Record<string, unknown>): boolean {
  const graph = new Map<string, string[]>();
  for (const [name, schema] of Object.entries(defs)) {
    graph.set(
      name,
      collectLocalDefRefs(schema).filter((ref) => ref in defs),
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;

    visiting.add(name);
    for (const ref of graph.get(name) ?? []) {
      if (visit(ref)) return true;
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  };

  for (const name of graph.keys()) {
    if (visit(name)) return true;
  }

  return false;
}

function walkGeminiJsonSchema(value: unknown, path: (string | number)[], errors: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkGeminiJsonSchema(item, [...path, index], errors);
    }
    return;
  }

  if (!isRecord(value)) return;

  if (path.length === 0 && ('oneOf' in value || 'anyOf' in value)) {
    addSchemaError(errors, path, 'oneOf/anyOf are not supported at the root schema.');
  }

  if ('$ref' in value) {
    addSchemaError(errors, [...path, '$ref'], '$ref is not supported.');
  }
  if ('$dynamicRef' in value) {
    addSchemaError(errors, [...path, '$dynamicRef'], '$dynamicRef is not supported.');
  }
  if ('if' in value || 'then' in value || 'else' in value) {
    addSchemaError(errors, path, 'if/then/else are not supported.');
  }
  if ('dependentSchemas' in value) {
    addSchemaError(errors, [...path, 'dependentSchemas'], 'dependentSchemas is not supported.');
  }
  if ('unevaluatedProperties' in value) {
    addSchemaError(
      errors,
      [...path, 'unevaluatedProperties'],
      'unevaluatedProperties is not supported.',
    );
  }
  if ('contentEncoding' in value) {
    addSchemaError(errors, [...path, 'contentEncoding'], 'contentEncoding is not supported.');
  }

  if ('$defs' in value) {
    const defs = value.$defs;
    if (isRecord(defs)) {
      if (hasCircularDefRefs(defs)) {
        addSchemaError(errors, [...path, '$defs'], '$defs contains circular references.');
      }

      for (const [name, defSchema] of Object.entries(defs)) {
        walkGeminiJsonSchema(defSchema, [...path, '$defs', name], errors);
      }
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === '$defs') continue;
    walkGeminiJsonSchema(nestedValue, [...path, key], errors);
  }
}

export function validateGeminiJsonSchema(schema: unknown): string[] {
  const errors: string[] = [];
  walkGeminiJsonSchema(schema, [], errors);
  return [...new Set(errors)];
}

export function validatePropertyKeyList(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  propertyNames: Set<string> | undefined,
  values: string[] | undefined,
  path: 'required' | 'propertyOrdering',
  missingMessage: string,
  duplicateMessage: string,
): void {
  if (!values) {
    return;
  }

  if (!propertyNames) {
    addCustomIssue(ctx, missingMessage, [path], values);
  } else {
    for (const [index, key] of values.entries()) {
      if (!propertyNames.has(key)) {
        addCustomIssue(
          ctx,
          `${path} ${path === 'required' ? 'property' : 'entry'} "${key}" is not defined in properties.`,
          [path, index],
          key,
        );
      }
    }
  }

  if (hasDuplicates(values)) {
    addCustomIssue(ctx, duplicateMessage, [path], values);
  }
}
