import { z } from 'zod/v4';

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

export function validateBounds(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  minimum: number | undefined,
  maximum: number | undefined,
  maximumPath: 'maximum' | 'maxItems',
  errorMessage: string,
): void {
  if (minimum === undefined || maximum === undefined || minimum <= maximum) {
    return;
  }

  addCustomIssue(ctx, errorMessage, [maximumPath], maximum);
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

interface ExclusiveSourceFileInput {
  sourceFilePath?: string | undefined;
  sourceFilePaths?: string[] | undefined;
}

export function validateExclusiveSourceFileFields(
  value: ExclusiveSourceFileInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  if (!value.sourceFilePath || !value.sourceFilePaths) {
    return;
  }

  addCustomIssue(
    ctx,
    'Provide sourceFilePath or sourceFilePaths, not both.',
    ['sourceFilePaths'],
    value.sourceFilePaths,
  );
}

interface MeaningfulCacheCreateInput {
  filePaths?: string[] | undefined;
  systemInstruction?: string | undefined;
}

export function validateMeaningfulCacheCreateInput(
  value: MeaningfulCacheCreateInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  const hasFilePathsField = value.filePaths !== undefined;
  const filePathCount = value.filePaths?.length ?? 0;
  const hasSystemInstruction = value.systemInstruction !== undefined;

  if (hasFilePathsField && filePathCount === 0) {
    addCustomIssue(
      ctx,
      'filePaths must be omitted or contain at least one path.',
      ['filePaths'],
      value.filePaths,
    );
  }

  if (!hasSystemInstruction && filePathCount === 0) {
    addCustomIssue(
      ctx,
      'Provide filePaths, systemInstruction, or both for caches.create.',
      ['filePaths'],
      value.filePaths,
    );
  }
}
