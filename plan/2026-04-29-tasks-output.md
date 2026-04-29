---
goal: Replace tasks.mjs raw error output with Rust-style rendering, structured parsers, per-test adaptive hang detection, and a fenced LLM CONTEXT JSON block
version: 1
date_created: 2026-04-29
status: Planned
plan_type: feature
component: tasks-script
execution: subagent-driven
---

# Implementation Plan: Error Output & Hang Detection for tasks.mjs

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Replace `tasks.mjs` raw stdout/stderr dumps with Rust-compiler-style error rendering (file, line, col, 3-line source context, `^^^` underline), structured parsers for ESLint JSON / tsc / TAP, per-test adaptive silence-timer hang detection backed by `.tasks-history.json`, and a fenced `## LLM CONTEXT` JSON block so both developers and LLMs get precise, actionable failure data.

**Architecture:** Three focused helper modules (`tasks-parse.mjs`, `tasks-render.mjs`, `tasks-history.mjs`) sit alongside the existing `scripts/tasks.mjs`. The task-runner loop is refactored to support async `runner` functions for lint/type-check/test while keeping `execSync` for format/build/knip. Every helper module has a corresponding `.test.mjs` file under `__tests__/scripts/`. On any failure or timeout the LLM block is emitted after the human-readable output.

**Tech Stack:** Node.js ≥ 24 ESM; zero new runtime dependencies. Parsers target ESLint `--format=json`, `tsc --pretty false`, and Node TAP (`--test-reporter=tap`). Tests use Node built-in `node:test` + `node:assert/strict`.

---

## 1. Goal

