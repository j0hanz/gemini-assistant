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

interface FlatAnalyzeInput {
  diagramType?: string | undefined;
  filePath?: string | undefined;
  filePaths?: string[] | undefined;
  outputKind: 'summary' | 'diagram';
  targetKind: 'file' | 'url' | 'multi';
  urls?: string[] | undefined;
  validateSyntax?: boolean | undefined;
}

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
  if (value.targetKind === 'file') {
    if (!value.filePath) {
      addCustomIssue(
        ctx,
        'filePath is required when targetKind=file.',
        ['filePath'],
        value.filePath,
      );
    }
    forbidFields(ctx, value, ['urls', 'filePaths'], 'targetKind', value.targetKind);
  } else if (value.targetKind === 'url') {
    if (!value.urls) {
      addCustomIssue(ctx, 'urls is required when targetKind=url.', ['urls'], value.urls);
    }
    forbidFields(ctx, value, ['filePath', 'filePaths'], 'targetKind', value.targetKind);
  } else {
    if (!value.filePaths) {
      addCustomIssue(
        ctx,
        'filePaths is required when targetKind=multi.',
        ['filePaths'],
        value.filePaths,
      );
    }
    forbidFields(ctx, value, ['filePath', 'urls'], 'targetKind', value.targetKind);
  }

  if (value.outputKind === 'summary') {
    forbidFields(ctx, value, ['diagramType', 'validateSyntax'], 'outputKind', value.outputKind);
  }
}

interface FlatReviewInput {
  codeContext?: string | undefined;
  dryRun?: boolean | undefined;
  error?: string | undefined;
  filePathA?: string | undefined;
  filePathB?: string | undefined;
  googleSearch?: boolean | undefined;
  language?: string | undefined;
  question?: string | undefined;
  subjectKind: 'diff' | 'comparison' | 'failure';
  urls?: string[] | undefined;
}

interface FlatResearchInput {
  deliverable?: string | undefined;
  goal: string;
  mode: 'quick' | 'deep';
  searchDepth?: number | undefined;
  systemInstruction?: string | undefined;
  urls?: string[] | undefined;
}

export function validateFlatReviewInput(
  value: FlatReviewInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  if (value.subjectKind === 'diff') {
    forbidFields(
      ctx,
      value,
      ['filePathA', 'filePathB', 'question', 'error', 'codeContext', 'googleSearch', 'urls'],
      'subjectKind',
      value.subjectKind,
    );
    return;
  }

  if (value.subjectKind === 'comparison') {
    if (!value.filePathA) {
      addCustomIssue(
        ctx,
        'filePathA is required when subjectKind=comparison.',
        ['filePathA'],
        value.filePathA,
      );
    }
    if (!value.filePathB) {
      addCustomIssue(
        ctx,
        'filePathB is required when subjectKind=comparison.',
        ['filePathB'],
        value.filePathB,
      );
    }
    forbidFields(
      ctx,
      value,
      ['dryRun', 'language', 'error', 'codeContext', 'urls'],
      'subjectKind',
      value.subjectKind,
    );
    return;
  }

  if (!value.error) {
    addCustomIssue(ctx, 'error is required when subjectKind=failure.', ['error'], value.error);
  }
  forbidFields(
    ctx,
    value,
    ['dryRun', 'filePathA', 'filePathB', 'question'],
    'subjectKind',
    value.subjectKind,
  );
}

export function validateFlatResearchInput(
  value: FlatResearchInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  if (value.mode === 'quick') {
    forbidFields(ctx, value, ['deliverable', 'searchDepth'], 'mode', value.mode);
    return;
  }

  forbidFields(ctx, value, ['urls', 'systemInstruction'], 'mode', value.mode);
}

export const MEMORY_ACTIONS = [
  'sessions.list',
  'sessions.get',
  'sessions.transcript',
  'sessions.events',
  'caches.list',
  'caches.get',
  'caches.create',
  'caches.update',
  'caches.delete',
  'workspace.context',
  'workspace.cache',
] as const;

export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

interface FlatMemoryInput {
  action: MemoryAction;
  sessionId?: string | undefined;
  cacheName?: string | undefined;
  filePaths?: string[] | undefined;
  systemInstruction?: string | undefined;
  ttl?: string | undefined;
  displayName?: string | undefined;
  confirm?: boolean | undefined;
}

const MEMORY_CACHE_CREATE_FIELDS = [
  'filePaths',
  'systemInstruction',
  'ttl',
  'displayName',
] as const;
const MEMORY_ALL_OPTIONAL_FIELDS = [
  'sessionId',
  'cacheName',
  'filePaths',
  'systemInstruction',
  'ttl',
  'displayName',
  'confirm',
] as const;

function forbidMemoryFieldsExcept(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  value: FlatMemoryInput,
  allowed: readonly string[],
): void {
  const disallowed = MEMORY_ALL_OPTIONAL_FIELDS.filter((field) => !allowed.includes(field));
  forbidFields(ctx, value, disallowed, 'action', value.action);
}

function requireMemoryField(
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
  value: FlatMemoryInput,
  field: 'sessionId' | 'cacheName' | 'ttl',
): void {
  if (value[field] === undefined) {
    addCustomIssue(ctx, `${field} is required when action=${value.action}.`, [field], value[field]);
  }
}

export function validateFlatMemoryInput(
  value: FlatMemoryInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  switch (value.action) {
    case 'sessions.list':
    case 'caches.list':
    case 'workspace.context':
    case 'workspace.cache':
      forbidMemoryFieldsExcept(ctx, value, []);
      return;
    case 'sessions.get':
    case 'sessions.transcript':
    case 'sessions.events':
      requireMemoryField(ctx, value, 'sessionId');
      forbidMemoryFieldsExcept(ctx, value, ['sessionId']);
      return;
    case 'caches.get':
      requireMemoryField(ctx, value, 'cacheName');
      forbidMemoryFieldsExcept(ctx, value, ['cacheName']);
      return;
    case 'caches.create':
      forbidMemoryFieldsExcept(ctx, value, MEMORY_CACHE_CREATE_FIELDS);
      validateMeaningfulCacheCreateInput(value, ctx);
      return;
    case 'caches.update':
      requireMemoryField(ctx, value, 'cacheName');
      requireMemoryField(ctx, value, 'ttl');
      forbidMemoryFieldsExcept(ctx, value, ['cacheName', 'ttl']);
      return;
    case 'caches.delete':
      requireMemoryField(ctx, value, 'cacheName');
      forbidMemoryFieldsExcept(ctx, value, ['cacheName', 'confirm']);
      return;
  }
}
