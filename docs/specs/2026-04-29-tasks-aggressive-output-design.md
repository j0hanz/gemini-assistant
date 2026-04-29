# Design: Aggressive Error Output & Hang Detection for `tasks.mjs`

**Date:** 2026-04-29  
**Status:** Approved  
**File:** `scripts/tasks.mjs`

---

## Problem

The current `tasks.mjs` script captures raw stdout/stderr and dumps up to 40 lines on failure. This has two major gaps:

1. **Error output is unstructured.** Lint, type-check, and test failures are printed as raw text — hard to scan, no source context, no column-level precision.
2. **Hanging tests are invisible.** When a test never completes, the script waits indefinitely. LLMs reading the output have no signal that a hang occurred, which test is responsible, or how long normal execution takes — causing them to set arbitrary timeouts and loop.

---

## Goals

- Rust-compiler-style error rendering with 3-line source context and `^^^` underlines.
- Per-test failure cards with assertion diffs and filtered stack frames.
- Per-test adaptive hang detection using historical baselines stored in `.tasks-history.json`.
- A fenced `## LLM CONTEXT` JSON block appended to all failure/timeout output so an LLM has structured, unambiguous data to act on.

---

## Architecture

```
tasks.mjs
  ├── History loader       read .tasks-history.json → per-test median baselines
  ├── Task runner          fail-fast, sequential
  │     ├── lint           spawn ESLint with --format=json → RustRenderer
  │     ├── type-check     spawn tsc --pretty false       → RustRenderer
  │     ├── test           spawn Node --test-reporter=tap
  │     │                    + TAP stream reader
  │     │                    + per-test silence timer (adaptive kill)
  │     │                    → TestFailureRenderer
  │     └── other          execSync, raw passthrough (format, build, knip)
  ├── SourceCache          Map<path, string[]> — lazy, per-run
  ├── RustRenderer         renderError(file, line, col, message, rule, severity)
  ├── TestFailureRenderer  renderFailureCard(name, file, expected, received, frame)
  ├── LlmBlock             emitLlmContext(failedTask, status, errors, hangInfo)
  └── History writer       append test durations on clean pass, trim to last 5
```

---

## Structured Output Parsing

| Task | Invocation change | Parser |
|:---|:---|:---|
| `lint` | Append `--format=json` | Parse JSON array of `{filePath, messages[]}` |
| `type-check` | Append `--pretty false` | Regex: `file(line,col): error TS####: message` |
| `test` | Add `--test-reporter=tap` | Line-by-line TAP: `ok N - name # time=Xms` / `not ok N - name` |
| `format`, `build`, `knip` | No change | Raw stdout/stderr passthrough |

---

## Rust-Style Error Rendering

Each lint or type-check error renders as:

```
error[no-unused-vars]  'foo' is defined but never used
  --> src/lib/streaming.ts:42:7
   |
41 │   const bar = 1;
42 │   const foo = 2;
   │         ^^^
43 │   return bar;
```

Rules:
- Source file is read once per path and cached in `SourceCache` for the run lifetime.
- Show line `N-1`, `N`, `N+1` (clamp at file boundaries).
- `^^^` underline starts at `col` (1-based) and spans the token width reported by the tool, or defaults to 3 characters when width is unavailable.
- `error[rule]` in red; `warning[rule]` in yellow.
- File path is relative to `process.cwd()`.

---

## Test Failure Cards

Each failing test renders as:

```
FAIL  src/__tests__/lib/orchestration.test.ts
  ✗  buildGenerateConfig › clamps thinkingBudget to GEMINI_THINKING_BUDGET_CAP

     AssertionError:
     - Expected   1
     + Received   2

     at src/__tests__/lib/orchestration.test.ts:88:5
```

Rules:
- TAP `not ok` blocks carry a YAML diagnostic (`---` … `...`) with `expected`, `actual`, and `at` fields.
- Stack frame: first frame that is not a Node.js internal (`node:`, `node_modules/`).
- If no diff is present (e.g. a thrown error), show the error `message` field instead.

---

## Task Summary Line

```
  ✗  lint        1.2s   3 errors · 2 warnings
  ⏱  test        6.2s   TIMED OUT  (baseline ~3.5s)
```

