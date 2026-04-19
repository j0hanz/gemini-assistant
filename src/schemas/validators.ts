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
    if (value.urls !== undefined) {
      addForbiddenFieldIssue(ctx, 'urls', 'targetKind', value.targetKind, value.urls);
    }
    if (value.filePaths !== undefined) {
      addForbiddenFieldIssue(ctx, 'filePaths', 'targetKind', value.targetKind, value.filePaths);
    }
  } else if (value.targetKind === 'url') {
    if (!value.urls) {
      addCustomIssue(ctx, 'urls is required when targetKind=url.', ['urls'], value.urls);
    }
    if (value.filePath !== undefined) {
      addForbiddenFieldIssue(ctx, 'filePath', 'targetKind', value.targetKind, value.filePath);
    }
    if (value.filePaths !== undefined) {
      addForbiddenFieldIssue(ctx, 'filePaths', 'targetKind', value.targetKind, value.filePaths);
    }
  } else {
    if (!value.filePaths) {
      addCustomIssue(
        ctx,
        'filePaths is required when targetKind=multi.',
        ['filePaths'],
        value.filePaths,
      );
    }
    if (value.filePath !== undefined) {
      addForbiddenFieldIssue(ctx, 'filePath', 'targetKind', value.targetKind, value.filePath);
    }
    if (value.urls !== undefined) {
      addForbiddenFieldIssue(ctx, 'urls', 'targetKind', value.targetKind, value.urls);
    }
  }

  if (value.outputKind === 'summary') {
    if (value.diagramType !== undefined) {
      addForbiddenFieldIssue(ctx, 'diagramType', 'outputKind', value.outputKind, value.diagramType);
    }
    if (value.validateSyntax !== undefined) {
      addForbiddenFieldIssue(
        ctx,
        'validateSyntax',
        'outputKind',
        value.outputKind,
        value.validateSyntax,
      );
    }
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
    for (const [field, input] of [
      ['filePathA', value.filePathA],
      ['filePathB', value.filePathB],
      ['question', value.question],
      ['error', value.error],
      ['codeContext', value.codeContext],
      ['googleSearch', value.googleSearch],
      ['urls', value.urls],
    ] as const) {
      if (input !== undefined) {
        addForbiddenFieldIssue(ctx, field, 'subjectKind', value.subjectKind, input);
      }
    }
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
    for (const [field, input] of [
      ['dryRun', value.dryRun],
      ['language', value.language],
      ['error', value.error],
      ['codeContext', value.codeContext],
      ['urls', value.urls],
    ] as const) {
      if (input !== undefined) {
        addForbiddenFieldIssue(ctx, field, 'subjectKind', value.subjectKind, input);
      }
    }
    return;
  }

  if (!value.error) {
    addCustomIssue(ctx, 'error is required when subjectKind=failure.', ['error'], value.error);
  }
  for (const [field, input] of [
    ['dryRun', value.dryRun],
    ['filePathA', value.filePathA],
    ['filePathB', value.filePathB],
    ['question', value.question],
  ] as const) {
    if (input !== undefined) {
      addForbiddenFieldIssue(ctx, field, 'subjectKind', value.subjectKind, input);
    }
  }
}

export function validateFlatResearchInput(
  value: FlatResearchInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  if (value.mode === 'quick') {
    for (const [field, input] of [
      ['deliverable', value.deliverable],
      ['searchDepth', value.searchDepth],
    ] as const) {
      if (input !== undefined) {
        addForbiddenFieldIssue(ctx, field, 'mode', value.mode, input);
      }
    }
    return;
  }

  for (const [field, input] of [
    ['urls', value.urls],
    ['systemInstruction', value.systemInstruction],
  ] as const) {
    if (input !== undefined) {
      addForbiddenFieldIssue(ctx, field, 'mode', value.mode, input);
    }
  }
}

