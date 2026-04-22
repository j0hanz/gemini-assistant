import { z } from 'zod/v4';

import type { AnalyzeInputBaseSchema, ResearchInputBaseSchema } from './inputs.js';

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

type FlatAnalyzeInput = z.input<typeof AnalyzeInputBaseSchema>;

function addForbiddenFieldIssue(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  field: string,
  selector: string,
  selectorValue: string,
  input: unknown,
): void {
  addCustomIssue(ctx, `${field} is not allowed when ${selector}=${selectorValue}.`, [field], input);
}

function forbidFields(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  value: unknown,
  fields: readonly string[],
  selector: string,
  selectorValue: string,
): void {
  const obj = value as Record<string, unknown>;
  for (const field of fields) {
    if (obj[field] !== undefined) {
      addForbiddenFieldIssue(ctx, field, selector, selectorValue, obj[field]);
    }
  }
}

export function validateFlatAnalyzeInput(
  value: FlatAnalyzeInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  const targetKind = value.targetKind ?? 'file';
  const outputKind = value.outputKind ?? 'summary';

  if (targetKind === 'file') {
    if (!value.filePath) {
      addCustomIssue(
        ctx,
        'filePath is required when targetKind=file.',
        ['filePath'],
        value.filePath,
      );
    }
    forbidFields(ctx, value, ['urls', 'filePaths'], 'targetKind', targetKind);
  } else if (targetKind === 'url') {
    if (!value.urls) {
      addCustomIssue(ctx, 'urls is required when targetKind=url.', ['urls'], value.urls);
    }
    forbidFields(ctx, value, ['filePath', 'filePaths'], 'targetKind', targetKind);
  } else {
    if (!value.filePaths) {
      addCustomIssue(
        ctx,
        'filePaths is required when targetKind=multi.',
        ['filePaths'],
        value.filePaths,
      );
    }
    forbidFields(ctx, value, ['filePath', 'urls'], 'targetKind', targetKind);
  }

  if (outputKind === 'summary') {
    forbidFields(ctx, value, ['validateSyntax'], 'outputKind', outputKind);
  }
}

type FlatResearchInput = z.input<typeof ResearchInputBaseSchema>;

export function validateFlatResearchInput(
  value: FlatResearchInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  const mode = value.mode ?? 'quick';

  if (mode === 'quick') {
    forbidFields(ctx, value, ['deliverable'], 'mode', mode);
    return;
  }

  forbidFields(ctx, value, ['urls', 'systemInstruction'], 'mode', mode);
}
