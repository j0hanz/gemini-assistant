# Design: Two-Phase Test Failure UX for tasks.mjs

**Date:** 2026-04-29  
**Status:** Approved  
**Scope:** `scripts/tasks.mjs`

---

## Problem

When multiple tests fail, `tasks.mjs` currently renders a full failure card per test — file,
name, expected/actual, frame. With many failures this is visually overwhelming and makes it
hard to identify the root cause. Running tests outside `tasks.mjs` is even noisier with no
structured output at all.

---

## Solution: Two-Phase Triage + Drill-Down

### Phase 1 — Default Run (Triage View)

Replace the current full failure cards with a compact numbered list. One line per failure.

**Format:**

```
  ✖  tests  3.2s  3 failures

    1  session auth fails on expired token          __tests__/sessions.test.ts:42
    2  chat tool rejects empty prompt               __tests__/tools/chat.test.ts:18
    3  workspace cache refreshes on content change  __tests__/lib/workspace.test.ts:91

  → node scripts/tasks.mjs --detail 1
```

- Each failure is numbered starting at 1
- Shows: index · test name · file:line
- A hint line at the bottom tells you how to drill in
- File:line is the frame location already captured by `TapParser`

### Phase 2 — Drill-Down (`--detail <n>`)

```
node scripts/tasks.mjs --detail 2
```

Reads `.tasks-last-failure.json` instantly (no re-run). Finds the failure at index `n`.
Reads the source file **fresh from disk** (reflects current edits). Renders a source window:

**Format:**

```
  Failure 2 — chat tool rejects empty prompt

  error[AssertionError]  Expected truthy value
    --> __tests__/tools/chat.test.ts:18:5

     |
  16 │   it('rejects empty prompt', async () => {
  17 │     const result = await chat({ prompt: '' });
  18 │     assert.ok(result.error);
     │     ^^^
  19 │   });
     |
```

- Source window: ~10 lines around the failure frame (4 before, 5 after)
- Highlighted line rendered in bold; caret `^^^` on the line below pointing at `col`
- Error label: `error[<type>]` derived from `errorMessage` or `AssertionError` if expected/actual present
- Frame rendered as `file:line:col` with `-->` prefix (matches TypeScript compiler style)

### LLM Integration (`--detail <n> --llm`)

```
node scripts/tasks.mjs --detail 2 --llm
```

Emits a single JSON object to stdout instead of TTY output:

```json
{
  "index": 2,
  "name": "chat tool rejects empty prompt",
  "file": "__tests__/tools/chat.test.ts",
  "frame": "__tests__/tools/chat.test.ts:18:5",
  "errorMessage": "Expected truthy value",
  "expected": null,
  "actual": null,
  "sourceWindow": {
    "startLine": 14,
    "highlightLine": 18,
    "col": 5,
    "lines": [
      "  it('rejects empty prompt', async () => {",
      "    const result = await chat({ prompt: '' });",
      "    assert.ok(result.error);",
      "  });"
    ]
  }
}
```

**LLM agent workflow:**

1. Run `node scripts/tasks.mjs --llm` → get triage list with indices
2. Pick index to investigate
3. Run `node scripts/tasks.mjs --detail <n> --llm` → get structured detail
4. Fix code, repeat

The existing `--llm` flag on a full run stays unchanged (emits failure summary block).

---

## Implementation Touchpoints

| Area                | Location                                                 | Change                                                                             |
| :------------------ | :------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| CLI arg parsing     | `parseCliConfig()` ~L175                                 | Add `detail` option: `{ type: 'string' }`, validate it's a positive integer        |
| Triage renderer     | `TtyReporter.renderTestFailures()` ~L1309                | Replace full cards with numbered list + hint line                                  |
| Detail entry point  | Top-level `if (config !== null)` ~L1628                  | If `config.detail` set, skip `TaskOrchestrator`, call new `renderDetailCommand()`  |
| Detail renderer     | New `OutputRenderer.renderDetailView(failure, index)`    | Source window with highlight + caret, TTY and JSON modes                           |
| Source window       | New `OutputRenderer.renderSourceWindow(file, line, col)` | Read file via `SourceCache`, slice lines, render with gutter                       |
| Failure JSON format | `.tasks-last-failure.json` via `Aggregate.recordFail()`  | No schema change needed — `frame` already stored; `failures` array already indexed |

---

## Edge Cases

| Case                                  | Handling                                                                        |
| :------------------------------------ | :------------------------------------------------------------------------------ |
| `--detail` with no prior run          | Print: `No failure data found. Run tasks.mjs first.` exit 1                     |
| Index out of range                    | Print: `Failure <n> not found. Last run had <k> failures.` exit 1               |
| Frame missing (no source location)    | Render error info only, skip source window, note "no source location available" |
| File deleted/moved since last run     | Catch read error, render error info only, note stale failure data               |
| Non-test task failure with `--detail` | Only test failures are indexed; show: `--detail only applies to test failures`  |

---

## Non-Goals

- Watch mode (separate future feature)
- `--detail --rerun` (re-running the specific test — use `tasks.mjs` directly)
- Assertion diff view (expected vs actual colored diff — future enhancement on top of this)
- Full stack trace mode — current single-frame is sufficient for phase 1