Error and warning counts are appended to the fail line. Timeout uses the `⏱` icon and shows the recorded baseline.

---

## Per-Test Hang Detection

### How it works

The TAP reporter emits one line per completed test. The silence timer fires when no new TAP output has arrived for:

```
silenceTimeout = max(1000ms, 10 × maxHistoricalDurationMs)
```

Where `maxHistoricalDurationMs` is the slowest individual test seen across all stored runs. With sub-millisecond tests, this typically resolves to the 1000ms floor — meaning any test that fails to complete within 1 second is flagged.

When the timer fires:
1. `SIGTERM` is sent to the test process.
2. The last completed test name and file are recorded (from the most recent `ok N` TAP line).
3. The output names the hanging test as "the next test after `lastCompleted`".

### Human output on hang

```
⏱  TIMED OUT — no TAP output for 4200ms

   Last completed test:
   ✔  clamps thinkingBudget to GEMINI_THINKING_BUDGET_CAP
      src/__tests__/lib/orchestration.test.ts

   → The hang likely occurred in the test immediately after this one.
     Check for: unclosed handles, unresolved promises, missing mock teardown.
```

---

## `.tasks-history.json`

Stored at project root. Written after every clean test pass. Never written on failure or timeout (hangs must not poison the baseline).

```json
{
  "test_durations": {
    "clamps thinkingBudget to GEMINI_THINKING_BUDGET_CAP": [2.5, 2.6, 2.4, 2.5, 2.7],
    "fills missing values from cost profiles": [0.22, 0.21, 0.23, 0.22, 0.20],
    "preserves systemInstruction when cachedContent is used": [0.21, 0.22, 0.20, 0.21, 0.22]
  }
}
```

- Maximum 5 entries per test name (oldest dropped on overflow).
- File is created on first clean pass if it does not exist.
- `.tasks-history.json` should be added to `.gitignore`.

---

## LLM CONTEXT Block

Emitted after all human output whenever `failed > 0` or `status === "timeout"`. Delimited by a horizontal rule so it is easy to locate and copy.

### Lint / type-check failure

````
─────────────────────────────────────────────────────
## LLM CONTEXT

```json
{
  "failed_task": "lint",
  "status": "failed",
  "total_errors": 3,
  "total_warnings": 2,
  "errors": [
    {
      "file": "src/lib/streaming.ts",
      "line": 42,
      "col": 7,
      "rule": "no-unused-vars",
      "severity": "error",
      "message": "'foo' is defined but never used"
    }
  ]
}
```
─────────────────────────────────────────────────────
````

### Test failure

````
```json
{
  "failed_task": "test",
  "status": "failed",
  "total_failures": 2,
  "failures": [
    {
      "name": "sanitizeHistoryParts › strips thought-only parts",
      "file": "src/__tests__/sessions.test.ts",
      "line": 88,
      "expected": "1",
      "received": "2"
    }
  ]
}
```
````

### Hang / timeout

````
```json
{
  "failed_task": "test",
  "status": "timeout",
  "silence_duration_ms": 4200,
  "silence_threshold_ms": 1000,
  "last_completed_test": {
    "name": "clamps thinkingBudget to GEMINI_THINKING_BUDGET_CAP",
    "file": "src/__tests__/lib/orchestration.test.ts",
    "duration_ms": 2.5
  },
  "suite_max_historical_ms": 2.7,
  "hint": "Process produced no TAP output for 4200ms after last completed test. The next test in the file is the likely culprit. Check for unclosed handles, unresolved promises, or missing mock teardown."
}
```
````

---

## Flags (unchanged + additive)

| Flag | Behaviour |
|:---|:---|
| `--fix` | Runs `lint:fix` instead of `lint` |
| `--fast` | Skips test task; also skips history read/write |

No new flags are introduced. Timeout threshold is derived automatically from history.

---

## Out of Scope

- Per-test timeout at the Node runner level (`--test-timeout`) — the silence-timer approach covers the hang case without requiring runner-level changes.
- `--llm` flag for pure JSON stdout — the fenced block covers the manual paste use case.
- Running all tasks after a failure (`--all` flag) — fail-fast is preserved.
- Warnings-as-errors configuration — ESLint already runs with `--max-warnings=0`.
