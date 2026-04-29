---
goal: Add --detail <n> drill-down and triage list to tasks.mjs for faster test failure diagnosis
version: 1
date_created: 2026-04-29
status: Planned
plan_type: feature
component: tasks-failure-diagnosis
execution: subagent-driven
---

# Implementation Plan: Two-Phase Test Failure UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Replace full failure cards in the default test run with a compact numbered triage list, and add `--detail <n>` to show a source-window drill-down for one failure read from the persisted failure file.

**Architecture:** All changes are confined to [scripts/tasks.mjs](scripts/tasks.mjs). Three new pure helpers (`parseFrame`, `buildSourceWindow` logic inside `renderSourceWindow`, `renderDetailView`) are added to `OutputRenderer`. `TtyReporter.renderTestFailures` is replaced with a triage-list renderer. A new top-level `renderDetailCommand` async function handles the `--detail` path and bypasses `TaskOrchestrator` entirely.

**Tech Stack:** Node.js ≥ 24, native `node:fs`, ANSI escape codes via the `Theme` object, `.tasks-last-failure.json` written by the existing `writeFailureFile`.

---

## 1. Goal

Running `node scripts/tasks.mjs` after test failures currently prints a full failure card per test — overwhelming when 10+ tests fail and making it hard to spot the root cause. This plan replaces that output with a compact numbered list (triage view) and adds `--detail <n>` to drill into one failure via a source-window (10 lines around the failure frame, highlighted line, `^^^` caret). The detail view reads the persisted `.tasks-last-failure.json` instantly — no re-run required. `--detail <n> --llm` emits machine-readable JSON for LLM agent fix loops.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                           |
| :---------------------------------------: | :---------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Default test failure output shows a numbered list with index, name (≤60 chars), and `file:line` extracted from the frame.           |
| [`REQ-002`](#2-requirements--constraints) | Requirement | `--detail <n>` reads `.tasks-last-failure.json`, resolves failure at index `n`, and renders a ~10-line source window.               |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `--detail <n> --llm` emits a single JSON object with index, name, file, frame, errorMessage, expected, actual, and sourceWindow.    |
| [`REQ-004`](#2-requirements--constraints) | Requirement | `--detail` bypasses `TaskOrchestrator` entirely — no tests are re-run.                                                              |
| [`CON-001`](#2-requirements--constraints) | Constraint  | `tasks.mjs` is not a module; tests inline-copy the logic under test (see [auto-fix.test.mjs](__tests__/scripts/auto-fix.test.mjs)). |
| [`CON-002`](#2-requirements--constraints) | Constraint  | No `console.log` — server code constraint applies to scripts too; use `process.stdout.write` / `process.stderr.write`.              |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [renderDiagnostic](scripts/tasks.mjs#L924) for ANSI-colored source output — same gutter/highlight style.                     |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Follow [renderTestFailureCard](scripts/tasks.mjs#L966) for failure card structure — same Theme + Icons constants.                   |

## 3. Current Context

### File structure

| File                                                                                   | Status | Responsibility                                |
| :------------------------------------------------------------------------------------- | :----- | :-------------------------------------------- |
| [scripts/tasks.mjs](scripts/tasks.mjs)                                                 | Modify | CLI orchestrator — all changes land here      |
| [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs) | Create | Inline-copy unit tests for all new pure logic |

### Relevant symbols

| Symbol                                          | Why it matters                                                                   |
| :---------------------------------------------- | :------------------------------------------------------------------------------- |
| [parseCliConfig](scripts/tasks.mjs#L175)        | Add `--detail <n>` string arg and validation                                     |
| [OutputRenderer](scripts/tasks.mjs#L919)        | Add `parseFrame`, `renderSourceWindow`, `renderDetailView`                       |
| [renderSourceContext](scripts/tasks.mjs#L943)   | Reference pattern for gutter/highlight; `renderSourceWindow` uses a wider window |
| [renderTestFailureCard](scripts/tasks.mjs#L966) | Replaced in flow by triage list; kept for `--verbose` future use                 |
| [TtyReporter](scripts/tasks.mjs#L1139)          | `renderTestFailures` method is replaced                                          |
| [SourceCache](scripts/tasks.mjs#L895)           | `sourceCache.lines(absPath)` provides fresh file lines for detail view           |
| [FileStore](scripts/tasks.mjs#L111)             | `FileStore.readJson` reads `.tasks-last-failure.json`                            |
| [Config](scripts/tasks.mjs#L14)                 | `Config.FAILURE_FILE` is the persisted failure path                              |
| [Theme](scripts/tasks.mjs#L30)                  | ANSI escape constants used throughout new output                                 |
| [noop](scripts/tasks.mjs#L1386)                 | Defined just before entry point; new `renderDetailCommand` goes after it         |
| [TaskOrchestrator](scripts/tasks.mjs#L1432)     | Entry point currently always constructs this; `--detail` bypasses it             |

### Existing commands

```bash
# Run all tests
node scripts/tasks.mjs

# Run a single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs

# Full check suite
node scripts/tasks.mjs --quick
```

### Current behavior

`TtyReporter.renderTestFailures` (L1309) renders a full card per failure (FAIL header, name, expected/actual or errorMessage, frame). The entry point (L1628) always constructs a `TaskOrchestrator`. There is no `--detail` arg and no triage list format.

## 4. Implementation Phases

### PHASE-001: CLI arg + frame parsing + source window

**Goal:** `parseCliConfig` accepts `--detail <n>`, validates it as a positive integer, and returns `detail: number | null`. `parseFrame` and `renderSourceWindow` exist on `OutputRenderer`.

|                                      Task                                       | Action                                  |                         Depends on                         | Files                                                                                                                          | Validate                                                                                 |
| :-----------------------------------------------------------------------------: | :-------------------------------------- | :--------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
|           [`TASK-001`](#task-001-add---detail-arg-to-parsecliconfig)            | Add `--detail` arg + HELP_TEXT entry    |                            none                            | [scripts/tasks.mjs](scripts/tasks.mjs), [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs) | `node --import tsx/esm --env-file=.env --test __tests__/scripts/detail-command.test.mjs` |
| [`TASK-002`](#task-002-add-parseframe-and-rendersourcewindow-to-outputrenderer) | Add `parseFrame` + `renderSourceWindow` | [`TASK-001`](#task-001-add---detail-arg-to-parsecliconfig) | [scripts/tasks.mjs](scripts/tasks.mjs), [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs) | `node --import tsx/esm --env-file=.env --test __tests__/scripts/detail-command.test.mjs` |

#### TASK-001: Add `--detail` arg to parseCliConfig

| Field      | Value                                                                                                                                             |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | none                                                                                                                                              |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs); Create: [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs)    |
| Symbols    | [parseCliConfig](scripts/tasks.mjs#L175)                                                                                                          |
| Outcome    | `--detail 2` parses to `config.detail === 2`; `--detail 0` / `--detail foo` / `--detail 1.5` print an error to stderr and return `null` (exit 2). |

- [ ] **Step 1: Write the failing tests**

```js
// __tests__/scripts/detail-command.test.mjs
import assert from 'node:assert/strict';

import { test } from 'node:test';

// Inline copy of the detail validation logic from parseCliConfig
function validateDetailArg(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

test('validateDetailArg returns null for undefined', () => {
  assert.equal(validateDetailArg(undefined), null);
});
test('validateDetailArg returns 1 for "1"', () => {
  assert.equal(validateDetailArg('1'), 1);
});
test('validateDetailArg returns 3 for "3"', () => {
  assert.equal(validateDetailArg('3'), 3);
});
test('validateDetailArg returns null for "0"', () => {
  assert.equal(validateDetailArg('0'), null);
});
test('validateDetailArg returns null for "-1"', () => {
  assert.equal(validateDetailArg('-1'), null);
});
test('validateDetailArg returns null for "foo"', () => {
  assert.equal(validateDetailArg('foo'), null);
});
test('validateDetailArg returns null for "1.5"', () => {
  assert.equal(validateDetailArg('1.5'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: 7 tests pass immediately (pure logic, no dependency on tasks.mjs yet). If all pass, the inline copy is correct — proceed.

- [ ] **Step 3: Update `parseCliConfig` in tasks.mjs**

In [scripts/tasks.mjs](scripts/tasks.mjs), apply three edits:

**Edit 1** — Add `--detail` to `HELP_TEXT` (L57–L67):

```js
const HELP_TEXT = [
  'Usage: node scripts/tasks.mjs [flags]',
  '',
  '  --fix        Run lint:fix / knip --fix instead of check',
  '  --quick      Skip test + rebuild',
  '  --all        Run-all mode: continue past failures across all tasks',
  '  --json       Emit single JSON object on stdout, suppress human output',
  '  --llm        Echo failure detail to stdout (always written to .tasks-last-failure.json)',
  '  --detail <n> Show source-window detail for test failure at index n',
  '  --help       Show this help',
  '',
].join('\n');
```

**Edit 2** — Add `detail` to `parseArgs` options inside `parseCliConfig` (L178–L188):

```js
options: {
  fix: { type: 'boolean' },
  quick: { type: 'boolean' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  llm: { type: 'boolean' },
  detail: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
},
```

**Edit 3** — Validate `detail` and include it in the returned config (L197–L209). Replace the `if (values.help)` block and return statement:

```js
if (values.help) {
  process.stdout.write(HELP_TEXT);
  process.exitCode = 0;
  return null;
}

if (values.detail !== undefined) {
  const n = Number(values.detail);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(
      `--detail requires a positive integer (got: ${values.detail})\n\n${HELP_TEXT}`,
    );
    process.exitCode = 2;
    return null;
  }
}

return Object.freeze({
  fix: !!values.fix,
  quick: !!values.quick,
  all: !!values.all,
  json: !!values.json,
  llm: !!values.llm,
  detail: values.detail !== undefined ? Number(values.detail) : null,
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs __tests__/scripts/detail-command.test.mjs
git commit -m "feat: add --detail <n> arg to tasks.mjs parseCliConfig"
```

---

#### TASK-002: Add `parseFrame` and `renderSourceWindow` to OutputRenderer

| Field      | Value                                                                                                                                                                                                                                                                             |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-add---detail-arg-to-parsecliconfig)                                                                                                                                                                                                                        |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs); Modify: [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs)                                                                                                                                    |
| Symbols    | [OutputRenderer](scripts/tasks.mjs#L919), [SourceCache](scripts/tasks.mjs#L895), [renderSourceContext](scripts/tasks.mjs#L943)                                                                                                                                                    |
| Outcome    | `OutputRenderer.renderSourceWindow(filePath, line, col)` returns a multi-line ANSI string with a 10-line window (4 before, 5 after) around the target line, bold highlight, and `^^^` caret. Module-level `parseFrame(frame)` parses `"file:line:col"` and `"file:line"` strings. |

- [ ] **Step 1: Write the failing tests**

Append to [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs):

```js
// Inline copies of parseFrame and buildSourceWindow (no ANSI codes in copies for testability)
function parseFrame(frame) {
  const m3 = /^(.+):(\d+):(\d+)$/.exec(frame);
  if (m3) return { file: m3[1], line: Number(m3[2]), col: Number(m3[3]) };
  const m2 = /^(.+):(\d+)$/.exec(frame);
  if (m2) return { file: m2[1], line: Number(m2[2]), col: 1 };
  return null;
}

function buildSourceWindow(src, line, col) {
  const BEFORE = 4;
  const AFTER = 5;
  const startLine = Math.max(1, line - BEFORE);
  const endLine = Math.min(src.length || line, line + AFTER);
  const gutterW = String(endLine).length;
  const pad = ' '.repeat(gutterW);
  const output = [];
  output.push(`${pad} |`);
  for (let n = startLine; n <= endLine; n++) {
    const srcLine = src[n - 1] || '';
    const gutter = String(n).padStart(gutterW);
    if (n === line) {
      output.push(`${gutter} │ ${srcLine}`);
      output.push(`${pad} │ ${' '.repeat(Math.max(0, col - 1))}^^^`);
    } else {
      output.push(`${gutter} │ ${srcLine}`);
    }
  }
  output.push(`${pad} |`);
  return output.join('\n');
}

test('parseFrame parses "file:line:col"', () => {
  assert.deepEqual(parseFrame('__tests__/foo.test.ts:18:5'), {
    file: '__tests__/foo.test.ts',
    line: 18,
    col: 5,
  });
});
test('parseFrame parses "file:line" with col defaulting to 1', () => {
  assert.deepEqual(parseFrame('src/foo.ts:42'), { file: 'src/foo.ts', line: 42, col: 1 });
});
test('parseFrame returns null for plain string', () => {
  assert.equal(parseFrame('no numbers here'), null);
});
test('parseFrame returns null for empty string', () => {
  assert.equal(parseFrame(''), null);
});

test('buildSourceWindow highlights the target line', () => {
  const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const out = buildSourceWindow(src, 10, 1);
  assert.ok(out.includes('10 │ line 10'), 'target line in output');
  assert.ok(out.includes('^^^'), 'caret present');
});
test('buildSourceWindow places caret at col offset', () => {
  const src = ['  foo bar'];
  const out = buildSourceWindow(src, 1, 3);
  assert.ok(out.includes('  ^^^'), 'caret at col 3 (2 spaces before)');
});
test('buildSourceWindow shows at most 4 lines before target', () => {
  const src = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
  const out = buildSourceWindow(src, 10, 1);
  assert.ok(out.includes('│ L6'), 'line 6 (10-4) visible');
  assert.ok(!out.includes('│ L5'), 'line 5 (10-5) not visible');
});
test('buildSourceWindow shows at most 5 lines after target', () => {
  const src = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
  const out = buildSourceWindow(src, 10, 1);
  assert.ok(out.includes('│ L15'), 'line 15 (10+5) visible');
  assert.ok(!out.includes('│ L16'), 'line 16 (10+6) not visible');
});
test('buildSourceWindow handles empty src gracefully', () => {
  const out = buildSourceWindow([], 1, 1);
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('|'), 'fence lines present');
});
test('buildSourceWindow clamps to start of file', () => {
  const src = ['a', 'b', 'c'];
  const out = buildSourceWindow(src, 1, 1);
  assert.ok(out.includes('│ a'), 'first line visible');
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass (inline copies are self-contained).

- [ ] **Step 3: Add `parseFrame` and `renderSourceWindow` to tasks.mjs**

**Edit 1** — Add module-level `parseFrame` function immediately before the `SourceCache` class (before L895):

```js
function parseFrame(frame) {
  const m3 = /^(.+):(\d+):(\d+)$/.exec(String(frame || ''));
  if (m3) return { file: m3[1], line: Number(m3[2]), col: Number(m3[3]) };
  const m2 = /^(.+):(\d+)$/.exec(String(frame || ''));
  if (m2) return { file: m2[1], line: Number(m2[2]), col: 1 };
  return null;
}
```

**Edit 2** — Add `renderSourceWindow` method to `OutputRenderer` (after the `clearCache` method at ~L921):

```js
  renderSourceWindow(filePath, line, col) {
    const src = filePath
      ? sourceCache.lines(path.resolve(process.cwd(), filePath))
      : [];
    const BEFORE = 4;
    const AFTER = 5;
    const startLine = Math.max(1, line - BEFORE);
    const endLine = Math.min(src.length || line, line + AFTER);
    const gutterW = String(endLine).length;
    const pad = ' '.repeat(gutterW);
    const output = [];

    output.push(`${Theme.DIM}${pad} |${Theme.R}`);
    for (let n = startLine; n <= endLine; n++) {
      const srcLine = src[n - 1] || '';
      const gutter = String(n).padStart(gutterW);
      if (n === line) {
        output.push(`${Theme.BOLD}${gutter}${Theme.R} ${Theme.DIM}│${Theme.R} ${srcLine}`);
        output.push(
          `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(Math.max(0, col - 1))}${Theme.RED}^^^${Theme.R}`,
        );
      } else {
        output.push(`${Theme.DIM}${gutter} │ ${srcLine}${Theme.R}`);
      }
    }
    output.push(`${Theme.DIM}${pad} |${Theme.R}`);
    return output.join('\n');
  },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs __tests__/scripts/detail-command.test.mjs
git commit -m "feat: add parseFrame and renderSourceWindow to tasks.mjs OutputRenderer"
```

---

### PHASE-002: Detail view + triage list

**Goal:** `OutputRenderer.renderDetailView` composes error header + source window. `TtyReporter.renderTestFailures` emits a compact numbered triage list with a hint line.

|                                Task                                 | Action                                        |                                   Depends on                                    | Files                                                                                                                          | Validate                                                                                 |
| :-----------------------------------------------------------------: | :-------------------------------------------- | :-----------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
|   [`TASK-003`](#task-003-add-renderdetailview-to-outputrenderer)    | Add `renderDetailView`                        | [`TASK-002`](#task-002-add-parseframe-and-rendersourcewindow-to-outputrenderer) | [scripts/tasks.mjs](scripts/tasks.mjs), [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs) | `node --import tsx/esm --env-file=.env --test __tests__/scripts/detail-command.test.mjs` |
| [`TASK-004`](#task-004-replace-rendertestfailures-with-triage-list) | Replace `renderTestFailures` with triage list |           [`TASK-001`](#task-001-add---detail-arg-to-parsecliconfig)            | [scripts/tasks.mjs](scripts/tasks.mjs), [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs) | `node --import tsx/esm --env-file=.env --test __tests__/scripts/detail-command.test.mjs` |

#### TASK-003: Add `renderDetailView` to OutputRenderer

| Field      | Value                                                                                                                                                                                                                                     |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-add-parseframe-and-rendersourcewindow-to-outputrenderer)                                                                                                                                                           |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs); Modify: [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs)                                                                                            |
| Symbols    | [OutputRenderer](scripts/tasks.mjs#L919)                                                                                                                                                                                                  |
| Outcome    | `OutputRenderer.renderDetailView(failure, index)` writes a formatted failure header (name, frame arrow, error label) followed by the source window to stdout. Falls back gracefully when `frame` is absent or the source file is missing. |

- [ ] **Step 1: Write the failing tests**

Append to [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs):

```js
// Inline copy of the detail view header composition logic (no ANSI)
function buildDetailHeader(failure, index) {
  const { name, frame, errorMessage, expected, actual } = failure;
  let errorLabel;
  if (expected !== undefined && actual !== undefined) {
    errorLabel = 'AssertionError';
  } else if (errorMessage) {
    errorLabel = errorMessage;
  } else {
    errorLabel = 'unknown error';
  }
  const lines = [`Failure ${index} — ${name}`];
  if (frame) {
    lines.push(`error  ${errorLabel}`);
    lines.push(`  --> ${frame}`);
  } else {
    lines.push(`error  ${errorLabel}`);
    lines.push('(no source location available)');
  }
  return lines.join('\n');
}

test('buildDetailHeader shows failure index and name', () => {
  const f = { name: 'test passes', frame: null, errorMessage: null };
  const out = buildDetailHeader(f, 2);
  assert.ok(out.includes('Failure 2'), 'index in header');
  assert.ok(out.includes('test passes'), 'name in header');
});
test('buildDetailHeader uses "AssertionError" when expected and actual are present', () => {
  const f = { name: 't', frame: 'f.ts:1:1', errorMessage: null, expected: '1', actual: '2' };
  assert.ok(buildDetailHeader(f, 1).includes('AssertionError'));
});
test('buildDetailHeader uses errorMessage when no expected/actual', () => {
  const f = {
    name: 't',
    frame: 'f.ts:1:1',
    errorMessage: 'Cannot read property x',
    expected: undefined,
    actual: undefined,
  };
  assert.ok(buildDetailHeader(f, 1).includes('Cannot read property x'));
});
test('buildDetailHeader uses "unknown error" when no errorMessage and no assertion', () => {
  const f = { name: 't', frame: null, errorMessage: null, expected: undefined, actual: undefined };
  assert.ok(buildDetailHeader(f, 1).includes('unknown error'));
});
test('buildDetailHeader shows frame arrow when frame present', () => {
  const f = { name: 't', frame: '__tests__/foo.ts:5:3', errorMessage: 'oops' };
  assert.ok(buildDetailHeader(f, 1).includes('--> __tests__/foo.ts:5:3'));
});
test('buildDetailHeader shows no-location note when frame is null', () => {
  const f = { name: 't', frame: null, errorMessage: 'oops' };
  assert.ok(buildDetailHeader(f, 1).includes('no source location available'));
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Add `renderDetailView` to `OutputRenderer` in tasks.mjs**

Add after `renderSourceWindow` (inserted in TASK-002), still inside the `OutputRenderer` object:

```js
  renderDetailView(failure, index) {
    const { name, frame, errorMessage, expected, actual } = failure;
    let errorLabel;
    if (expected !== undefined && actual !== undefined) {
      errorLabel = 'AssertionError';
    } else if (errorMessage) {
      errorLabel = errorMessage;
    } else {
      errorLabel = 'unknown error';
    }

    process.stdout.write(
      `\n  ${Theme.BOLD}Failure ${index}${Theme.R} — ${name}\n\n`,
    );
    process.stdout.write(
      `  ${Theme.RED}error${Theme.R}  ${Theme.DIM}${errorLabel}${Theme.R}\n`,
    );

    if (frame) {
      process.stdout.write(`    ${Theme.DIM}-->${Theme.R} ${frame}\n\n`);
      const parsed = parseFrame(frame);
      if (parsed) {
        process.stdout.write(this.renderSourceWindow(parsed.file, parsed.line, parsed.col));
        process.stdout.write('\n');
      }
    } else {
      process.stdout.write(`  ${Theme.DIM}(no source location available)${Theme.R}\n`);
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs __tests__/scripts/detail-command.test.mjs
git commit -m "feat: add renderDetailView to tasks.mjs OutputRenderer"
```

---

#### TASK-004: Replace `renderTestFailures` with triage list

| Field      | Value                                                                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-add---detail-arg-to-parsecliconfig)                                                                                                                 |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs); Modify: [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs)                             |
| Symbols    | [TtyReporter](scripts/tasks.mjs#L1139)                                                                                                                                     |
| Outcome    | `TtyReporter.renderTestFailures` emits a numbered list (one line per failure: `index · name · file:line`) followed by a hint line `→ node scripts/tasks.mjs --detail <n>`. |

- [ ] **Step 1: Write the failing tests**

Append to [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs):

```js
// Inline copy of triage list formatting
function buildTriageList(failures) {
  const maxIdx = String(failures.length).length;
  const lines = [];
  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    const idx = String(i + 1).padStart(maxIdx);
    const fileRef = f.frame ? f.frame.replace(/:(\d+):(\d+)$/, ':$1') : f.file || '';
    const nameStr = f.name.length > 60 ? f.name.slice(0, 60) : f.name;
    lines.push(`${idx}  ${nameStr.padEnd(62)}  ${fileRef}`);
  }
  return lines.join('\n');
}

test('buildTriageList numbers failures from 1', () => {
  const failures = [{ name: 'foo', frame: 'a.ts:1:1', file: '' }];
  assert.ok(buildTriageList(failures).startsWith('1  '));
});
test('buildTriageList extracts file:line (strips col) from frame', () => {
  const failures = [{ name: 'foo', frame: '__tests__/a.ts:42:7', file: '' }];
  const out = buildTriageList(failures);
  assert.ok(out.includes('__tests__/a.ts:42'), 'file:line present');
  assert.ok(!out.includes(':7'), 'col stripped');
});
test('buildTriageList falls back to file when frame absent', () => {
  const failures = [{ name: 'bar', frame: null, file: '__tests__/b.ts' }];
  assert.ok(buildTriageList(failures).includes('__tests__/b.ts'));
});
test('buildTriageList pads index for double-digit count', () => {
  const failures = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, frame: null, file: '' }));
  const lines = buildTriageList(failures).split('\n');
  assert.ok(lines[0].startsWith(' 1  '), 'single-digit padded');
  assert.ok(lines[9].startsWith('10  '), 'double-digit not padded');
});
test('buildTriageList truncates names longer than 60 chars', () => {
  const failures = [{ name: 'x'.repeat(70), frame: null, file: '' }];
  assert.ok(!buildTriageList(failures).includes('x'.repeat(61)));
});
test('buildTriageList handles empty failures array', () => {
  assert.equal(buildTriageList([]), '');
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass (inline copy is self-contained).

- [ ] **Step 3: Replace `renderTestFailures` in `TtyReporter`**

Replace [TtyReporter](scripts/tasks.mjs#L1139)'s `renderTestFailures` method (L1309–L1319) with:

```js
  renderTestFailures(failures) {
    process.stdout.write('\n');
    const maxIdx = String(failures.length).length;
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i];
      const idx = String(i + 1).padStart(maxIdx);
      const fileRef = f.frame
        ? f.frame.replace(/:(\d+):(\d+)$/, ':$1')
        : (f.file || '');
      const nameStr = Text.cap(f.name, 60);
      process.stdout.write(
        `    ${Theme.BOLD}${idx}${Theme.R}  ${nameStr.padEnd(62)}  ${Theme.DIM}${fileRef}${Theme.R}\n`,
      );
    }
    process.stdout.write(
      `\n  ${Theme.DIM}→ node scripts/tasks.mjs --detail <n>${Theme.R}\n\n`,
    );
  },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs __tests__/scripts/detail-command.test.mjs
git commit -m "feat: replace renderTestFailures with triage list in tasks.mjs"
```

---

### PHASE-003: Detail command + entry point

**Goal:** `renderDetailCommand` reads `.tasks-last-failure.json`, validates the index, and renders either the TTY detail view or a JSON object. The entry point dispatches to it when `config.detail !== null`.

|                         Task                          | Action                                   |                           Depends on                           | Files                                                                                                                          | Validate                                                                                 |
| :---------------------------------------------------: | :--------------------------------------- | :------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
|    [`TASK-005`](#task-005-add-renderdetailcommand)    | Add `renderDetailCommand` async function | [`TASK-003`](#task-003-add-renderdetailview-to-outputrenderer) | [scripts/tasks.mjs](scripts/tasks.mjs), [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs) | `node --import tsx/esm --env-file=.env --test __tests__/scripts/detail-command.test.mjs` |
| [`TASK-006`](#task-006-wire-entry-point-for---detail) | Wire entry point for `--detail`          |        [`TASK-005`](#task-005-add-renderdetailcommand)         | [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                         | `node scripts/tasks.mjs --help`                                                          |

#### TASK-005: Add `renderDetailCommand`

| Field      | Value                                                                                                                                                                                                                            |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-add-renderdetailview-to-outputrenderer)                                                                                                                                                                   |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs); Modify: [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs)                                                                                   |
| Symbols    | [FileStore](scripts/tasks.mjs#L111), [Config](scripts/tasks.mjs#L14), [OutputRenderer](scripts/tasks.mjs#L919), [noop](scripts/tasks.mjs#L1386)                                                                                  |
| Outcome    | `renderDetailCommand({ detail, llm })` reads failures from `.tasks-last-failure.json`, writes an error to stderr and sets exitCode 1 when the file is absent or the index is out of range, otherwise renders TTY or JSON output. |

- [ ] **Step 1: Write the failing tests**

Append to [**tests**/scripts/detail-command.test.mjs](__tests__/scripts/detail-command.test.mjs):

```js
// Inline copy of index validation logic from renderDetailCommand
function validateFailureIndex(failures, index) {
  if (!failures || failures.length === 0) return { error: 'no-failures' };
  if (index < 1 || index > failures.length) {
    return { error: 'out-of-range', count: failures.length };
  }
  return { failure: failures[index - 1] };
}

// Inline copy of LLM JSON payload builder
function buildLlmPayload(failure, index, src) {
  const parsed = failure.frame
    ? (() => {
        const m3 = /^(.+):(\d+):(\d+)$/.exec(String(failure.frame));
        if (m3) return { file: m3[1], line: Number(m3[2]), col: Number(m3[3]) };
        const m2 = /^(.+):(\d+)$/.exec(String(failure.frame));
        if (m2) return { file: m2[1], line: Number(m2[2]), col: 1 };
        return null;
      })()
    : null;

  const BEFORE = 4;
  const AFTER = 5;
  const windowLines =
    parsed && src.length > 0
      ? src.slice(Math.max(0, parsed.line - 1 - BEFORE), parsed.line + AFTER)
      : [];

  return {
    index,
    name: failure.name,
    file: failure.file || '',
    frame: failure.frame || null,
    errorMessage: failure.errorMessage ?? null,
    expected: failure.expected ?? null,
    actual: failure.actual ?? null,
    sourceWindow: parsed
      ? {
          startLine: Math.max(1, parsed.line - BEFORE),
          highlightLine: parsed.line,
          col: parsed.col,
          lines: windowLines,
        }
      : null,
  };
}

test('validateFailureIndex returns no-failures for empty array', () => {
  assert.deepEqual(validateFailureIndex([], 1), { error: 'no-failures' });
});
test('validateFailureIndex returns no-failures for null', () => {
  assert.deepEqual(validateFailureIndex(null, 1), { error: 'no-failures' });
});
test('validateFailureIndex returns out-of-range for index 0', () => {
  assert.equal(validateFailureIndex([{ name: 'x' }], 0).error, 'out-of-range');
});
test('validateFailureIndex returns out-of-range for index > length', () => {
  const r = validateFailureIndex([{ name: 'x' }], 2);
  assert.equal(r.error, 'out-of-range');
  assert.equal(r.count, 1);
});
test('validateFailureIndex returns the correct failure at index', () => {
  const f = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(validateFailureIndex(f, 2), { failure: { name: 'b' } });
});

test('buildLlmPayload includes index and name', () => {
  const f = { name: 'my test', frame: null, file: '', errorMessage: null };
  const p = buildLlmPayload(f, 3, []);
  assert.equal(p.index, 3);
  assert.equal(p.name, 'my test');
});
test('buildLlmPayload sets sourceWindow to null when frame absent', () => {
  const f = { name: 't', frame: null, file: '', errorMessage: null };
  assert.equal(buildLlmPayload(f, 1, []).sourceWindow, null);
});
test('buildLlmPayload populates sourceWindow with highlightLine when frame present', () => {
  const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const f = { name: 't', frame: 'foo.ts:10:3', file: '', errorMessage: null };
  const p = buildLlmPayload(f, 1, src);
  assert.equal(p.sourceWindow.highlightLine, 10);
  assert.equal(p.sourceWindow.col, 3);
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Add `renderDetailCommand` to tasks.mjs**

Add this async function immediately after [noop](scripts/tasks.mjs#L1386) (after L1388), before `writeFailureFile`:

```js
async function renderDetailCommand(config) {
  const { detail: index, llm } = config;

  const data = await FileStore.readJson(Config.FAILURE_FILE, null);
  if (!data) {
    process.stderr.write(`No failure data found. Run node scripts/tasks.mjs first.\n`);
    process.exitCode = 1;
    return;
  }

  const testTask = Array.isArray(data.tasks)
    ? data.tasks.find(
        (t) => t.label === 'test' && !t.ok && Array.isArray(t.failures) && t.failures.length > 0,
      )
    : null;
  const failures = testTask?.failures ?? [];

  if (failures.length === 0) {
    process.stderr.write(`No test failures in last run.\n`);
    process.exitCode = 1;
    return;
  }

  if (index < 1 || index > failures.length) {
    process.stderr.write(
      `Failure ${index} not found. Last run had ${Text.plural(failures.length, 'failure')}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const failure = failures[index - 1];

  if (llm) {
    const parsed = failure.frame ? parseFrame(failure.frame) : null;
    const src = parsed ? sourceCache.lines(path.resolve(process.cwd(), parsed.file)) : [];
    const BEFORE = 4;
    const AFTER = 5;
    const startLine = parsed ? Math.max(1, parsed.line - BEFORE) : 1;
    const endLine = parsed ? Math.min(src.length || parsed.line, parsed.line + AFTER) : 1;
    const windowLines = src.slice(startLine - 1, endLine);

    process.stdout.write(
      JSON.stringify(
        {
          index,
          name: failure.name,
          file: failure.file || '',
          frame: failure.frame || null,
          errorMessage: failure.errorMessage ?? null,
          expected: failure.expected ?? null,
          actual: failure.actual ?? null,
          sourceWindow: parsed
            ? { startLine, highlightLine: parsed.line, col: parsed.col, lines: windowLines }
            : null,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    OutputRenderer.renderDetailView(failure, index);
    process.stdout.write('\n');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs __tests__/scripts/detail-command.test.mjs
git commit -m "feat: add renderDetailCommand to tasks.mjs"
```

---

#### TASK-006: Wire entry point for `--detail`

| Field      | Value                                                                                                                                                                                                  |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-add-renderdetailcommand)                                                                                                                                                        |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                         |
| Symbols    | [TaskOrchestrator](scripts/tasks.mjs#L1432)                                                                                                                                                            |
| Outcome    | `node scripts/tasks.mjs --detail <n>` dispatches to `renderDetailCommand` and never constructs `TaskOrchestrator`. TDD skipped — entry point is pure structural wiring with no extractable pure logic. |

- [ ] **Step 1: Apply the entry point change**

Replace the last 3 lines of [scripts/tasks.mjs](scripts/tasks.mjs) (L1628–L1631):

**Before:**

```js
const config = parseCliConfig(process.argv.slice(2));
if (config !== null) {
  process.exitCode = await new TaskOrchestrator(config).run();
}
```

**After:**

```js
const config = parseCliConfig(process.argv.slice(2));
if (config !== null) {
  if (config.detail !== null) {
    await renderDetailCommand(config);
  } else {
    process.exitCode = await new TaskOrchestrator(config).run();
  }
}
```

- [ ] **Step 2: Verify help text shows `--detail`**

```bash
node scripts/tasks.mjs --help
```

Expected output includes the line:

```
  --detail <n> Show source-window detail for test failure at index n
```

- [ ] **Step 3: Verify error messages for edge cases**

```bash
node scripts/tasks.mjs --detail 0; echo "exit: $?"
```

Expected: `--detail requires a positive integer (got: 0)` on stderr, exit code 2.

```bash
node scripts/tasks.mjs --detail 99; echo "exit: $?"
```

Expected (when no `.tasks-last-failure.json` exists): `No failure data found. Run node scripts/tasks.mjs first.` on stderr, exit code 1.

- [ ] **Step 4: Verify `--detail` output against a fixture**

Create a minimal fixture, run `--detail 1`, verify source window appears:

```bash
node -e "
const fs = require('fs');
fs.writeFileSync('.tasks-last-failure.json', JSON.stringify({
  ok: false, mode: 'fail-fast', wallMs: 1000,
  tasks: [{
    label: 'test', ok: false, ms: 500, skipped: false,
    failures: [{
      name: 'my test fails',
      file: '',
      frame: 'scripts/tasks.mjs:14:1',
      errorMessage: 'Expected true but got false',
      expected: undefined,
      actual: undefined
    }]
  }],
  slowestTests: [], failureSummary: 'test: 1 failure'
}, null, 2));
"
node scripts/tasks.mjs --detail 1
```

Expected: TTY output shows `Failure 1 — my test fails`, the frame `scripts/tasks.mjs:14:1`, and a source window showing lines around L14 of [scripts/tasks.mjs](scripts/tasks.mjs).

```bash
node scripts/tasks.mjs --detail 1 --llm
```

Expected: valid JSON on stdout with `"index": 1`, `"name": "my test fails"`, `"sourceWindow"` with `"highlightLine": 14`.

```bash
rm -f .tasks-last-failure.json
```

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat: wire --detail dispatch at tasks.mjs entry point"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — all new unit tests pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/scripts/detail-command.test.mjs
```

### [`VAL-002`](#5-testing--validation) — full task suite passes

```bash
node scripts/tasks.mjs --quick
```

### [`VAL-003`](#5-testing--validation) — `--help` shows `--detail`

```bash
node scripts/tasks.mjs --help | grep detail
```

Expected: line containing `--detail <n>`.

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                                  |
| :--------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | Running `node scripts/tasks.mjs` after test failures shows a numbered list (one line per failure) with a hint `→ node scripts/tasks.mjs --detail <n>` — no full cards.              |
| [`AC-002`](#6-acceptance-criteria) | `node scripts/tasks.mjs --detail 2` reads `.tasks-last-failure.json` instantly, prints a source window (~10 lines) around the failure frame with a `^^^` caret on the failing line. |
| [`AC-003`](#6-acceptance-criteria) | `node scripts/tasks.mjs --detail 2 --llm` emits a single JSON object with `index`, `name`, `file`, `frame`, `errorMessage`, `expected`, `actual`, `sourceWindow`.                   |
| [`AC-004`](#6-acceptance-criteria) | `node scripts/tasks.mjs --detail 0` exits with code 2 and a usage error on stderr.                                                                                                  |
| [`AC-005`](#6-acceptance-criteria) | `node scripts/tasks.mjs --detail 99` (no prior run) exits with code 1 and `No failure data found` on stderr.                                                                        |
| [`AC-006`](#6-acceptance-criteria) | `node scripts/tasks.mjs --quick` passes — all existing tests and static checks remain green.                                                                                        |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                             |
| :---------------------------: | :--: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`NOTE-001`](#7-risks--notes) | Note | `tasks.mjs` is not an ES module — tests use inline copies of logic (see [auto-fix.test.mjs](__tests__/scripts/auto-fix.test.mjs) for the established pattern). Do not attempt to import from it.                   |
| [`NOTE-002`](#7-risks--notes) | Note | The `sourceCache` singleton is empty when `--detail` is invoked (no prior `clearCache()` calls), so `sourceCache.lines()` always reads fresh from disk — this is the desired behavior.                             |
| [`NOTE-003`](#7-risks--notes) | Note | `renderTestFailureCard` is not deleted — it remains in `OutputRenderer` for potential future `--verbose` use. Only `TtyReporter.renderTestFailures` is replaced.                                                   |
| [`RISK-001`](#7-risks--notes) | Risk | If a failure's `frame` contains a Windows-style path (`C:\...`), `parseFrame`'s regex `(.+):(\d+):(\d+)` will still match the last `:line:col` suffix correctly since `.+` is greedy. Verify on Windows if needed. |
| [`NOTE-004`](#7-risks--notes) | Note | Delete the fixture `.tasks-last-failure.json` created in TASK-006 Step 4 before committing (Step 5 does not `git add` it, but `git status` should confirm it is absent or gitignored).                             |