interface FlatMemoryInput {
  action:
    | 'sessions.list'
    | 'sessions.get'
    | 'sessions.transcript'
    | 'sessions.events'
    | 'caches.list'
    | 'caches.get'
    | 'caches.create'
    | 'caches.update'
    | 'caches.delete'
    | 'workspace.context'
    | 'workspace.cache';
  cacheName?: string | undefined;
  confirm?: boolean | undefined;
  displayName?: string | undefined;
  filePaths?: string[] | undefined;
  sessionId?: string | undefined;
  systemInstruction?: string | undefined;
  ttl?: string | undefined;
}

export function validateFlatMemoryInput(
  value: FlatMemoryInput,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  switch (value.action) {
    case 'sessions.list':
    case 'caches.list':
    case 'workspace.context':
    case 'workspace.cache': {
      for (const [field, input] of [
        ['sessionId', value.sessionId],
        ['cacheName', value.cacheName],
        ['filePaths', value.filePaths],
        ['systemInstruction', value.systemInstruction],
        ['ttl', value.ttl],
        ['displayName', value.displayName],
        ['confirm', value.confirm],
      ] as const) {
        if (input !== undefined) {
          addForbiddenFieldIssue(ctx, field, 'action', value.action, input);
        }
      }
      return;
    }
    case 'sessions.get':
    case 'sessions.transcript':
    case 'sessions.events': {
      if (!value.sessionId) {
        addCustomIssue(
          ctx,
          `sessionId is required when action=${value.action}.`,
          ['sessionId'],
          value.sessionId,
        );
      }
      for (const [field, input] of [
        ['cacheName', value.cacheName],
        ['filePaths', value.filePaths],
        ['systemInstruction', value.systemInstruction],
        ['ttl', value.ttl],
        ['displayName', value.displayName],
        ['confirm', value.confirm],
      ] as const) {
        if (input !== undefined) {
          addForbiddenFieldIssue(ctx, field, 'action', value.action, input);
        }
      }
      return;
    }
    case 'caches.get': {
      if (!value.cacheName) {
        addCustomIssue(
          ctx,
          'cacheName is required when action=caches.get.',
          ['cacheName'],
          value.cacheName,
        );
      }
      for (const [field, input] of [
        ['sessionId', value.sessionId],
        ['filePaths', value.filePaths],
        ['systemInstruction', value.systemInstruction],
        ['ttl', value.ttl],
        ['displayName', value.displayName],
        ['confirm', value.confirm],
      ] as const) {
        if (input !== undefined) {
          addForbiddenFieldIssue(ctx, field, 'action', value.action, input);
        }
      }
      return;
    }
    case 'caches.create': {
      validateMeaningfulCacheCreateInput(value, ctx);
      for (const [field, input] of [
        ['sessionId', value.sessionId],
        ['cacheName', value.cacheName],
        ['confirm', value.confirm],
      ] as const) {
        if (input !== undefined) {
          addForbiddenFieldIssue(ctx, field, 'action', value.action, input);
        }
      }
      return;
    }
    case 'caches.update': {
      if (!value.cacheName) {
        addCustomIssue(
          ctx,
          'cacheName is required when action=caches.update.',
          ['cacheName'],
          value.cacheName,
        );
      }
      if (!value.ttl) {
        addCustomIssue(ctx, 'ttl is required when action=caches.update.', ['ttl'], value.ttl);
      }
      for (const [field, input] of [
        ['sessionId', value.sessionId],
        ['filePaths', value.filePaths],
        ['systemInstruction', value.systemInstruction],
        ['displayName', value.displayName],
        ['confirm', value.confirm],
      ] as const) {
        if (input !== undefined) {
          addForbiddenFieldIssue(ctx, field, 'action', value.action, input);
        }
      }
      return;
    }
    case 'caches.delete': {
      if (!value.cacheName) {
        addCustomIssue(
          ctx,
          'cacheName is required when action=caches.delete.',
          ['cacheName'],
          value.cacheName,
        );
      }
      for (const [field, input] of [
        ['sessionId', value.sessionId],
        ['filePaths', value.filePaths],
        ['systemInstruction', value.systemInstruction],
        ['ttl', value.ttl],
        ['displayName', value.displayName],
      ] as const) {
        if (input !== undefined) {
          addForbiddenFieldIssue(ctx, field, 'action', value.action, input);
        }
      }
    }
  }
}
