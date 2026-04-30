---
goal: Apply three mechanical @google/genai best-practice fixes: ApiError integration, thinkingBudget removal, and parametersJsonSchema field-name correction
version: 1
date_created: 2026-04-30
status: Planned
plan_type: refactor
component: genai-mechanical-fixes
execution: subagent-driven
---

# Implementation Plan: `@google/genai` Mechanical Fixes (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Remove three known defects from the `@google/genai` integration without changing any observable public behaviour: add `ApiError` as the primary SDK error classifier, delete `thinkingBudget` from every layer of the stack, and fix `parameters` → `parametersJsonSchema` in function declarations.

**Architecture:** All three changes are mechanical and independent. They are sequenced so type errors cascade downward — schema removal in [src/schemas/fields.ts](src/schemas/fields.ts) and [src/schemas/inputs.ts](src/schemas/inputs.ts) produces TypeScript compile errors in [src/client.ts](src/client.ts) and all four tool files, making each remaining deletion self-verifying. The `ApiError` change and `parametersJsonSchema` fix are isolated to single files.

**Tech Stack:** TypeScript strict mode, `@google/genai` SDK, Zod v4, Node built-in test runner (`node --test`), `node scripts/tasks.mjs` for the full verification suite.

---

## 1. Goal

Replace duck-typed SDK error detection with `instanceof ApiError`, delete the deprecated `thinkingBudget` token-count knob from every schema, config, builder, and tool file, and correct `parameters:` to `parametersJsonSchema:` in the function-declaration builder. After this plan the codebase will compile cleanly, all existing tests will pass, and no caller path will reference `thinkingBudget`.

## 2. Requirements & Constraints

