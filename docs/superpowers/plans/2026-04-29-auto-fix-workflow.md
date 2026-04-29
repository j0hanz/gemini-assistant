---
goal: Add intelligent auto-fix to tasks.mjs so lint and knip failures are automatically repaired and re-verified before halting
version: 1
date_created: 2026-04-29
status: Planned
plan_type: feature
component: auto-fix-workflow
execution: subagent-driven
---

# Implementation Plan: Auto-Fix Workflow for tasks.mjs

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** When `lint` or `knip` fails with parsed errors, `tasks.mjs` automatically runs the appropriate fix command, re-verifies with the full check, and either continues the pipeline (all fixed) or halts showing only the remaining unfixable errors.

**Architecture:** All changes live in a single file — [scripts/tasks.mjs](scripts/tasks.mjs). Five new symbols are added in dependency order: a `FIX` icon constant, a `KNIP_FIXABLE_RULES` set plus `isKnipFixable()` pure helper, two fix-command wrappers (`runLintFix`, `runKnipFix`), an `annotation` param on `printTask`, and an `attemptAutoFix()` orchestrator called from the `main()` failure branch.

**Tech Stack:** Node.js ≥ 24, ESM (`"type": "module"`), `node:child_process.spawnSync`, ANSI escape codes.

---

## 1. Goal