`tasks.mjs` currently captures raw stdout/stderr and dumps up to 40 lines on failure — unstructured and unactionable. LLMs reading it cannot distinguish a lint error from a hanging test process, and developers must mentally parse compiler noise to find the offending line. This plan replaces that with compiler-quality output: each error shows its source context with an underline pointer, test failures show assertion diffs, and a hanging test produces a named culprit and silence duration. A structured JSON block at the end gives LLMs the same information in a parseable form. Success is observable: running `npm run tasks` on a project with a lint error renders a Rust-style block; a hung test is killed within 1 s (baseline) and names the last-completed test.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                       |
| :---------------------------------------: | :---------- | :------------------------------------------------------------------------------------------------------------------------------ |
| [`REQ-001`](#2-requirements--constraints) | Requirement | ESLint errors render with 3-line source context and `^^^` underline at exact column.                                            |
| [`REQ-002`](#2-requirements--constraints) | Requirement | tsc errors render with the same Rust-style format as lint errors.                                                               |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Test failures render a card: test name, file path, `- Expected / + Received` diff, first non-internal stack frame.              |
| [`REQ-004`](#2-requirements--constraints) | Requirement | A hanging test is killed after `max(1000ms, 10 × maxHistoricalMs)` of TAP output silence.                                       |
| [`REQ-005`](#2-requirements--constraints) | Requirement | Per-test durations are stored in `.tasks-history.json` (max 5 per test); written only on a clean pass.                          |
| [`REQ-006`](#2-requirements--constraints) | Requirement | A fenced `## LLM CONTEXT` JSON block is emitted after all human output on any failure or timeout.                               |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No new runtime npm dependencies — Node built-ins only.                                                                          |
| [`CON-002`](#2-requirements--constraints) | Constraint  | Existing `--fix` and `--fast` flags must continue to work.                                                                      |
| [`CON-003`](#2-requirements--constraints) | Constraint  | `.tasks-history.json` must be added to `.gitignore`.                                                                            |
| [`CON-004`](#2-requirements--constraints) | Constraint  | New `scripts/*.mjs` files require explicit exceptions in `.gitignore` (the file contains `scripts/*`).                          |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow the existing [tasks](scripts/tasks.mjs#L26) array + sequential runner pattern in [scripts/tasks.mjs](scripts/tasks.mjs). |

## 3. Current Context

### File structure

| File                                                                                 | Status | Responsibility                                                                      |
| :----------------------------------------------------------------------------------- | :----- | :---------------------------------------------------------------------------------- |
| [scripts/tasks.mjs](scripts/tasks.mjs)                                               | Modify | Main runner: task loop, ANSI output, arg parsing                                    |
| [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs)                                   | Create | Pure parsers: ESLint JSON, tsc stderr, TAP lines, YAML diagnostic blocks            |
| [scripts/tasks-render.mjs](scripts/tasks-render.mjs)                                 | Create | Rust-style error renderer, test failure card, LLM block emitter, source file cache  |
| [scripts/tasks-history.mjs](scripts/tasks-history.mjs)                               | Create | Load/save `.tasks-history.json`, compute silence timeout from per-test medians      |
| [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs)     | Create | Unit tests for all three parsers                                                    |
| [**tests**/scripts/tasks-render.test.mjs](__tests__/scripts/tasks-render.test.mjs)   | Create | Unit tests for Rust renderer output structure and failure cards                     |
| [**tests**/scripts/tasks-history.test.mjs](__tests__/scripts/tasks-history.test.mjs) | Create | Unit tests for load/save/timeout calculation                                        |
| [.gitignore](.gitignore)                                                             | Modify | Add `.tasks-history.json` exclusion; add exceptions for new `scripts/*.mjs` modules |

### Relevant symbols

| Symbol                               | Why it matters                                                             |
| :----------------------------------- | :------------------------------------------------------------------------- |
| [fix](scripts/tasks.mjs#L22)         | Flag controlling lint vs lint:fix — must be preserved in refactored runner |
| [fast](scripts/tasks.mjs#L23)        | Flag skipping test task — must also skip history read/write                |
| [tasks](scripts/tasks.mjs#L26)       | Task definition array — extended to support `runner` async functions       |
| [elapsed](scripts/tasks.mjs#L37)     | Timing helper — reused unchanged                                           |
| [printHeader](scripts/tasks.mjs#L41) | Header printer — reused unchanged                                          |
| [printTask](scripts/tasks.mjs#L47)   | Per-task status line — extended with error/warning counts                  |
| [passed](scripts/tasks.mjs#L67)      | Pass counter — unchanged                                                   |
| [failed](scripts/tasks.mjs#L68)      | Fail counter — unchanged                                                   |

### Existing commands

```bash
# Run full check suite (used to verify nothing broke)
npm run test

# Run tasks script
npm run tasks

# Run a single test file
node --test __tests__/scripts/tasks-parse.test.mjs
```

### Current behavior

`tasks.mjs` runs six tasks sequentially via `execSync`. On failure it captures stdout/stderr and calls `printOutput()` which dumps up to 40 raw lines and exits. There is no structured parsing, no source context, no hang detection, and no LLM-readable block.

## 4. Implementation Phases

### PHASE-001: Parse module + gitignore

**Goal:** `scripts/tasks-parse.mjs` exists with tested ESLint JSON, tsc, and TAP parsers; `.gitignore` allows the new script modules and excludes `.tasks-history.json`.

|                            Task                             | Action                                    |                    Depends on                     | Files                                                                                                                                | Validate                                             |
| :---------------------------------------------------------: | :---------------------------------------- | :-----------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
|          [`TASK-001`](#task-001-update-gitignore)           | Update `.gitignore`                       |                       none                        | [.gitignore](.gitignore)                                                                                                             | `git status`                                         |
|      [`TASK-002`](#task-002-create-eslint-json-parser)      | Create ESLint JSON parser + tests         |     [`TASK-001`](#task-001-update-gitignore)      | [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs), [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs) | `node --test __tests__/scripts/tasks-parse.test.mjs` |
|        [`TASK-003`](#task-003-add-tsc-stderr-parser)        | Add tsc stderr parser + tests             | [`TASK-002`](#task-002-create-eslint-json-parser) | [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs), [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs) | `node --test __tests__/scripts/tasks-parse.test.mjs` |
| [`TASK-004`](#task-004-add-tap-line-and-yaml-block-parsers) | Add TAP + YAML diagnostic parsers + tests |   [`TASK-003`](#task-003-add-tsc-stderr-parser)   | [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs), [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs) | `node --test __tests__/scripts/tasks-parse.test.mjs` |

#### TASK-001: Update gitignore

| Field      | Value                                                                                                                    |
| :--------- | :----------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                     |
| Files      | Modify: [.gitignore](.gitignore)                                                                                         |
| Symbols    | none                                                                                                                     |
| Outcome    | `.tasks-history.json` is excluded and the three new `scripts/*.mjs` modules are allowed. TDD skipped — pure config edit. |

- [ ] **Step 1: Apply change**

Add to [.gitignore](.gitignore) immediately after the `!scripts/tasks.mjs` line:

```
!scripts/tasks-parse.mjs
!scripts/tasks-render.mjs
!scripts/tasks-history.mjs
```

Add `.tasks-history.json` to the root-level exclusions block (near `.env`):

```
.tasks-history.json
```

- [ ] **Step 2: Verify**

```bash
git status
```

Expected: `.gitignore` appears as modified; no untracked `scripts/tasks-parse.mjs` warning yet (file doesn't exist).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: allow new tasks-parse/render/history modules in gitignore, exclude .tasks-history.json"
```

---

#### TASK-002: Create ESLint JSON parser

| Field      | Value                                                                                                                                                |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-update-gitignore)                                                                                                             |
| Files      | Create: [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs); Create: [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs) |
| Symbols    | [parseEslintJson](scripts/tasks-parse.mjs)                                                                                                           |
| Outcome    | `parseEslintJson(jsonStr, cwd)` converts ESLint JSON output into a flat array of `{file, line, col, endCol, rule, severity, message}` objects.       |

- [ ] **Step 1: Write the failing test**

```js
// __tests__/scripts/tasks-parse.test.mjs
import assert from 'node:assert/strict';

import { test } from 'node:test';

import { parseEslintJson } from '../../scripts/tasks-parse.mjs';

test('parseEslintJson extracts error fields', () => {
  const input = JSON.stringify([
    {
      filePath: '/project/src/foo.ts',
      messages: [
        {
          ruleId: 'no-unused-vars',
          severity: 2,
          message: "'x' is unused",
          line: 5,
          column: 3,
          endColumn: 4,
        },
      ],
      errorCount: 1,
      warningCount: 0,
    },
  ]);
  const result = parseEslintJson(input, '/project');
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'src/foo.ts');
  assert.equal(result[0].line, 5);
  assert.equal(result[0].col, 3);
  assert.equal(result[0].endCol, 4);
  assert.equal(result[0].rule, 'no-unused-vars');
  assert.equal(result[0].severity, 'error');
  assert.equal(result[0].message, "'x' is unused");
});

test('parseEslintJson maps severity 1 to warning', () => {
  const input = JSON.stringify([
    {
      filePath: '/project/src/bar.ts',
      messages: [
        {
          ruleId: 'semi',
          severity: 1,
          message: 'Missing semicolon',
          line: 2,
          column: 10,
          endColumn: 11,
        },
      ],
      errorCount: 0,
      warningCount: 1,
    },
  ]);
  const result = parseEslintJson(input, '/project');
  assert.equal(result[0].severity, 'warning');
});

test('parseEslintJson skips files with no messages', () => {
  const input = JSON.stringify([
    { filePath: '/project/src/clean.ts', messages: [], errorCount: 0, warningCount: 0 },
  ]);
  const result = parseEslintJson(input, '/project');
  assert.equal(result.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
```

Expected: FAIL with `Cannot find module '../../scripts/tasks-parse.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

```js
// scripts/tasks-parse.mjs
import path from 'node:path';

export function parseEslintJson(jsonStr, cwd) {
  const results = JSON.parse(jsonStr);
  const errors = [];
  for (const file of results) {
    if (!file.messages.length) continue;
    const rel = file.filePath.startsWith(cwd)
      ? file.filePath.slice(cwd.length + 1).replace(/\\/g, '/')
      : file.filePath;
    for (const msg of file.messages) {
      errors.push({
        file: rel,
        line: msg.line ?? 1,
        col: msg.column ?? 1,
        endCol: msg.endColumn ?? (msg.column ?? 1) + 3,
        rule: msg.ruleId ?? 'unknown',
        severity: msg.severity === 1 ? 'warning' : 'error',
        message: msg.message,
      });
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
```

Expected: PASS — all 3 subtests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks-parse.mjs __tests__/scripts/tasks-parse.test.mjs
git commit -m "feat(tasks): add ESLint JSON parser with tests"
```

---

#### TASK-003: Add tsc stderr parser

| Field      | Value                                                                                                                                                |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-create-eslint-json-parser)                                                                                                    |
| Files      | Modify: [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs); Modify: [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs) |
| Symbols    | [parseTscOutput](scripts/tasks-parse.mjs)                                                                                                            |
| Outcome    | `parseTscOutput(text)` parses `--pretty false` tsc output into the same `{file, line, col, endCol, rule, severity, message}` shape.                  |

- [ ] **Step 1: Write the failing test**

Append to [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs):

```js
import { parseEslintJson, parseTscOutput } from '../../scripts/tasks-parse.mjs';

test('parseTscOutput extracts error from tsc --pretty false format', () => {
  const input = `src/lib/streaming.ts(42,7): error TS2304: Cannot find name 'foo'.
src/lib/streaming.ts(43,1): warning TS6133: 'bar' is declared but never used.`;
  const result = parseTscOutput(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].file, 'src/lib/streaming.ts');
  assert.equal(result[0].line, 42);
  assert.equal(result[0].col, 7);
  assert.equal(result[0].rule, 'TS2304');
  assert.equal(result[0].severity, 'error');
  assert.match(result[0].message, /Cannot find name/);
  assert.equal(result[1].severity, 'warning');
});

test('parseTscOutput returns empty array for clean output', () => {
  assert.deepEqual(parseTscOutput(''), []);
  assert.deepEqual(parseTscOutput('Found 0 errors.'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
```

Expected: FAIL with `parseTscOutput is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs):

```js
const TSC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

export function parseTscOutput(text) {
  const errors = [];
  for (const line of text.split('\n')) {
    const m = line.match(TSC_RE);
    if (!m) continue;
    errors.push({
      file: m[1].replace(/\\/g, '/'),
      line: Number(m[2]),
      col: Number(m[3]),
      endCol: Number(m[3]) + 3,
      rule: m[5],
      severity: m[4],
      message: m[6],
    });
  }
  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
```

Expected: PASS — all 5 subtests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks-parse.mjs __tests__/scripts/tasks-parse.test.mjs
git commit -m "feat(tasks): add tsc stderr parser"
```

---

#### TASK-004: Add TAP line and YAML block parsers

| Field      | Value                                                                                                                                                       |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-add-tsc-stderr-parser)                                                                                                               |
| Files      | Modify: [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs); Modify: [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs)        |
| Symbols    | [parseTapLine](scripts/tasks-parse.mjs), [parseYamlBlock](scripts/tasks-parse.mjs)                                                                          |
| Outcome    | `parseTapLine(line)` classifies TAP lines; `parseYamlBlock(lines[])` extracts `expected`, `actual`, `error`, `stack`/`at` from a TAP YAML diagnostic block. |

- [ ] **Step 1: Write the failing test**

Append to [**tests**/scripts/tasks-parse.test.mjs](__tests__/scripts/tasks-parse.test.mjs):

```js
import {
  parseEslintJson,
  parseTapLine,
  parseTscOutput,
  parseYamlBlock,
} from '../../scripts/tasks-parse.mjs';

test('parseTapLine identifies ok line with duration', () => {
  const ev = parseTapLine('        ok 3 - fills missing values # time=0.225ms');
  assert.equal(ev.type, 'ok');
  assert.equal(ev.name, 'fills missing values');
  assert.equal(ev.duration, 0.225);
});

test('parseTapLine identifies not ok line', () => {
  const ev = parseTapLine('        not ok 5 - throws for unknown profiles');
  assert.equal(ev.type, 'not_ok');
  assert.equal(ev.name, 'throws for unknown profiles');
});

test('parseTapLine identifies yaml_start and yaml_end', () => {
  assert.equal(parseTapLine('          ---').type, 'yaml_start');
  assert.equal(parseTapLine('          ...').type, 'yaml_end');
});

test('parseYamlBlock extracts expected, actual, and at from stack', () => {
  const lines = [
    '  duration_ms: 0.123',
    "  failureType: 'testCodeFailure'",
    '  expected: 2',
    '  actual: 1',
    '  stack: |-',
    '    at TestContext.<anonymous> (src/__tests__/lib/orch.test.ts:88:5)',
    '    at node:internal/test_runner/test.js:12:3',
  ];
  const result = parseYamlBlock(lines);
  assert.equal(result.expected, '2');
  assert.equal(result.actual, '1');
  assert.match(result.at, /orch\.test\.ts:88:5/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
```

Expected: FAIL with `parseTapLine is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to [scripts/tasks-parse.mjs](scripts/tasks-parse.mjs):

```js
export function parseTapLine(line) {
  const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
  const ok = /^\s*ok \d+ - (.+?)(?:\s+#\s+time=(\S+))?$/.exec(line);
  if (ok)
    return {
      type: 'ok',
      depth: indent,
      name: ok[1].trim(),
      duration: ok[2] ? parseFloat(ok[2]) : 0,
    };
  const notOk = /^\s*not ok \d+ - (.+)$/.exec(line);
  if (notOk) return { type: 'not_ok', depth: indent, name: notOk[1].trim() };
  if (/^\s+---\s*$/.test(line)) return { type: 'yaml_start' };
  if (/^\s+\.\.\.\s*$/.test(line)) return { type: 'yaml_end' };
  return { type: 'raw', line };
}

export function parseYamlBlock(lines) {
  const result = {};
  let multiKey = null;
  const multiLines = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (multiKey) {
      // detect new top-level key (no leading spaces relative to block indent)
      if (/^\w+:/.test(trimmed)) {
        result[multiKey] = multiLines.join('\n').trim();
        multiKey = null;
        multiLines.length = 0;
      } else {
        multiLines.push(trimmed);
        continue;
      }
    }
    const kv = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '|-' || val === '|') {
      multiKey = key;
      multiLines.length = 0;
    } else {
      result[key] = val.replace(/^'|'$/g, '');
    }
  }
  if (multiKey) result[multiKey] = multiLines.join('\n').trim();
  // extract first non-internal frame from stack when `at` is absent
  if (!result.at && result.stack) {
    const m = result.stack.match(/at .+? \(([^)]+:\d+:\d+)\)/);
    if (m && !m[1].startsWith('node:')) result.at = m[1];
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
```

Expected: PASS — all 9 subtests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks-parse.mjs __tests__/scripts/tasks-parse.test.mjs
git commit -m "feat(tasks): add TAP line parser and YAML diagnostic block parser"
```

---

### PHASE-002: Render module

**Goal:** `scripts/tasks-render.mjs` renders Rust-style error blocks, test failure cards, and the LLM context block; all rendering logic is unit-tested.

|                                Task                                 | Action                                       |                         Depends on                          | Files                                                                                                                                    | Validate                                              |
| :-----------------------------------------------------------------: | :------------------------------------------- | :---------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------- |
|      [`TASK-005`](#task-005-create-rust-style-error-renderer)       | Create Rust renderer + source cache + tests  | [`TASK-004`](#task-004-add-tap-line-and-yaml-block-parsers) | [scripts/tasks-render.mjs](scripts/tasks-render.mjs), [**tests**/scripts/tasks-render.test.mjs](__tests__/scripts/tasks-render.test.mjs) | `node --test __tests__/scripts/tasks-render.test.mjs` |
| [`TASK-006`](#task-006-add-test-failure-card-and-llm-block-emitter) | Add failure card + LLM block emitter + tests |  [`TASK-005`](#task-005-create-rust-style-error-renderer)   | [scripts/tasks-render.mjs](scripts/tasks-render.mjs), [**tests**/scripts/tasks-render.test.mjs](__tests__/scripts/tasks-render.test.mjs) | `node --test __tests__/scripts/tasks-render.test.mjs` |

#### TASK-005: Create Rust-style error renderer

| Field      | Value                                                                                                                                                    |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-004`](#task-004-add-tap-line-and-yaml-block-parsers)                                                                                              |
| Files      | Create: [scripts/tasks-render.mjs](scripts/tasks-render.mjs); Create: [**tests**/scripts/tasks-render.test.mjs](__tests__/scripts/tasks-render.test.mjs) |
| Symbols    | [renderRustError](scripts/tasks-render.mjs), [clearSourceCache](scripts/tasks-render.mjs)                                                                |
| Outcome    | `renderRustError(error, cwd?)` returns a string containing `file:line:col`, a 3-line source context, and a `^^^` underline.                              |

- [ ] **Step 1: Write the failing test**

```js
// __tests__/scripts/tasks-render.test.mjs
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'node:test';

import { clearSourceCache, renderRustError } from '../../scripts/tasks-render.mjs';

test('renderRustError includes file:line:col header', () => {
  const err = {
    file: 'src/foo.ts',
    line: 2,
    col: 7,
    endCol: 10,
    rule: 'no-unused-vars',
    severity: 'error',
    message: "'x' is unused",
  };
  const out = renderRustError(err);
  assert.match(out, /src\/foo\.ts:2:7/);
  assert.match(out, /no-unused-vars/);
  assert.match(out, /\^\^\^/);
});

test('renderRustError shows 3-line source context when file exists', () => {
  const tmp = join(tmpdir(), `render-test-${Date.now()}.ts`);
  writeFileSync(tmp, 'const a = 1;\nconst b = 2;\nreturn b;\n', 'utf8');
  clearSourceCache();
  const err = {
    file: tmp,
    line: 2,
    col: 7,
    endCol: 14,
    rule: 'no-unused-vars',
    severity: 'error',
    message: 'unused',
  };
  const out = renderRustError(err, '');
  assert.match(out, /const a = 1/); // line before
  assert.match(out, /const b = 2/); // error line
  assert.match(out, /return b/); // line after
  unlinkSync(tmp);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test __tests__/scripts/tasks-render.test.mjs
```

Expected: FAIL with `Cannot find module '../../scripts/tasks-render.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

```js
// scripts/tasks-render.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const R = '\x1b[0m';

const sourceCache = new Map();

export function clearSourceCache() {
  sourceCache.clear();
}

function getLines(filePath) {
  if (!sourceCache.has(filePath)) {
    try {
      sourceCache.set(filePath, readFileSync(filePath, 'utf8').split('\n'));
    } catch {
      sourceCache.set(filePath, []);
    }
  }
  return sourceCache.get(filePath);
}

export function renderRustError(error, cwd = process.cwd()) {
  const { file, line, col, endCol, rule, severity, message } = error;
  const color = severity === 'warning' ? YELLOW : RED;
  const out = [];
  out.push(`${color}${severity}[${rule}]${R}  ${message}`);
  out.push(`  ${DIM}-->${R} ${file}:${line}:${col}`);
  const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
  const src = getLines(absPath);
  const gutterW = String(line + 1).length;
  const pad = ' '.repeat(gutterW);
  out.push(`${DIM}${pad} |${R}`);
  for (const n of [line - 1, line, line + 1]) {
    if (n < 1 || n > src.length) continue;
    const srcLine = src[n - 1] ?? '';
    const g = String(n).padStart(gutterW);
    if (n === line) {
      out.push(`${BOLD}${g}${R} ${DIM}│${R} ${srcLine}`);
      const len = Math.max(3, (endCol ?? col + 3) - col);
      out.push(
        `${DIM}${pad} │${R} ${' '.repeat(col - 1)}${color}${'^^^^^^^^^^^'.slice(0, len)}${R}`,
      );
    } else {
      out.push(`${DIM}${g} │ ${srcLine}${R}`);
    }
  }
  return out.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test __tests__/scripts/tasks-render.test.mjs
```

Expected: PASS — both subtests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks-render.mjs __tests__/scripts/tasks-render.test.mjs
git commit -m "feat(tasks): add Rust-style error renderer with source cache"
```

---

#### TASK-006: Add test failure card and LLM block emitter

| Field      | Value                                                                                                                                                               |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | [`TASK-005`](#task-005-create-rust-style-error-renderer)                                                                                                            |
| Files      | Modify: [scripts/tasks-render.mjs](scripts/tasks-render.mjs); Modify: [**tests**/scripts/tasks-render.test.mjs](__tests__/scripts/tasks-render.test.mjs)            |
| Symbols    | [renderTestFailureCard](scripts/tasks-render.mjs), [emitLlmBlock](scripts/tasks-render.mjs)                                                                         |
| Outcome    | `renderTestFailureCard(failure)` returns a string with test name, file, assertion diff, and stack frame. `emitLlmBlock(data)` writes a fenced JSON block to stdout. |

- [ ] **Step 1: Write the failing test**

Append to [**tests**/scripts/tasks-render.test.mjs](__tests__/scripts/tasks-render.test.mjs):

````js
import {
  clearSourceCache,
  emitLlmBlock,
  renderRustError,
  renderTestFailureCard,
} from '../../scripts/tasks-render.mjs';

test('renderTestFailureCard includes test name, diff, and frame', () => {
  const failure = {
    name: 'sanitizeHistoryParts › strips thought-only parts',
    file: 'src/__tests__/sessions.test.ts',
    expected: '1',
    actual: '2',
    frame: 'src/__tests__/sessions.test.ts:88:5',
  };
  const out = renderTestFailureCard(failure);
  assert.match(out, /sanitizeHistoryParts/);
  assert.match(out, /sessions\.test\.ts/);
  assert.match(out, /Expected/);
  assert.match(out, /Received/);
  assert.match(out, /88:5/);
});

test('renderTestFailureCard shows error message when no diff', () => {
  const failure = {
    name: 'foo',
    file: 'bar.ts',
    errorMessage: 'SyntaxError: unexpected token',
    frame: null,
  };
  const out = renderTestFailureCard(failure);
  assert.match(out, /SyntaxError/);
});

test('emitLlmBlock writes fenced JSON to stdout', (t) => {
  const written = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    written.push(s);
    return true;
  };
  emitLlmBlock({ failed_task: 'lint', status: 'failed', total_errors: 1, errors: [] });
  process.stdout.write = orig;
  const output = written.join('');
  assert.match(output, /## LLM CONTEXT/);
  assert.match(output, /"failed_task": "lint"/);
  assert.match(output, /```json/);
});
````

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test __tests__/scripts/tasks-render.test.mjs
```

Expected: FAIL with `renderTestFailureCard is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to [scripts/tasks-render.mjs](scripts/tasks-render.mjs):

```js
const GREEN = '\x1b[32m';

export function renderTestFailureCard(failure) {
  const { name, file, expected, actual, errorMessage, frame } = failure;
  const out = [];
  out.push(`${RED}FAIL${R}  ${DIM}${file}${R}`);
  out.push(`  ${RED}✗${R}  ${name}`);
  out.push('');
  if (expected !== undefined && actual !== undefined) {
    out.push(`     ${DIM}AssertionError:${R}`);
    out.push(`     ${RED}- Expected   ${expected}${R}`);
    out.push(`     ${GREEN}+ Received   ${actual}${R}`);
  } else if (errorMessage) {
    out.push(`     ${RED}${errorMessage}${R}`);
  }
  if (frame) {
    out.push('');
    out.push(`     ${DIM}at ${frame}${R}`);
  }
  return out.join('\n');
}

export function emitLlmBlock(data) {
  const HR = '─'.repeat(53);
  process.stdout.write(
    `\n${HR}\n## LLM CONTEXT\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n${HR}\n\n`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test __tests__/scripts/tasks-render.test.mjs
```

Expected: PASS — all 5 subtests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks-render.mjs __tests__/scripts/tasks-render.test.mjs
git commit -m "feat(tasks): add test failure card renderer and LLM block emitter"
```

---

### PHASE-003: History module

**Goal:** `scripts/tasks-history.mjs` loads and saves per-test durations and computes the adaptive silence timeout.

|                     Task                      | Action                        |                             Depends on                              | Files                                                                                                                                        | Validate                                               |
| :-------------------------------------------: | :---------------------------- | :-----------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| [`TASK-007`](#task-007-create-history-module) | Create history module + tests | [`TASK-006`](#task-006-add-test-failure-card-and-llm-block-emitter) | [scripts/tasks-history.mjs](scripts/tasks-history.mjs), [**tests**/scripts/tasks-history.test.mjs](__tests__/scripts/tasks-history.test.mjs) | `node --test __tests__/scripts/tasks-history.test.mjs` |

#### TASK-007: Create history module

| Field      | Value                                                                                                                                                                                                  |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-006`](#task-006-add-test-failure-card-and-llm-block-emitter)                                                                                                                                    |
| Files      | Create: [scripts/tasks-history.mjs](scripts/tasks-history.mjs); Create: [**tests**/scripts/tasks-history.test.mjs](__tests__/scripts/tasks-history.test.mjs)                                           |
| Symbols    | [loadHistory](scripts/tasks-history.mjs), [saveHistory](scripts/tasks-history.mjs), [getSilenceTimeout](scripts/tasks-history.mjs)                                                                     |
| Outcome    | `loadHistory()` returns `{test_durations:{}}` when `.tasks-history.json` is absent. `saveHistory()` appends durations and trims to 5. `getSilenceTimeout()` returns `max(1000, 10 × maxHistoricalMs)`. |

- [ ] **Step 1: Write the failing test**

```js
// __tests__/scripts/tasks-history.test.mjs
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { getSilenceTimeout, loadHistory, saveHistory } from '../../scripts/tasks-history.mjs';

const TMP_HISTORY = '.tasks-history-test-tmp.json';

test('loadHistory returns empty structure when file is absent', () => {
  if (existsSync(TMP_HISTORY)) unlinkSync(TMP_HISTORY);
  const h = loadHistory(TMP_HISTORY);
  assert.deepEqual(h, { test_durations: {} });
});

test('saveHistory appends durations and trims to MAX_DURATIONS', () => {
  if (existsSync(TMP_HISTORY)) unlinkSync(TMP_HISTORY);
  const h = { test_durations: {} };
  const durations = new Map([['my test', 1.5]]);
  // push 6 entries; only last 5 must survive
  for (let i = 0; i < 6; i++) saveHistory(h, durations, TMP_HISTORY);
  const saved = loadHistory(TMP_HISTORY);
  assert.equal(saved.test_durations['my test'].length, 5);
  unlinkSync(TMP_HISTORY);
});

test('getSilenceTimeout returns 1000 when history is empty', () => {
  assert.equal(getSilenceTimeout({ test_durations: {} }), 1000);
});

test('getSilenceTimeout returns 10x the max historical duration when above 100ms floor', () => {
  const h = { test_durations: { 'slow test': [80, 90, 100] } };
  assert.equal(getSilenceTimeout(h), 1000); // 10*100 = 1000, equals floor
});

test('getSilenceTimeout exceeds floor when max duration is large', () => {
  const h = { test_durations: { 'slow test': [200] } };
  assert.equal(getSilenceTimeout(h), 2000); // 10*200 = 2000 > 1000
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test __tests__/scripts/tasks-history.test.mjs
```

Expected: FAIL with `Cannot find module '../../scripts/tasks-history.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

```js
// scripts/tasks-history.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_DURATIONS = 5;

export function loadHistory(file = '.tasks-history.json') {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { test_durations: {} };
  }
}

export function saveHistory(history, newDurations, file = '.tasks-history.json') {
  for (const [name, ms] of newDurations) {
    const arr = history.test_durations[name] ?? [];
    arr.push(ms);
    history.test_durations[name] = arr.slice(-MAX_DURATIONS);
  }
  writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

export function getSilenceTimeout(history) {
  const all = Object.values(history.test_durations).flat();
  if (!all.length) return 1000;
  return Math.max(1000, 10 * Math.max(...all));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test __tests__/scripts/tasks-history.test.mjs
```

Expected: PASS — all 5 subtests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tasks-history.mjs __tests__/scripts/tasks-history.test.mjs
git commit -m "feat(tasks): add history module for per-test duration tracking and adaptive silence timeout"
```

---

### PHASE-004: Wire into tasks.mjs

**Goal:** `tasks.mjs` uses the three new modules. Lint, type-check, and test each use their custom runner; all other tasks keep `execSync`. The LLM block is emitted on any failure or timeout. The summary line includes error/warning counts.

|                                      Task                                      | Action                                     |                                   Depends on                                   | Files                                  | Validate                  |
| :----------------------------------------------------------------------------: | :----------------------------------------- | :----------------------------------------------------------------------------: | :------------------------------------- | :------------------------ |
|           [`TASK-008`](#task-008-refactor-loop-and-wire-lint-runner)           | Refactor loop + wire lint runner           |                 [`TASK-007`](#task-007-create-history-module)                  | [scripts/tasks.mjs](scripts/tasks.mjs) | `npm run tasks -- --fast` |
|                 [`TASK-009`](#task-009-wire-type-check-runner)                 | Wire type-check runner                     |           [`TASK-008`](#task-008-refactor-loop-and-wire-lint-runner)           | [scripts/tasks.mjs](scripts/tasks.mjs) | `npm run tasks -- --fast` |
| [`TASK-010`](#task-010-wire-test-runner-with-tap-streaming-and-hang-detection) | Wire test runner with TAP + hang detection |                 [`TASK-009`](#task-009-wire-type-check-runner)                 | [scripts/tasks.mjs](scripts/tasks.mjs) | `npm run tasks`           |
|  [`TASK-011`](#task-011-add-error-counts-to-summary-and-llm-block-on-failure)  | Add error counts + LLM block on failure    | [`TASK-010`](#task-010-wire-test-runner-with-tap-streaming-and-hang-detection) | [scripts/tasks.mjs](scripts/tasks.mjs) | `npm run tasks`           |

#### TASK-008: Refactor loop and wire lint runner

| Field      | Value                                                                                                                                                                                                                                                                                     |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-007`](#task-007-create-history-module)                                                                                                                                                                                                                                             |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                                                                                                            |
| Symbols    | [tasks](scripts/tasks.mjs#L26), [fix](scripts/tasks.mjs#L22), [failed](scripts/tasks.mjs#L68)                                                                                                                                                                                             |
| Outcome    | The task loop supports `runner` async functions. The `lint` task uses `runLint()` which invokes ESLint with `--format=json` (non-fix mode) and renders Rust-style blocks on failure. `--fix` mode is unchanged. TDD skipped — integration change verified by running the script manually. |

- [ ] **Step 1: Apply change** — replace the contents of [scripts/tasks.mjs](scripts/tasks.mjs) with the following:

```js
#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--fast]
//   --fix   run lint:fix instead of lint
//   --fast  skip the test suite (static checks only)
import { execSync } from 'node:child_process';
import process from 'node:process';

import { parseEslintJson } from './tasks-parse.mjs';
import { clearSourceCache, emitLlmBlock, renderRustError } from './tasks-render.mjs';

const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const PASS = `${GREEN}✓${R}`;
const FAIL = `${RED}✗${R}`;
const RUN = `${CYAN}◆${R}`;
const SKIP = `${YELLOW}–${R}`;
const HANG = `${YELLOW}⏱${R}`;

const args = new Set(process.argv.slice(2));
const fix = args.has('--fix');
const fast = args.has('--fast');

async function runLint() {
  if (fix) {
    try {
      execSync('npm run lint:fix', { encoding: 'utf8', stdio: 'pipe' });
      return { ok: true };
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
    }
  }
  try {
    execSync('npx eslint . --max-warnings=0 --format=json', { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    const e = /** @type {any} */ (err);
    try {
      const errors = parseEslintJson(e.stdout ?? '[]', process.cwd());
      const errCount = errors.filter((x) => x.severity === 'error').length;
      const warnCount = errors.filter((x) => x.severity === 'warning').length;
      return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
    } catch {
      return { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
    }
  }
}

/** @type {Array<{ label: string; cmd?: string; runner?: () => Promise<any>; skip?: boolean }>} */
const tasks = [
  { label: 'format', cmd: 'npm run format' },
  { label: 'lint', runner: runLint },
  { label: 'type-check', cmd: fix ? 'npm run type-check' : 'npm run type-check' }, // replaced in TASK-009
  { label: 'build', cmd: 'npm run build' },
  { label: 'knip', cmd: 'npm run knip' },
  { label: 'test', cmd: 'npm run test', skip: fast }, // replaced in TASK-010
];

const COL = Math.max(...tasks.map((t) => t.label.length)) + 2;

function elapsed(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function printHeader() {
  const mode = fix ? `${YELLOW}--fix${R}` : fast ? `${YELLOW}--fast${R}` : '';
  const suffix = mode ? `  ${mode}` : '';
  process.stdout.write(`\n  ${BOLD}gemini-assistant${R}  ${DIM}checks${R}${suffix}\n\n`);
}

function printTask(icon, label, time, skipped, counts) {
  const col = label.padEnd(COL);
  let right = skipped ? `${DIM}skipped${R}` : `${DIM}${time}${R}`;
  if (counts) {
    const parts = [];
    if (counts.errors)
      parts.push(`${RED}${counts.errors} error${counts.errors !== 1 ? 's' : ''}${R}`);
    if (counts.warnings)
      parts.push(`${YELLOW}${counts.warnings} warning${counts.warnings !== 1 ? 's' : ''}${R}`);
    if (parts.length) right = `${DIM}${time}${R}  ${parts.join(' · ')}`;
  }
  process.stdout.write(`\r  ${icon}  ${BOLD}${col}${R}  ${right}\n`);
}

function printOutput(raw) {
  if (!raw) return;
  const lines = raw.trim().split('\n');
  const shown = lines.slice(0, 40);
  process.stdout.write('\n');
  for (const line of shown) process.stdout.write(`      ${DIM}${line}${R}\n`);
  if (lines.length > 40)
    process.stdout.write(`      ${DIM}… ${lines.length - 40} more lines${R}\n`);
  process.stdout.write('\n');
}

printHeader();

let passed = 0;
let failed = 0;
let skipped = 0;
const wallStart = Date.now();
let llmPayload = null;

for (const task of tasks) {
  if (task.skip) {
    printTask(SKIP, task.label, '', true, null);
    skipped++;
    continue;
  }

  process.stdout.write(`  ${RUN}  ${BOLD}${task.label.padEnd(COL)}${R}`);
  clearSourceCache();

  const start = Date.now();
  let result;

  if (task.runner) {
    result = await task.runner();
  } else {
    try {
      execSync(task.cmd, { encoding: 'utf8', stdio: 'pipe' });
      result = { ok: true };
    } catch (err) {
      const e = /** @type {any} */ (err);
      result = { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
    }
  }

  const ms = Date.now() - start;

  if (!result.ok) {
    const counts = result.counts ?? null;
    printTask(result.timeout ? HANG : FAIL, task.label, elapsed(ms), false, counts);
    failed++;

    if (result.errors?.length) {
      process.stdout.write('\n');
      for (const err of result.errors) {
        process.stdout.write(renderRustError(err) + '\n\n');
      }
      llmPayload = {
        failed_task: task.label,
        status: 'failed',
        total_errors: counts?.errors ?? 0,
        total_warnings: counts?.warnings ?? 0,
        errors: result.errors.map(({ file, line, col, rule, severity, message }) => ({
          file,
          line,
          col,
          rule,
          severity,
          message,
        })),
      };
    } else if (result.rawOutput) {
      printOutput(result.rawOutput);
      llmPayload = {
        failed_task: task.label,
        status: 'failed',
        raw_output_preview: result.rawOutput.slice(0, 500),
      };
    }
    break;
  }

  printTask(PASS, task.label, elapsed(ms), false, null);
  passed++;
}

if (llmPayload) emitLlmBlock(llmPayload);

const total = tasks.length - skipped;
const wall = elapsed(Date.now() - wallStart);
process.stdout.write('\n');

if (failed === 0) {
  const label = fast
    ? `${passed}/${total} passed  ${DIM}(test skipped)${R}`
    : `${passed}/${total} passed`;
  process.stdout.write(`  ${GREEN}${BOLD}✓${R}  ${label}  ${DIM}${wall}${R}\n\n`);
} else {
  process.stdout.write(
    `  ${RED}${BOLD}✗${R}  ${passed}/${total} passed  ${RED}${failed} failed${R}  ${DIM}${wall}${R}\n\n`,
  );
  process.exit(1);
}
```

- [ ] **Step 2: Verify**

```bash
npm run tasks -- --fast
```

Expected: format, lint, type-check, build, knip pass; test skipped. If lint is clean the script exits 0 with the normal summary line.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat(tasks): refactor loop to support async runners, wire lint with ESLint JSON renderer"
```

---

#### TASK-009: Wire type-check runner

| Field      | Value                                                                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-008`](#task-008-refactor-loop-and-wire-lint-runner)                                                                                                                                                |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                            |
| Symbols    | [tasks](scripts/tasks.mjs#L26), [parseTscOutput](scripts/tasks-parse.mjs)                                                                                                                                 |
| Outcome    | The `type-check` task uses `runTypeCheck()` which invokes `tsc --pretty false`, parses output, and renders Rust-style blocks on failure. TDD skipped — integration change verified by running the script. |

- [ ] **Step 1: Apply change**

Add the import at the top of [scripts/tasks.mjs](scripts/tasks.mjs) alongside the existing parse import:

```js
import { parseEslintJson, parseTscOutput } from './tasks-parse.mjs';
```

Add `runTypeCheck` after `runLint`:

```js
function runTypeCheck() {
  try {
    execSync('npx tsc -p tsconfig.json --noEmit --pretty false', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (err) {
    const e = /** @type {any} */ (err);
    const text = [e.stdout, e.stderr].filter(Boolean).join('\n');
    const errors = parseTscOutput(text);
    if (!errors.length) return { ok: false, rawOutput: text };
    const errCount = errors.filter((x) => x.severity === 'error').length;
    const warnCount = errors.filter((x) => x.severity === 'warning').length;
    return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
  }
}
```

Replace the `type-check` entry in the tasks array:

```js
{ label: 'type-check', runner: runTypeCheck },
```

- [ ] **Step 2: Verify**

```bash
npm run tasks -- --fast
```

Expected: all static tasks pass (or fail with Rust-style output if there are real type errors); test skipped. Exit 0 on a clean codebase.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat(tasks): wire tsc runner with Rust-style type error rendering"
```

---

#### TASK-010: Wire test runner with TAP streaming and hang detection

| Field      | Value                                                                                                                                                                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-009`](#task-009-wire-type-check-runner)                                                                                                                                                                                                                                                            |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                                                                                                                            |
| Symbols    | [tasks](scripts/tasks.mjs#L26), [parseTapLine](scripts/tasks-parse.mjs), [parseYamlBlock](scripts/tasks-parse.mjs), [loadHistory](scripts/tasks-history.mjs), [saveHistory](scripts/tasks-history.mjs), [getSilenceTimeout](scripts/tasks-history.mjs), [renderTestFailureCard](scripts/tasks-render.mjs) |
| Outcome    | The `test` task uses `runTest()` which spawns Node with `--test-reporter=tap`, streams TAP output, detects silence longer than the adaptive threshold, kills the process, and records per-test durations on a clean pass.                                                                                 |

- [ ] **Step 1: Apply change**

Add imports at the top of [scripts/tasks.mjs](scripts/tasks.mjs):

```js
import { spawn } from 'node:child_process';

import { getSilenceTimeout, loadHistory, saveHistory } from './tasks-history.mjs';
import { parseTapLine, parseYamlBlock } from './tasks-parse.mjs';
import {
  clearSourceCache,
  emitLlmBlock,
  renderRustError,
  renderTestFailureCard,
} from './tasks-render.mjs';
```

Add `runTest` after `runTypeCheck`:

```js
function runTest() {
  return new Promise((resolve) => {
    const history = loadHistory();
    const silenceMs = getSilenceTimeout(history);

    const child = spawn(
      'node',
      ['--import', 'tsx/esm', '--env-file=.env', '--test', '--no-warnings', '--test-reporter=tap'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    /** @type {{ name: string; duration: number } | null} */
    let lastCompleted = null;
    /** @type {Map<string, number>} */
    const testDurations = new Map();
    /** @type {Array<{ name: string; file: string; expected?: string; actual?: string; errorMessage?: string; frame?: string }>} */
    const failures = [];
    let currentFailName = /** @type {string | null} */ (null);
    let inYaml = false;
    /** @type {string[]} */
    const yamlLines = [];
    let buf = '';
    let silenceTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

    function resetTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        child.kill('SIGTERM');
        const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
        resolve({
          ok: false,
          timeout: true,
          silenceMs,
          lastCompletedTest: lastCompleted,
          suiteMaxHistoricalMs: maxHistorical,
        });
      }, silenceMs);
    }

    resetTimer();

    child.stdout.on('data', (chunk) => {
      resetTimer();
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const ev = parseTapLine(line);
        if (ev.type === 'ok') {
          lastCompleted = { name: ev.name, duration: ev.duration };
          testDurations.set(ev.name, ev.duration);
          inYaml = false;
          yamlLines.length = 0;
          currentFailName = null;
        } else if (ev.type === 'not_ok') {
          currentFailName = ev.name;
          inYaml = false;
          yamlLines.length = 0;
        } else if (ev.type === 'yaml_start') {
          inYaml = true;
          yamlLines.length = 0;
        } else if (ev.type === 'yaml_end' && inYaml) {
          inYaml = false;
          const yaml = parseYamlBlock([...yamlLines]);
          if (currentFailName) {
            failures.push({
              name: currentFailName,
              file: yaml.at ? yaml.at.replace(/:\d+:\d+$/, '') : '',
              expected: yaml.expected,
              actual: yaml.actual,
              errorMessage: yaml.error,
              frame: yaml.at ?? null,
            });
          }
          yamlLines.length = 0;
          currentFailName = null;
        } else if (inYaml) {
          yamlLines.push(line);
        }
      }
    });

    child.on('close', (code) => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (failures.length || code !== 0) {
        resolve({ ok: false, failures, testDurations });
      } else {
        saveHistory(history, testDurations);
        resolve({ ok: true, testDurations });
      }
    });
  });
}
```

Replace the `test` entry in the tasks array:

```js
{ label: 'test', runner: runTest, skip: fast },
```

- [ ] **Step 2: Verify**

```bash
npm run tasks
```

Expected: all tasks pass; after a clean run `.tasks-history.json` is created in the project root with per-test duration entries.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat(tasks): wire test runner with TAP streaming, adaptive silence-timer hang detection, and history recording"
```

---

#### TASK-011: Add error counts to summary line and LLM block on failure and timeout

| Field      | Value                                                                                                                                                                                                                                                                                                                                                       |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-010`](#task-010-wire-test-runner-with-tap-streaming-and-hang-detection)                                                                                                                                                                                                                                                                              |
| Files      | Modify: [scripts/tasks.mjs](scripts/tasks.mjs)                                                                                                                                                                                                                                                                                                              |
| Symbols    | [emitLlmBlock](scripts/tasks-render.mjs), [renderTestFailureCard](scripts/tasks-render.mjs), [failed](scripts/tasks.mjs#L68)                                                                                                                                                                                                                                |
| Outcome    | On a test failure the LLM block contains `failures[]`. On a timeout the LLM block contains `status: "timeout"`, `silence_duration_ms`, `last_completed_test`, and `suite_max_historical_ms`. On lint/type-check failure the block already emits from TASK-008/009; this task adds the timeout and test-failure paths. TDD skipped — observable from output. |

- [ ] **Step 1: Apply change**

In the failure-handling section of the main loop in [scripts/tasks.mjs](scripts/tasks.mjs), extend the block that runs after `failed++` to handle timeout and test-failure `result` shapes:

```js
if (result.timeout) {
  process.stdout.write('\n');
  process.stdout.write(
    `  ${HANG}  ${BOLD}TIMED OUT${R} — no TAP output for ${elapsed(result.silenceMs)}\n\n`,
  );
  if (result.lastCompletedTest) {
    process.stdout.write(`  ${DIM}Last completed test:${R}\n`);
    process.stdout.write(`  ${GREEN}✔${R}  ${result.lastCompletedTest.name}\n\n`);
    process.stdout.write(
      `  ${DIM}→ The hang likely occurred in the next test after this one.\n` +
        `    Check for: unclosed handles, unresolved promises, missing mock teardown.${R}\n\n`,
    );
  }
  llmPayload = {
    failed_task: task.label,
    status: 'timeout',
    silence_duration_ms: result.silenceMs,
    last_completed_test: result.lastCompletedTest ?? null,
    suite_max_historical_ms: result.suiteMaxHistoricalMs ?? 0,
    hint: 'Process produced no TAP output for the silence threshold. The next test after last_completed_test is the likely culprit. Check for unclosed handles, unresolved promises, or missing mock teardown.',
  };
} else if (result.failures?.length) {
  process.stdout.write('\n');
  for (const f of result.failures) {
    process.stdout.write(renderTestFailureCard(f) + '\n\n');
  }
  llmPayload = {
    failed_task: task.label,
    status: 'failed',
    total_failures: result.failures.length,
    failures: result.failures.map(({ name, file, expected, actual, errorMessage, frame }) => ({
      name,
      file,
      ...(expected !== undefined ? { expected, received: actual } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(frame ? { at: frame } : {}),
    })),
  };
} else if (result.errors?.length) {
  // already handled in TASK-008/009 block above; this branch is a safety net
} else if (result.rawOutput) {
  printOutput(result.rawOutput);
  llmPayload = {
    failed_task: task.label,
    status: 'failed',
    raw_output_preview: result.rawOutput.slice(0, 500),
  };
}
```

Remove the old duplicated `if (result.errors?.length)` / `else if (result.rawOutput)` block that was left from TASK-008, consolidating everything into the new if/else-if chain above.

- [ ] **Step 2: Verify — test failure**

Temporarily break a test (e.g., change an assertion) and run:

```bash
npm run tasks
```

Expected: failure card renders with test name, diff, and stack frame. A fenced `## LLM CONTEXT` block appears at the bottom with `"status": "failed"` and a `failures[]` array.

- [ ] **Step 3: Verify — clean run**

Restore the broken test and run:

```bash
npm run tasks
```

Expected: all tasks pass, no LLM block, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/tasks.mjs
git commit -m "feat(tasks): add test failure cards and timeout LLM context blocks"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — All new unit tests pass

```bash
node --test __tests__/scripts/tasks-parse.test.mjs
node --test __tests__/scripts/tasks-render.test.mjs
node --test __tests__/scripts/tasks-history.test.mjs
```

Expected: PASS — all subtests green across all three files.

### [`VAL-002`](#5-testing--validation) — Full project test suite still passes

```bash
npm run test
```

Expected: PASS — existing test suite unaffected.

### [`VAL-003`](#5-testing--validation) — Static checks pass

```bash
npm run check:static
```

Expected: format, lint, type-check, build, knip all green.

### [`VAL-004`](#5-testing--validation) — tasks script exits 0 on a clean codebase

```bash
npm run tasks
```

Expected: all 6 tasks pass; `.tasks-history.json` created or updated; exit 0.

### [`VAL-005`](#5-testing--validation) — tasks script renders Rust-style output on a lint error

Introduce `const _x = 1;` in any `.ts` file (triggers `no-unused-vars`) then run:

```bash
npm run tasks -- --fast
```

Expected: lint fails with a Rust-style block showing `error[no-unused-vars]`, `-->`, 3-line source context, `^^^` underline, and a fenced `## LLM CONTEXT` JSON block. Revert the change.

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                                 |
| :--------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | A lint failure shows `error[rule]  message`, `-->  file:line:col`, a 3-line source context, and a `^^^` underline at the exact column.                                             |
| [`AC-002`](#6-acceptance-criteria) | A type-check failure shows the same Rust-style format as AC-001, using the `TSxxxx` code as the rule identifier.                                                                   |
| [`AC-003`](#6-acceptance-criteria) | A test failure shows a card: test name, file path, `- Expected / + Received`, and the first non-internal stack frame.                                                              |
| [`AC-004`](#6-acceptance-criteria) | A hanging test is killed after `max(1000ms, 10 × maxHistoricalMs)` of silence. The output names the last completed test and contains the suggestion to check for unclosed handles. |
| [`AC-005`](#6-acceptance-criteria) | Every failure or timeout produces a fenced `## LLM CONTEXT` JSON block at the end of output with `failed_task`, `status`, and structured error/failure/timeout data.               |
| [`AC-006`](#6-acceptance-criteria) | After a clean test pass, `.tasks-history.json` is updated with new per-test durations (max 5 per test name).                                                                       |
| [`AC-007`](#6-acceptance-criteria) | `--fix` and `--fast` flags continue to work as before.                                                                                                                             |
| [`AC-008`](#6-acceptance-criteria) | The full project test suite (`npm run test`) passes after all changes.                                                                                                             |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                |
| :---------------------------: | :--: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | ESLint may write partial or non-JSON to stdout on certain error conditions (e.g. config parse failure). The `try/catch` in `runLint` falls back to `rawOutput` in that case.                                          |
| [`RISK-002`](#7-risks--notes) | Risk | Node's TAP reporter format may vary between Node.js minor versions. The TAP parser targets the format emitted by Node ≥ 24; test against the actual runner output if subtests look mis-parsed.                        |
| [`RISK-003`](#7-risks--notes) | Risk | The first run has no history, so the silence timeout defaults to 1000 ms. If any legitimate test takes longer than 100 ms, the first run may trigger a false hang. After one clean pass the baseline self-calibrates. |
| [`NOTE-001`](#7-risks--notes) | Note | `.tasks-history.json` is written to the project root (same directory `npm run tasks` is invoked from). It must not be committed — verify `.gitignore` entry from TASK-001 is in place before the first run.           |
| [`NOTE-002`](#7-risks--notes) | Note | `clearSourceCache()` is called at the start of each task's runner to prevent stale file content from a previous task bleeding into the renderer.                                                                      |
| [`NOTE-003`](#7-risks--notes) | Note | The `type-check` runner uses `npx tsc` so it picks up the local TypeScript version. If the project ever moves to a wrapper script, update `runTypeCheck` to match.                                                    |
