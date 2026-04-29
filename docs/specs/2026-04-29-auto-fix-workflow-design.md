# Auto-Fix Workflow for `scripts/tasks.mjs`

**Date:** 2026-04-29  
**Status:** Approved  
**Scope:** `scripts/tasks.mjs` only

---

## Problem

When `lint` or `knip` fails, the script halts and shows errors. Many of these errors are
mechanically fixable (unused exports, unused deps, lint rule violations). The developer must
manually run the fix command, then re-run the full check suite. This is unnecessary friction.

---

## Goal

Make `tasks.mjs` automatically attempt to fix lint and knip errors on failure, re-verify the
result, and continue the pipeline if all errors were resolved — all with clear inline feedback.

---

## Decisions

| # | Question | Decision |
|:--|:--|:--|
| 1 | Verification after fix | Re-run the full check command (ground truth, not exit code) |
| 2 | Knip fix scope | `--fix-type exports,types,dependencies --format` — no file deletion, Prettier runs on changes |
| 3 | Terminal UI | Inline row overwrite (consistent with existing `\r`-based style) |
| 4 | Partial fix | Halt, show only remaining errors (fixed ones disappear) |
| 5 | Activation | Always-on, no CLI flag needed |

---

## Affected Tasks

Only `lint` and `knip` — both produce structured JSON error output and have a fix command.
`format`, `type-check`, `build`, and `test` are unchanged.

---

## Lint Auto-Fix Flow

```
run check: npx eslint . --max-warnings=0 --format=json
  └─ pass  →  ✓ lint   1.2s                         (existing behavior)
  └─ fail (parsed errors exist)
      →  \r ⟳ lint   auto-fixing...                 (overwrite row, no newline)
      →  run: npm run lint:fix
      →  re-run: npx eslint . --max-warnings=0 --format=json
          └─ pass  →  ✓ lint   2.4s  (auto-fixed)   continue
          └─ fail  →  ✗ lint   2.4s  N errors        halt, show remaining errors only
  └─ fail (rawOutput, no parsed errors)
      →  existing behavior (no fix attempt)
```

---

## Knip Auto-Fix Flow

```
run check: npx knip --reporter json --no-progress
  └─ pass  →  ✓ knip   1.0s                         (existing behavior)
  └─ fail (parsed errors exist)
      →  inspect error rules
      │   └─ ALL errors are unfixable rules?
      │       →  ✗ knip   1.0s  N errors             halt immediately, show errors
      │           (no fix attempt — note: "no auto-fix available for these issue types")
      └─ has at least one fixable error
          →  \r ⟳ knip   auto-fixing...              (overwrite row, no newline)
          →  run: npx knip --fix --fix-type exports,types,dependencies --format
          →  re-run: npx knip --reporter json --no-progress
              └─ pass  →  ✓ knip   2.1s  (auto-fixed)  continue
              └─ fail  →  ✗ knip   2.1s  N errors       halt, show remaining errors only
  └─ fail (rawOutput, no parsed errors)
      →  existing behavior (no fix attempt)
```

---

## Fixable vs Unfixable Knip Rules

Determined by `--fix-type exports,types,dependencies` — maps to the `rule` field in our
parsed error objects (from `KNIP_RULES` in the script).

| Fixable by our command | Unfixable (skip fix attempt) |
|:--|:--|
| `unused-dep` | `unlisted-dep` |
| `unused-dev-dep` | `unlisted-binary` |
| `unused-peer-dep` | `unresolved-import` |
| `unused-export` | `duplicate-export` |
| `unused-ns-export` | `unused-file` (intentionally excluded) |
| `unused-enum-member` | |
| `unused-ns-member` | |
| `unused-type` | |
| `unused-ns-type` | |

**Why no `--fix-type files`:** File deletion is destructive and irreversible. Files that knip
considers unused should be handled manually or suppressed via `knip.json` (using `ignore`
patterns or `project`/`entry` negations).

**Why `--format`:** The project uses Prettier. When knip removes an `export` keyword, the
surrounding formatting may need adjustment. Passing `--format` delegates that to the
already-configured formatter.

---

## Terminal UI Changes

### New icon constant
```js
const FIX = `${CYAN}⟳${R}`;
```

### Updated `printTask` signature
```js
function printTask(icon, label, time, skipped, counts, annotation = null)
```
`annotation` renders as a dimmed suffix after the elapsed time:
```
✓ lint   2.4s  (auto-fixed)
```

### Row state progression (lint example)
```
  ◆  lint                      ← initial running indicator (no newline)
  ⟳  lint   auto-fixing...     ← \r overwrite when fix starts
  ✓  lint   2.4s  (auto-fixed) ← \r overwrite when fix succeeds
```
or:
```
  ✗  lint   2.4s  2 errors     ← \r overwrite when fix fails (remaining only)
```

---

## New Helpers

### `runLintFix()`
```
runCommand('npm', ['run', 'lint:fix'])
returns { ok: boolean }
```

### `runKnipFix()`
```
runCommand('npx', ['knip', '--fix', '--fix-type', 'exports,types,dependencies', '--format'])
returns { ok: boolean }
```

### `isKnipFixable(errors)`
```
Returns true if at least one error in the list has a rule that our fix command can address.
Used to skip fix attempts when all errors are structurally unfixable.
```

---

## Elapsed Time

The time shown on the final task row covers the **full wall time**: original check + fix attempt
+ re-run check. This gives an accurate picture of how long the task actually took.

---

## LLM Block

The `llmPayload` emitted at the end uses the **re-run result** (remaining errors only), not the
original failure. This ensures the LLM context is actionable and not polluted with errors that
were already fixed.

---

## Files Changed

| File | Change |
|:--|:--|
| `scripts/tasks.mjs` | All implementation changes |
| `knip.json` | No change — config-level scope control lives here |
| `docs/specs/2026-04-29-auto-fix-workflow-design.md` | This document |