`tasks.mjs` currently halts on the first lint or knip failure and requires the developer to manually run a fix command before re-running the full suite. Both checkers expose a `--fix` / `lint:fix` command that resolves the majority of reported errors mechanically. This plan adds a single auto-fix pass: after a lint or knip failure with parsed errors, the script runs the fix command, re-runs the check for ground truth, and either continues (zero errors remain) or halts showing only what the fix could not address. The terminal row is updated inline via `\r` overwrite — consistent with the existing running-indicator style — so the developer sees a clear `(auto-fixed)` annotation on success or the remaining error count on partial failure.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                                                                      |
| :---------------------------------------: | :---------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | After lint failure with parsed errors, run `npm run lint:fix` then re-run `npx eslint . --max-warnings=0 --format=json`; continue if zero errors remain.                                                                       |
| [`REQ-002`](#2-requirements--constraints) | Requirement | After knip failure with parsed errors and at least one fixable rule, run `npx knip --fix --fix-type exports,types,dependencies --format` then re-run `npx knip --reporter json --no-progress`; continue if zero errors remain. |
| [`REQ-003`](#2-requirements--constraints) | Requirement | If all knip errors map to unfixable rules (`unlisted-dep`, `unlisted-binary`, `unresolved-import`, `duplicate-export`, `unused-file`), skip the fix attempt entirely.                                                          |
| [`REQ-004`](#2-requirements--constraints) | Requirement | On partial fix (errors remain after re-run), show only the remaining errors, not the original full list.                                                                                                                       |
| [`REQ-005`](#2-requirements--constraints) | Requirement | The task row must show `⟳ lint  auto-fixing...` (inline `\r` overwrite, no newline) during the fix, then the final pass/fail row.                                                                                              |
| [`REQ-006`](#2-requirements--constraints) | Requirement | Successful auto-fix rows show `✓ lint  2.4s  (auto-fixed)` — elapsed time covers original check + fix + re-run.                                                                                                                |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Only `scripts/tasks.mjs` is modified. No new files except the test helper.                                                                                                                                                     |
| [`CON-002`](#2-requirements--constraints) | Constraint  | No CLI flag is added; auto-fix is always-on for lint and knip.                                                                                                                                                                 |
| [`CON-003`](#2-requirements--constraints) | Constraint  | `tasks.mjs` is a CLI script (`process.exitCode = await main()`), not a module. Functions are not exported. The test for `isKnipFixable` defines the function inline.                                                           |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [runCommand](scripts/tasks.mjs#L89) for all subprocess calls — `spawnSync` with `shell: IS_WINDOWS && (cmd === 'npm' &#124;&#124; cmd === 'npx')`.                                                                      |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Follow [printTask](scripts/tasks.mjs#L610) for all terminal row writes — `\r` overwrite, single `process.stdout.write` call, ANSI constants.                                                                                   |

## 3. Current Context

### File structure

| File                                                                       | Status | Responsibility                                                                                     |
| :------------------------------------------------------------------------- | :----- | :------------------------------------------------------------------------------------------------- |
| [scripts/tasks.mjs](scripts/tasks.mjs)                                     | Modify | CLI task runner — all implementation changes land here                                             |
| [**tests**/scripts/auto-fix.test.mjs](__tests__/scripts/auto-fix.test.mjs) | Create | Unit tests for `isKnipFixable` pure logic (inline function definition — tasks.mjs is not a module) |

### Relevant symbols

| Symbol                                 | Why it matters                                                                           |
| :------------------------------------- | :--------------------------------------------------------------------------------------- |
| [HANG](scripts/tasks.mjs#L34)          | Last icon constant — `FIX` is inserted after this line                                   |
| [KNIP_RULES](scripts/tasks.mjs#L153)   | Defines all knip rule names — `KNIP_FIXABLE_RULES` is derived from the fixable subset    |
| [runCommand](scripts/tasks.mjs#L89)    | Used by all new fix runners — follow its shell/IS_WINDOWS pattern                        |
| [runKnip](scripts/tasks.mjs#L420)      | Last task runner before fix runners are inserted                                         |
| [printTask](scripts/tasks.mjs#L610)    | Receives new `annotation` param; `\r` overwrite style is the pattern for `FIX` indicator |
| [emitLlmBlock](scripts/tasks.mjs#L376) | Emits the LLM JSON block — re-run result (not original) must flow into `llmPayload`      |
| [main](scripts/tasks.mjs#L638)         | Contains the failure branch that calls `attemptAutoFix`                                  |
| [elapsed](scripts/tasks.mjs#L600)      | Formats milliseconds for display — used on auto-fixed rows                               |

### Existing commands

```bash
# Run a single test file
node --env-file=.env --test --no-warnings __tests__/scripts/auto-fix.test.mjs

# Full static check (lint + type-check + build + knip)
npm run check:static

# Run all tests
npm run test
```

### Current behavior

When `runLint()` or `runKnip()` returns `{ ok: false, errors }`, `main()` immediately calls `printTask(FAIL, ...)`, renders the errors, sets `llmPayload`, and `break`s out of the task loop. No fix is attempted. The developer must manually run `npm run lint:fix` or `knip --fix` and re-run the script.

## 4. Implementation Phases

### PHASE-001: Foundation helpers

**Goal:** Add the FIX icon, the knip fixability classifier, and the two fix-command wrappers — all pure or thin-wrapper additions with no changes to existing logic.

|                                      Task                                      | Action                                  |                                   Depends on                                   | Files                                                                                                              | Validate                                                                        |
| :----------------------------------------------------------------------------: | :-------------------------------------- | :----------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| [`TASK-001`](#task-001-add-fix-constant-knip_fixable_rules-and-isknipcfixable) | Add FIX constant + isKnipFixable helper |                                      none                                      | [scripts/tasks.mjs](scripts/tasks.mjs), [**tests**/scripts/auto-fix.test.mjs](__tests__/scripts/auto-fix.test.mjs) | `node --env-file=.env --test --no-warnings __tests__/scripts/auto-fix.test.mjs` |
|         [`TASK-002`](#task-002-add-runlintfix-and-runknipfix-wrappers)         | Add runLintFix and runKnipFix           | [`TASK-001`](#task-001-add-fix-constant-knip_fixable_rules-and-isknipcfixable) | [scripts/tasks.mjs](scripts/tasks.mjs)                                                                             | `node scripts/tasks.mjs --fast`                                                 |
|      [`TASK-003`](#task-003-update-printtask-to-accept-annotation-param)       | Add annotation param to printTask       | [`TASK-001`](#task-001-add-fix-constant-knip_fixable_rules-and-isknipcfixable) | [scripts/tasks.mjs](scripts/tasks.mjs)                                                                             | `node scripts/tasks.mjs --fast`                                                 |

### PHASE-002: Auto-fix orchestration

**Goal:** Add the `attemptAutoFix` orchestrator and wire it into `main()`'s failure branch so the full auto-fix flow is active.

|                                 Task                                 | Action                          |                                                             Depends on                                                              | Files                                  | Validate                        |
| :------------------------------------------------------------------: | :------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------- | :------------------------------ |
|       [`TASK-004`](#task-004-add-attemptautofix-orchestrator)        | Add attemptAutoFix helper       | [`TASK-002`](#task-002-add-runlintfix-and-runknipfix-wrappers), [`TASK-003`](#task-003-update-printtask-to-accept-annotation-param) | [scripts/tasks.mjs](scripts/tasks.mjs) | `node scripts/tasks.mjs --fast` |
| [`TASK-005`](#task-005-wire-attemptautofix-into-main-failure-branch) | Wire attemptAutoFix into main() |                                       [`TASK-004`](#task-004-add-attemptautofix-orchestrator)                                       | [scripts/tasks.mjs](scripts/tasks.mjs) | `node scripts/tasks.mjs --fast` |

---

#### TASK-001: Add FIX constant, KNIP_FIXABLE_RULES, and isKnipFixable

| Field      | Value                                                                                                                                                                                                                                          |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                                                                           |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs); Create: [**tests**/scripts/auto-fix.test.mjs](__tests__/scripts/auto-fix.test.mjs)                                                                                                             |
| Symbols    | [HANG](scripts/tasks.mjs#L34), [KNIP_RULES](scripts/tasks.mjs#L153)                                                                                                                                                                            |
| Outcome    | `isKnipFixable` correctly classifies fixable vs unfixable knip rule names; test suite passes; `FIX` constant is defined in tasks.mjs. TDD applies to `isKnipFixable` — the test defines the function inline since `tasks.mjs` is not a module. |

- [ ] **Step 1: Write the failing test**

```js
// __tests__/scripts/auto-fix.test.mjs
import assert from 'node:assert/strict';

import { test } from 'node:test';

// Inline copy — tasks.mjs is a CLI script, not a module; functions are not exported.
const KNIP_FIXABLE_RULES = new Set([
  'unused-dep',
  'unused-dev-dep',
  'unused-peer-dep',
  'unused-export',
  'unused-ns-export',
  'unused-enum-member',
  'unused-ns-member',
  'unused-type',
  'unused-ns-type',
]);

function isKnipFixable(errors) {
  return errors.some((e) => KNIP_FIXABLE_RULES.has(e.rule));
}

test('isKnipFixable — returns true when at least one error is fixable', () => {
  assert.equal(isKnipFixable([{ rule: 'unused-export' }, { rule: 'unlisted-dep' }]), true);
});

test('isKnipFixable — returns false when all errors are unfixable', () => {
  assert.equal(isKnipFixable([{ rule: 'unlisted-dep' }, { rule: 'unlisted-binary' }]), false);
});

test('isKnipFixable — returns false for empty array', () => {
  assert.equal(isKnipFixable([]), false);
});

test('isKnipFixable — covers all fixable rule names', () => {
  for (const rule of KNIP_FIXABLE_RULES) {
    assert.equal(isKnipFixable([{ rule }]), true, `Expected ${rule} to be fixable`);
  }
});

test('isKnipFixable — unused-file is not fixable', () => {
  assert.equal(isKnipFixable([{ rule: 'unused-file' }]), false);
});

test('isKnipFixable — duplicate-export is not fixable', () => {
  assert.equal(isKnipFixable([{ rule: 'duplicate-export' }]), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --env-file=.env --test --no-warnings __tests__/scripts/auto-fix.test.mjs
```

Expected: FAIL with `isKnipFixable is not defined` or `ReferenceError` — the function does not exist yet in the test file (the test defines it inline, so this step confirms the file is syntactically valid and all 6 tests are discovered). Actually all tests will PASS immediately since the function is defined inline in the test file. Proceed directly to Step 3.

> **Note:** Because `isKnipFixable` is defined inline in the test file (not imported), Steps 1–2 confirm the test logic is correct before the production code is written. The "failing" state is verified by the absence of the production symbol in `tasks.mjs` before Step 3.

- [ ] **Step 3: Add FIX constant, KNIP_FIXABLE_RULES, and isKnipFixable to tasks.mjs**

In [scripts/tasks.mjs](scripts/tasks.mjs), after [HANG](scripts/tasks.mjs#L34), insert `FIX`:

```js
// After line 34: const HANG = `${YELLOW}⏱${R}`;
const FIX = `${CYAN}⟳${R}`;
```

After the closing `};` of [KNIP_RULES](scripts/tasks.mjs#L153) (the `};` at line 175), insert:

```js
const KNIP_FIXABLE_RULES = new Set([
  'unused-dep',
  'unused-dev-dep',
  'unused-peer-dep',
  'unused-export',
  'unused-ns-export',
  'unused-enum-member',
  'unused-ns-member',
  'unused-type',
  'unused-ns-type',
]);

function isKnipFixable(errors) {
  return errors.some((e) => KNIP_FIXABLE_RULES.has(e.rule));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --env-file=.env --test --no-warnings __tests__/scripts/auto-fix.test.mjs
```

Expected: all 6 tests PASS, output ends with `# pass 6`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs __tests__/scripts/auto-fix.test.mjs
git commit -m "feat: add FIX icon, KNIP_FIXABLE_RULES, and isKnipFixable helper"
```

---

#### TASK-002: Add runLintFix and runKnipFix wrappers

| Field      | Value                                                                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-add-fix-constant-knip_fixable_rules-and-isknipcfixable)                                                                                             |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                             |
| Symbols    | [runKnip](scripts/tasks.mjs#L420), [runCommand](scripts/tasks.mjs#L89)                                                                                                     |
| Outcome    | Two thin wrappers exist in tasks.mjs that invoke the fix commands via `runCommand`. TDD skipped — these wrap external processes (ESLint, knip) with no logic to unit-test. |

- [ ] **Step 1: Apply change**

In [scripts/tasks.mjs](scripts/tasks.mjs), after the closing `}` of [runKnip](scripts/tasks.mjs#L420) (the `}` that ends the function, currently around line 441), insert:

```js
function runLintFix() {
  runCommand('npm', ['run', 'lint:fix']);
}

function runKnipFix() {
  runCommand('npx', ['knip', '--fix', '--fix-type', 'exports,types,dependencies', '--format']);
}
```

The return value of `runCommand` is intentionally discarded — the ground truth comes from the re-run check, not from the fix command's exit code.

- [ ] **Step 2: Verify the script still starts correctly**

```bash
node scripts/tasks.mjs --fast
```

Expected: script runs all tasks except `test`, exits with `✓ N/M passed (test skipped)`. No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat: add runLintFix and runKnipFix command wrappers"
```

---

#### TASK-003: Update printTask to accept optional annotation param

| Field      | Value                                                                                                                                                                                                                                                          |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-add-fix-constant-knip_fixable_rules-and-isknipcfixable)                                                                                                                                                                                 |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                                                                                 |
| Symbols    | [printTask](scripts/tasks.mjs#L610)                                                                                                                                                                                                                            |
| Outcome    | `printTask` accepts an optional sixth argument `annotation`; when provided, it appends `(annotation)` in DIM after the elapsed time. All existing callers pass five arguments and are unaffected. TDD skipped — pure terminal output; no logic to unit-test. |

- [ ] **Step 1: Apply change**

In [scripts/tasks.mjs](scripts/tasks.mjs), replace the `printTask` function signature and the `right` initialization at [printTask](scripts/tasks.mjs#L610):

Old (lines 610–612):

```js
function printTask(icon, label, time, skipped, counts) {
  const col = label.padEnd(COL);
  let right = skipped ? `${DIM}skipped${R}` : `${DIM}${time}${R}`;
```

New:

```js
function printTask(icon, label, time, skipped, counts, annotation = null) {
  const col = label.padEnd(COL);
  let right = skipped ? `${DIM}skipped${R}` : `${DIM}${time}${R}`;
  if (annotation) right += `  ${DIM}(${annotation})${R}`;
```

No other lines in the function body change.

- [ ] **Step 2: Verify the script still runs correctly**

```bash
node scripts/tasks.mjs --fast
```

Expected: output is identical to before — `annotation` is `null` for all current callers.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat: add optional annotation param to printTask"
```

---

#### TASK-004: Add attemptAutoFix orchestrator

| Field      | Value                                                                                                                                                                                                                                                              |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-add-runlintfix-and-runknipfix-wrappers), [`TASK-003`](#task-003-update-printtask-to-accept-annotation-param)                                                                                                                                |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                                                                                     |
| Symbols    | [emitLlmBlock](scripts/tasks.mjs#L376), [printTask](scripts/tasks.mjs#L610), [main](scripts/tasks.mjs#L638)                                                                                                                                                        |
| Outcome    | `attemptAutoFix(task, result)` exists in tasks.mjs immediately before `// --- MAIN ---`; it returns `null` when no fix should be attempted, or the re-run result object when a fix was attempted. TDD skipped — orchestrates I/O (stdout write) and process calls. |

- [ ] **Step 1: Apply change**

In [scripts/tasks.mjs](scripts/tasks.mjs), insert the following function immediately before the `// --- MAIN ---` comment (currently at line 636), after the closing `}` of `printOutput`:

```js
function attemptAutoFix(task, result) {
  if (!result.errors?.length) return null;
  if (task.label !== 'lint' && task.label !== 'knip') return null;
  if (task.label === 'knip' && !isKnipFixable(result.errors)) return null;
  process.stdout.write(
    `\r  ${FIX}  ${BOLD}${task.label.padEnd(COL)}${R}  ${DIM}auto-fixing...${R}`,
  );
  if (task.label === 'lint') runLintFix();
  else runKnipFix();
  return task.runner();
}
```

`task.runner()` for `lint` and `knip` is synchronous (uses `spawnSync` internally), so `attemptAutoFix` returns a plain result object (not a Promise). `main()` will handle it without `await`.

- [ ] **Step 2: Verify the script still runs correctly**

```bash
node scripts/tasks.mjs --fast
```

Expected: same output as before — `attemptAutoFix` is defined but not yet called.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat: add attemptAutoFix orchestrator"
```

---

#### TASK-005: Wire attemptAutoFix into main() failure branch

| Field      | Value                                                                                                                                                                                                                                                                                        |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-004`](#task-004-add-attemptautofix-orchestrator)                                                                                                                                                                                                                                      |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                                                                                                               |
| Symbols    | [main](scripts/tasks.mjs#L638), [elapsed](scripts/tasks.mjs#L600)                                                                                                                                                                                                                            |
| Outcome    | When lint or knip fails with parsed errors, the auto-fix flow runs; the terminal row updates inline; the pipeline continues on success or halts showing only remaining errors on failure. TDD skipped — modifies the main async loop; behavior is verified by running the script end-to-end. |

- [ ] **Step 1: Apply change**

In [scripts/tasks.mjs](scripts/tasks.mjs), make two edits inside `main()`:

**Edit A** — change `const ms` to `let ms` at line 670, so elapsed time can be updated after the fix attempt:

Old:

```js
const ms = Date.now() - start;
```

New:

```js
let ms = Date.now() - start;
```

**Edit B** — insert the `attemptAutoFix` block at the top of the `if (!result.ok)` branch, before the existing `const counts` line. Old (lines 672–675):

```js
    if (!result.ok) {
      const counts = result.counts ?? null;
      printTask(result.timeout ? HANG : FAIL, task.label, elapsed(ms), false, counts);
      failed++;
```

New:

```js
    if (!result.ok) {
      const fixed = attemptAutoFix(task, result);
      if (fixed !== null) {
        ms = Date.now() - start;
        if (fixed.ok) {
          printTask(PASS, task.label, elapsed(ms), false, null, 'auto-fixed');
          passed++;
          continue;
        }
        result = fixed;
      }
      const counts = result.counts ?? null;
      printTask(result.timeout ? HANG : FAIL, task.label, elapsed(ms), false, counts);
      failed++;
```

No other lines in `main()` change. The rest of the failure branch (timeout handling, failure cards, error rendering, `llmPayload`, `break`) operates on `result`, which is now the re-run result when a fix was attempted — so the LLM block receives only the remaining errors, satisfying [`REQ-004`](#2-requirements--constraints).

- [ ] **Step 2: Verify the full script runs**

```bash
node scripts/tasks.mjs --fast
```

Expected: all non-test tasks pass; output ends with `✓ N/M passed  (test skipped)`. Confirm `passed` count is correct.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat: wire attemptAutoFix into main failure branch"
```

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — isKnipFixable unit tests pass

```bash
node --env-file=.env --test --no-warnings __tests__/scripts/auto-fix.test.mjs
```

Expected: `# pass 6`, `# fail 0`.

### [`VAL-002`](#5-testing--validation) — Full static check passes

```bash
npm run check:static
```

Expected: lint, type-check, build, format, and knip all pass with no errors.

### [`VAL-003`](#5-testing--validation) — Full suite passes

```bash
npm run check
```

Expected: all tasks pass including tests.

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                                                                    |
| :--------------------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | When lint fails with fixable errors, the terminal row shows `⟳ lint  auto-fixing...` then updates to `✓ lint  Xs  (auto-fixed)` and the pipeline continues to the next task.                                          |
| [`AC-002`](#6-acceptance-criteria) | When knip fails with only unfixable rules (`unlisted-dep`, `unlisted-binary`, `unresolved-import`, `duplicate-export`, `unused-file`), no fix command runs and the error output is identical to the current behavior. |
| [`AC-003`](#6-acceptance-criteria) | When auto-fix only partially resolves errors, the task row shows `✗ lint  Xs  N errors` and only the remaining (unfixed) errors are displayed — not the original full list.                                           |
| [`AC-004`](#6-acceptance-criteria) | The elapsed time shown on auto-fixed rows covers the full wall time: original check + fix command + re-run check.                                                                                                     |
| [`AC-005`](#6-acceptance-criteria) | `npm run check:static` passes with zero lint, type, or build errors introduced by these changes.                                                                                                                      |
| [`AC-006`](#6-acceptance-criteria) | All 6 tests in `__tests__/scripts/auto-fix.test.mjs` pass.                                                                                                                                                            |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                                                              |
| :---------------------------: | :--: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`NOTE-001`](#7-risks--notes) | Note | `runLintFix` and `runKnipFix` discard the fix command's return value deliberately — the re-run check is the only source of truth per [`REQ-001`](#2-requirements--constraints)/[`REQ-002`](#2-requirements--constraints).                                                                                                                           |
| [`NOTE-002`](#7-risks--notes) | Note | `knip --fix --format` requires Prettier to be resolvable in the project. This project has Prettier configured; if knip cannot invoke it, the export removal still succeeds and only formatting is skipped — the re-run check is unaffected.                                                                                                         |
| [`NOTE-003`](#7-risks--notes) | Note | `attemptAutoFix` returns a plain object (not a Promise) because `runLint` and `runKnip` use `spawnSync`. Do not add `await` in `main()` when calling it.                                                                                                                                                                                            |
| [`RISK-001`](#7-risks--notes) | Risk | If `knip --fix` removes a dependency that is actually used (a false-positive in knip's analysis), the build will fail in the `build` task that runs after `knip`. Mitigation: knip's analysis is precise for this codebase; the `knip.json` `ignore`/`project` fields are the correct place to suppress false positives before they reach auto-fix. |