| ID | Type | Statement |
| :--- | :--- | :--- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `AppError.isRetryable` and `AppError.from` check `err instanceof ApiError` before duck-typing `.status`. |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Network-code errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`) remain retryable after the `ApiError` change — the duck-type fallback is load-bearing. |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `thinkingBudget` is absent from all Zod schemas, `ConfigBuilderOptions`, `buildThinkingConfig`, `buildResponseConfig`, `buildGenerateContentConfig`, and every internal arg type in the four tool files. |
| [`REQ-004`](#2-requirements--constraints) | Requirement | `GEMINI_THINKING_BUDGET_CAP` env var and its parser `getThinkingBudgetCap` are deleted from [src/config.ts](src/config.ts). |
| [`REQ-005`](#2-requirements--constraints) | Requirement | Passing `thinkingBudget` to any public tool schema is rejected (`safeParse` returns `success: false`). |
| [`REQ-006`](#2-requirements--constraints) | Requirement | `buildToolsArray` emits `parametersJsonSchema:` (not `parameters:`) when building function declarations. |
| [`CON-001`](#2-requirements--constraints) | Constraint | No `console.log` — use `logger` from [src/lib/logger.ts](src/lib/logger.ts) (stdio transport constraint). |
| [`CON-002`](#2-requirements--constraints) | Constraint | Breaking changes are intentional — no backward-compat shims or deprecation warnings for removed fields. |
| [`CON-003`](#2-requirements--constraints) | Constraint | Run `node scripts/tasks.mjs` before every commit step. |
| [`PAT-001`](#2-requirements--constraints) | Pattern | Follow [withRetry](src/lib/errors.ts#L285) retry pattern — `AppError.isRetryable` is the single retryability gate. |

## 3. Current Context

### File structure

| File | Status | Responsibility |
| :--- | :--- | :--- |
| [src/lib/errors.ts](src/lib/errors.ts) | Modify | SDK error classification — add `ApiError` import, update `classifyError` |
| [src/schemas/fields.ts](src/schemas/fields.ts) | Modify | Zod field builders — delete `thinkingBudget` export |
| [src/schemas/inputs.ts](src/schemas/inputs.ts) | Modify | Public tool input schemas — remove `thinkingBudget` from all five schemas |
| [src/client.ts](src/client.ts) | Modify | Config builder — remove `thinkingBudget` from `ConfigBuilderOptions`, `buildThinkingConfig`, `buildResponseConfig`, `buildGenerateContentConfig` |
| [src/config.ts](src/config.ts) | Modify | Env-var parsers — delete `getThinkingBudgetCap` and `GEMINI_THINKING_BUDGET_CAP` |
| [src/tools/chat.ts](src/tools/chat.ts) | Modify | Chat tool — remove `thinkingBudget` destructuring and pass-through |
| [src/tools/research.ts](src/tools/research.ts) | Modify | Research tool — remove `thinkingBudget` from internal types and all call sites |
| [src/tools/analyze.ts](src/tools/analyze.ts) | Modify | Analyze tool — remove `thinkingBudget` from internal types and call sites |
| [src/tools/review.ts](src/tools/review.ts) | Modify | Review tool — remove `thinkingBudget` from internal types and call sites |
| [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts) | Modify | Profile SDK builder — fix `parameters:` → `parametersJsonSchema:` in `buildToolsArray` |
| [__tests__/lib/errors.test.ts](__tests__/lib/errors.test.ts) | Modify | Add network-fallback regression test |
| [__tests__/client.test.ts](__tests__/client.test.ts) | Modify | Delete obsolete `thinkingBudget` warning test |
| [__tests__/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) | Modify | Add test asserting `thinkingBudget` is rejected |
| [__tests__/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) | Modify | Add `parametersJsonSchema` field-name test |

### Relevant symbols

| Symbol | Why it matters |
| :--- | :--- |
| [classifyError](src/lib/errors.ts#L242) | Insert `instanceof ApiError` check before duck-type |
| [AppError](src/lib/errors.ts#L34) | Parent; `.from` and `.isRetryable` call `classifyError` |
| [withRetry](src/lib/errors.ts#L285) | Consumes `AppError.isRetryable` — must still work after change |
| [thinkingBudget](src/schemas/fields.ts#L167) | Field builder to delete |
| [buildThinkingConfig](src/client.ts#L100) | Simplifies to single-arg after removal |
| [buildResponseConfig](src/client.ts#L163) | Drops `thinkingBudget` parameter |
| [buildGenerateContentConfig](src/client.ts#L189) | Drops `thinkingBudget` from `ConfigBuilderOptions` destructure |
| [getThinkingBudgetCap](src/config.ts#L360) | Entire function deleted |
| [buildToolsArray](src/lib/tool-profiles.ts#L392) | Fix `parameters:` → `parametersJsonSchema:` |
| [FunctionDeclarationInput](src/lib/tool-profiles.ts#L180) | Input type whose `parametersJsonSchema` field is passed through |
| [resolveProfile](src/lib/tool-profiles.ts#L269) | Used in test to build a `ResolvedProfile` fixture |

### Existing commands

```bash
# Full verification suite (format → lint/type-check/knip → test/build)
node scripts/tasks.mjs

# Single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts
```

### Current behaviour

`classifyError` duck-types `.status` to detect SDK errors rather than using `instanceof ApiError`. `thinkingBudget` is accepted by all four public tool schemas, threaded through every arg type, and applied via `buildThinkingConfig` — a deprecated Gemini 3.0 knob. `buildToolsArray` emits `{ parameters: decl.parametersJsonSchema }`, using the wrong field name for raw JSON schema objects.

## 4. Implementation Phases

### PHASE-001: ApiError integration

**Goal:** `classifyError` checks `err instanceof ApiError` before duck-typing; network-code errors remain retryable.

| Task | Action | Depends on | Files | Validate |
| :--- | :--- | :--- | :--- | :--- |
| [`TASK-001`](#task-001-add-apierror-to-classifyerror) | Add `ApiError` import and primary `instanceof` branch | none | [src/lib/errors.ts](src/lib/errors.ts), [__tests__/lib/errors.test.ts](__tests__/lib/errors.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts` |

#### TASK-001: Add `ApiError` to `classifyError`

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | Modify: [src/lib/errors.ts](src/lib/errors.ts); Modify: [__tests__/lib/errors.test.ts](__tests__/lib/errors.test.ts) |
| Symbols | [classifyError](src/lib/errors.ts#L242), [AppError](src/lib/errors.ts#L34), [withRetry](src/lib/errors.ts#L285) |
| Outcome | `classifyError` uses `instanceof ApiError` as primary branch; `ECONNRESET` errors are still retryable via the duck-type fallback; existing tests pass unchanged. TDD skipped: the change is additive — `ApiError` has a `.status` property so duck-type already catches it; the obligation is to preserve the network-error fallback, which is tested below. |

- [ ] **Step 1: Apply change** — add regression test for network-error fallback to [__tests__/lib/errors.test.ts](__tests__/lib/errors.test.ts)

```ts
// __tests__/lib/errors.test.ts  — append after existing tests
test('AppError.isRetryable — ECONNRESET network error is retryable (fallback preserved)', () => {
  const networkError = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  assert.strictEqual(AppError.isRetryable(networkError), true);
});

test('AppError.isRetryable — nested cause ECONNRESET is retryable (fallback preserved)', () => {
  const wrapper = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
  });
  assert.strictEqual(AppError.isRetryable(wrapper), true);
});

test('AppError.from — HTTP 429 error is classified as retryable server error', () => {
  const httpErr = Object.assign(new Error('rate limited'), { status: 429 });
  const appErr = AppError.from(httpErr, 'chat');
  assert.strictEqual(appErr.retryable, true);
  assert.strictEqual(appErr.category, 'server');
});
```

- [ ] **Step 2: Verify tests pass (baseline)**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: all tests PASS (new regression tests already pass with duck-type, confirming they are valid guards).

- [ ] **Step 3: Update `classifyError` in [src/lib/errors.ts](src/lib/errors.ts)**

Replace the import line at the top of the file:

```ts
// Before
import { FinishReason } from '@google/genai';

// After
import { ApiError, FinishReason } from '@google/genai';
```

Replace [classifyError](src/lib/errors.ts#L242):

```ts
// Before
function classifyError(err: unknown, signal?: AbortSignal): ClassifiedError {
  if (isAbortError(err, signal)) return { kind: 'abort' };
  if (hasHttpStatus(err)) return { kind: 'http', status: err.status };
  return { kind: 'other' };
}

// After
function classifyError(err: unknown, signal?: AbortSignal): ClassifiedError {
  if (isAbortError(err, signal)) return { kind: 'abort' };
  if (err instanceof ApiError) return { kind: 'http', status: err.status };
  if (hasHttpStatus(err)) return { kind: 'http', status: err.status };
  return { kind: 'other' };
}
```

- [ ] **Step 4: Verify all error tests pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/errors.ts __tests__/lib/errors.test.ts
git commit -m "refactor(errors): use instanceof ApiError as primary SDK error check"
```

---

### PHASE-002: Remove `thinkingBudget`

**Goal:** `thinkingBudget` is absent from all schemas, config, builders, and tool files; the full suite compiles and passes.

| Task | Action | Depends on | Files | Validate |
| :--- | :--- | :--- | :--- | :--- |
| [`TASK-002`](#task-002-remove-thinkingbudget-from-schemas) | Delete field builder and remove from all input schemas | none | [src/schemas/fields.ts](src/schemas/fields.ts), [src/schemas/inputs.ts](src/schemas/inputs.ts), [__tests__/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts` |
| [`TASK-003`](#task-003-remove-thinkingbudget-from-client-and-config) | Simplify `buildThinkingConfig`; delete `getThinkingBudgetCap` | [`TASK-002`](#task-002-remove-thinkingbudget-from-schemas) | [src/client.ts](src/client.ts), [src/config.ts](src/config.ts), [__tests__/client.test.ts](__tests__/client.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/client.test.ts` |
| [`TASK-004`](#task-004-remove-thinkingbudget-from-tool-files) | Remove all `thinkingBudget` references from four tool files | [`TASK-003`](#task-003-remove-thinkingbudget-from-client-and-config) | [src/tools/chat.ts](src/tools/chat.ts), [src/tools/research.ts](src/tools/research.ts), [src/tools/analyze.ts](src/tools/analyze.ts), [src/tools/review.ts](src/tools/review.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-002: Remove `thinkingBudget` from schemas

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | Modify: [src/schemas/fields.ts](src/schemas/fields.ts); Modify: [src/schemas/inputs.ts](src/schemas/inputs.ts); Modify: [__tests__/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) |
| Symbols | [thinkingBudget](src/schemas/fields.ts#L167) |
| Outcome | `thinkingBudget` field builder is deleted; passing `thinkingBudget` to any public schema returns `success: false`; inputs test suite passes. |

- [ ] **Step 1: Write failing test** — add to [__tests__/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts)

```ts
// __tests__/schemas/inputs.test.ts  — append after existing tests
test('ChatInputSchema — thinkingBudget field is rejected (removed field)', () => {
  const result = ChatInputSchema.safeParse({ goal: 'hello', thinkingBudget: 1000 });
  assert.strictEqual(result.success, false);
});

test('ResearchInputSchema — thinkingBudget field is rejected (removed field)', () => {
  const result = ResearchInputSchema.safeParse({ goal: 'hello', thinkingBudget: 1000 });
  assert.strictEqual(result.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
```

Expected: FAIL — `thinkingBudget field is rejected` tests fail because the field is currently accepted.

- [ ] **Step 3: Delete `thinkingBudget` from [src/schemas/fields.ts](src/schemas/fields.ts) and [src/schemas/inputs.ts](src/schemas/inputs.ts)**

In [src/schemas/fields.ts](src/schemas/fields.ts), delete the entire `thinkingBudget` function (lines 167–171):

```ts
// DELETE this block entirely:
export function thinkingBudget(
  description = 'Override thinking token budget. Applied only when `thinkingLevel` is omitted; `thinkingLevel` takes precedence when both are set.',
) {
  return withFieldMetadata(z.number().int().min(0).optional(), description);
}
```

In [src/schemas/inputs.ts](src/schemas/inputs.ts), make the following edits:

```ts
// 1. Remove from the import list (line 23):
// DELETE:  thinkingBudget,

// 2. Delete the field alias declaration (line 124):
// DELETE:  const thinkingBudgetField = thinkingBudget();

// 3. Remove from every schema object — these five lines, one per schema:
// DELETE:  thinkingBudget: thinkingBudgetField,
// (appears at lines 196, 272, 354, 374, 436 — delete all five occurrences)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/fields.ts src/schemas/inputs.ts __tests__/schemas/inputs.test.ts
git commit -m "refactor(schemas): remove deprecated thinkingBudget field from all input schemas"
```

---

#### TASK-003: Remove `thinkingBudget` from `client.ts` and `config.ts`

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-002`](#task-002-remove-thinkingbudget-from-schemas) |
| Files | Modify: [src/client.ts](src/client.ts); Modify: [src/config.ts](src/config.ts); Modify: [__tests__/client.test.ts](__tests__/client.test.ts) |
| Symbols | [buildThinkingConfig](src/client.ts#L100), [buildResponseConfig](src/client.ts#L163), [buildGenerateContentConfig](src/client.ts#L189), [getThinkingBudgetCap](src/config.ts#L360) |
| Outcome | `buildThinkingConfig` takes one argument; `ConfigBuilderOptions` has no `thinkingBudget` field; `getThinkingBudgetCap` is deleted from config; obsolete warning test is deleted from client test; suite compiles and passes. TDD partially skipped for the deletion steps — schema change in TASK-002 already makes TypeScript catch any missed references. |

- [ ] **Step 1: Apply change** — delete `getThinkingBudgetCap` from [src/config.ts](src/config.ts)

Delete the entire function at line 360 of [src/config.ts](src/config.ts):

```ts
// DELETE this entire function:
export function getThinkingBudgetCap(): number {
  return parseIntEnv('GEMINI_THINKING_BUDGET_CAP', 16_384, {
    min: 0,
    max: 1_048_576,
  });
}
```

Also delete the `DEFAULT_SESSION_REPLAY_INLINE_DATA_MAX_BYTES` constant is unaffected — confirm only `getThinkingBudgetCap` is removed.

- [ ] **Step 2: Rewrite `buildThinkingConfig` and callers in [src/client.ts](src/client.ts)**

Remove `getThinkingBudgetCap` from the import list at the top of the file:

```ts
// Before (line ~19):
import {
  getApiKey,
  getExposeThoughts,
  getMaxOutputTokens,
  getSafetySettings,
  getThinkingBudgetCap,
} from './config.js';

// After:
import {
  getApiKey,
  getExposeThoughts,
  getMaxOutputTokens,
  getSafetySettings,
} from './config.js';
```

Remove `thinkingBudget?: number | undefined;` from `ConfigBuilderOptions` (line 63).

Replace [buildThinkingConfig](src/client.ts#L100) (lines 100–127) with the simplified version:

```ts
function buildThinkingConfig(thinkingLevel?: AskThinkingLevel) {
  return {
    ...(getExposeThoughts() ? { includeThoughts: true } : {}),
    ...(thinkingLevel ? { thinkingLevel: THINKING_LEVEL_MAP[thinkingLevel] } : {}),
  };
}
```

Replace [buildResponseConfig](src/client.ts#L163) signature and body — remove the `thinkingBudget` parameter:

```ts
function buildResponseConfig(
  cacheName: string | undefined,
  systemInstruction: string | undefined,
  isJson: boolean,
  responseSchema: GeminiResponseSchema | undefined,
  thinkingLevel: AskThinkingLevel | undefined,
) {
  const thinkingConfig = buildThinkingConfig(thinkingLevel);
  const resolvedInstruction =
    systemInstruction !== undefined
      ? `${systemInstruction}\n\n${GROUNDING_SUFFIX}`
      : DEFAULT_SYSTEM_INSTRUCTION;
  return {
    ...(cacheName ? { cachedContent: cacheName } : {}),
    systemInstruction: resolvedInstruction,
    ...(Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {}),
    ...(isJson
      ? {
          responseMimeType: 'application/json',
          ...(responseSchema ? { responseJsonSchema: responseSchema } : {}),
        }
      : {}),
  };
}
```

In [buildGenerateContentConfig](src/client.ts#L189), remove `thinkingBudget` from the destructure and fix `resolvedThinkingLevel`:

```ts
// Remove from destructure:
//   thinkingBudget,

// Replace the resolvedThinkingLevel line:
// Before:
const resolvedThinkingLevel =
  thinkingLevel ?? (thinkingBudget === undefined ? profile?.thinkingLevel : undefined);
// After:
const resolvedThinkingLevel = thinkingLevel ?? profile?.thinkingLevel;

// Remove thinkingBudget from the buildResponseConfig call — it now takes 5 args, not 6:
// Before:
...buildResponseConfig(cacheName, systemInstruction, isJson, responseSchema, resolvedThinkingLevel, thinkingBudget),
// After:
...buildResponseConfig(cacheName, systemInstruction, isJson, responseSchema, resolvedThinkingLevel),
```

- [ ] **Step 3: Delete the obsolete warning test from [__tests__/client.test.ts](__tests__/client.test.ts)**

Delete the entire test block (lines 25–50) titled `'buildGenerateContentConfig — warns when both thinkingLevel and thinkingBudget are supplied'`. The `DEFAULT_SYSTEM_INSTRUCTION` test on lines 13–23 must be preserved.

- [ ] **Step 4: Verify**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/client.test.ts
```

Expected: 1 test PASS (`DEFAULT_SYSTEM_INSTRUCTION — contains anti-hallucination directive`).

- [ ] **Step 5: Commit**

```bash
git add src/client.ts src/config.ts __tests__/client.test.ts
git commit -m "refactor(client): remove deprecated thinkingBudget knob; simplify buildThinkingConfig"
```

---

#### TASK-004: Remove `thinkingBudget` from tool files

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-003`](#task-003-remove-thinkingbudget-from-client-and-config) |
| Files | Modify: [src/tools/chat.ts](src/tools/chat.ts); Modify: [src/tools/research.ts](src/tools/research.ts); Modify: [src/tools/analyze.ts](src/tools/analyze.ts); Modify: [src/tools/review.ts](src/tools/review.ts) |
| Symbols | [buildGenerateContentConfig](src/client.ts#L189) |
| Outcome | `node scripts/tasks.mjs --quick` exits 0; no TypeScript errors; `thinkingBudget` appears zero times in these four files. TDD skipped: changes are pure deletions of a field that no longer exists on the schema-derived types — the TypeScript compiler enforces correctness. |

- [ ] **Step 1: Apply change** — remove `thinkingBudget` from [src/tools/chat.ts](src/tools/chat.ts)

The only occurrence is at line 1234. Remove the line:

```ts
// DELETE this line wherever it appears:
thinkingBudget: args.thinkingBudget,
```

- [ ] **Step 2: Apply change** — remove `thinkingBudget` from [src/tools/research.ts](src/tools/research.ts)

Delete the optional field declaration inside the internal arg type (line 592):

```ts
// DELETE:
thinkingBudget?: number | undefined;
```

Remove every destructuring reference and every pass-through at lines 679, 734, 803, 843, 859, 885, 899, 935. The pattern is always one of:

```ts
// In destructuring — DELETE the line:
thinkingBudget,
// OR:
thinkingBudget?: ResearchInput['thinkingBudget'],

// In call sites — DELETE the property:
thinkingBudget: args.thinkingBudget,
// OR:
thinkingBudget,
```

- [ ] **Step 3: Apply change** — remove `thinkingBudget` from [src/tools/analyze.ts](src/tools/analyze.ts)

Delete the optional field at line 50:

```ts
// DELETE:
thinkingBudget?: AnalyzeInput['thinkingBudget'];
```

Remove destructuring references at line 199 and pass-throughs at lines 130, 167, 256, 347, 446 — same pattern as research.ts above.

- [ ] **Step 4: Apply change** — remove `thinkingBudget` from [src/tools/review.ts](src/tools/review.ts)

Delete the optional field at line 347:

```ts
// DELETE:
thinkingBudget?: ReviewFailureInput['thinkingBudget'];
```

Remove destructuring at line 357 and pass-throughs at lines 268, 320, 396, 1181, 1279, 1377, 1398, 1414.

- [ ] **Step 5: Verify**

```bash
node scripts/tasks.mjs --quick
```

Expected: `✓ format`, `✓ lint`, `✓ type-check`, `✓ knip` — all pass. Zero TypeScript errors. Confirm with:

```bash
grep -rn "thinkingBudget" src/tools/
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/tools/chat.ts src/tools/research.ts src/tools/analyze.ts src/tools/review.ts
git commit -m "refactor(tools): remove thinkingBudget from all tool arg types and call sites"
```

---

### PHASE-003: Fix `parametersJsonSchema` field name

**Goal:** `buildToolsArray` emits the correct `parametersJsonSchema` field name; a test verifies the output.

| Task | Action | Depends on | Files | Validate |
| :--- | :--- | :--- | :--- | :--- |
| [`TASK-005`](#task-005-fix-parametersjsonschema-in-buildtoolsarray) | Rename `parameters:` → `parametersJsonSchema:` and add test | none | [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts), [__tests__/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts` |

#### TASK-005: Fix `parametersJsonSchema` in `buildToolsArray`

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | Modify: [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts); Modify: [__tests__/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) |
| Symbols | [buildToolsArray](src/lib/tool-profiles.ts#L392), [FunctionDeclarationInput](src/lib/tool-profiles.ts#L180), [ToolsSpecOverrides](src/lib/tool-profiles.ts#L188), [resolveProfile](src/lib/tool-profiles.ts#L269) |
| Outcome | A function declaration with `parametersJsonSchema` set produces a tool entry with `parametersJsonSchema:` (not `parameters:`); test passes. |

- [ ] **Step 1: Write failing test** — add to [__tests__/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts)

```ts
// __tests__/lib/tool-profiles.test.ts  — append after existing tests
import { buildToolsArray } from '../../src/lib/tool-profiles.js';

test('buildToolsArray — function declaration emits parametersJsonSchema not parameters', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  const resolved = resolveProfile(
    {
      profile: 'agent',
      overrides: {
        functions: [{ name: 'search', description: 'web search', parametersJsonSchema: schema }],
      },
    },
    { toolKey: 'chat' },
  );

  const tools = buildToolsArray(resolved);
  const decl = tools
    .flatMap((t) => ('functionDeclarations' in t ? t.functionDeclarations ?? [] : []))
    .find((d) => d.name === 'search');

  assert.ok(decl, 'search declaration must exist');
  assert.ok(
    'parametersJsonSchema' in decl,
    `expected parametersJsonSchema key, got: ${JSON.stringify(Object.keys(decl))}`,
  );
  assert.ok(!('parameters' in decl), 'parameters key must not be present');
  assert.deepStrictEqual(decl.parametersJsonSchema, schema);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts
```

Expected: FAIL — `expected parametersJsonSchema key, got: ["name","description","parameters"]`.

- [ ] **Step 3: Fix `buildToolsArray` in [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts)**

In [buildToolsArray](src/lib/tool-profiles.ts#L392), change the function declaration builder (lines ~411–419):

```ts
// Before:
tools.push({
  functionDeclarations: functions.map((decl) => ({
    name: decl.name,
    description: decl.description,
    ...(decl.parametersJsonSchema !== undefined
      ? { parameters: decl.parametersJsonSchema }
      : {}),
  })),
});

// After:
tools.push({
  functionDeclarations: functions.map((decl) => ({
    name: decl.name,
    description: decl.description,
    ...(decl.parametersJsonSchema !== undefined
      ? { parametersJsonSchema: decl.parametersJsonSchema }
      : {}),
  })),
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tool-profiles.ts __tests__/lib/tool-profiles.test.ts
git commit -m "fix(tool-profiles): emit parametersJsonSchema instead of parameters for function declarations"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full suite passes

```bash
node scripts/tasks.mjs
```

Expected: all stages green — format, lint, type-check, knip, test, build.

### [`VAL-002`](#5-testing--validation) — Zero `thinkingBudget` references in src

```bash
grep -rn "thinkingBudget\|THINKING_BUDGET\|thinkingBudgetCap\|getThinkingBudgetCap" src/
```

Expected: no output.

### [`VAL-003`](#5-testing--validation) — Zero `parameters:` (wrong field) in function declaration builder

```bash
grep -n "parameters: decl\." src/lib/tool-profiles.ts
```

Expected: no output.

## 6. Acceptance Criteria

| ID | Observable Outcome |
| :--- | :--- |
| [`AC-001`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 with all stages green. |
| [`AC-002`](#6-acceptance-criteria) | `ChatInputSchema.safeParse({ goal: 'hi', thinkingBudget: 1 })` returns `{ success: false }`. |
| [`AC-003`](#6-acceptance-criteria) | `grep -rn "thinkingBudget" src/` returns no matches. |
| [`AC-004`](#6-acceptance-criteria) | `buildToolsArray` test for `parametersJsonSchema` passes. |
| [`AC-005`](#6-acceptance-criteria) | `AppError.isRetryable` regression tests for `ECONNRESET` and nested `ECONNRESET` pass. |

## 7. Risks / Notes

| ID | Type | Detail |
| :--- | :--- | :--- |
| [`NOTE-001`](#7-risks--notes) | Note | TASK-004 spans four files with many occurrences. After applying changes, run `grep -rn "thinkingBudget" src/tools/` to confirm zero matches before committing. |
| [`NOTE-002`](#7-risks--notes) | Note | TASK-003 deletes `getThinkingBudgetCap` from config.ts. Confirm with `grep -rn "getThinkingBudgetCap" src/` returning no matches before the task-003 commit. |
| [`RISK-001`](#7-risks--notes) | Risk | The `buildToolsArray` change in TASK-005 may cause a TypeScript error if `FunctionDeclaration` from `@google/genai` does not expose `parametersJsonSchema` in its type. Mitigation: run `node scripts/tasks.mjs --quick` immediately after step 3; if a type error appears, check the SDK type definition and adjust accordingly. |
| [`NOTE-003`](#7-risks--notes) | Note | This is Plan 1 of 2. Plan 2 covers the session architecture migration (`ai.interactions`, `interaction-stream.ts`, session store gutting, `mcpToTool`). Execute Plan 1 first and merge before starting Plan 2. |
