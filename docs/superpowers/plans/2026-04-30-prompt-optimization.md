---
goal: Rewrite all prompt strings in gemini-assistant to be concise, directive-sentence, and noise-free
version: 1
date_created: 2026-04-30
status: Planned
plan_type: refactor
component: prompt-optimization
execution: subagent-driven
---

# Implementation Plan: Prompt Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Rewrite every system instruction and prompt string across 6 source files to use directive sentences — full sentences with redundant words stripped — eliminating noise that dilutes Gemini's response quality.

**Architecture:** Each task targets one builder function (or a tightly related pair). Shared fragments (`CITE_CODE`, `CITE_WEB`, `REPORT_SKELETON`) are extracted as module-level constants in `model-prompts.ts` first, then referenced by subsequent builders. Tests are updated before source changes (TDD) wherever an exact-string assertion exists that will break.

**Tech Stack:** TypeScript (ESM), Node.js built-in test runner (`node --import tsx/esm --test`), `node scripts/tasks.mjs` for the full check pipeline.

---

## 1. Goal

Replace verbose, redundant prompt strings with concise directive sentences throughout the `gemini-assistant` MCP server. The change targets only string content inside builder functions — no API surface, schema, or behavioural logic changes. Success is observable when `node scripts/tasks.mjs` passes with no errors and every changed string no longer contains the removed phrases identified in section 3.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                            |
| :---------------------------------------: | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Every system instruction and prompt string must use directive sentences: full sentences with redundant words stripped.                                               |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Shared repeated fragments (`CITE_CODE`, `CITE_WEB`, `REPORT_SKELETON`) must be extracted as named constants in [src/lib/model-prompts.ts](src/lib/model-prompts.ts). |
| [`REQ-003`](#2-requirements--constraints) | Requirement | No API surface, tool registration, schema, or session logic may change.                                                                                              |
| [`CON-001`](#2-requirements--constraints) | Constraint  | `cacheText` strings are NOT changed — only `systemInstruction` and `promptText`/`promptParts` content.                                                               |
| [`CON-002`](#2-requirements--constraints) | Constraint  | Tests are updated before the source change (TDD) for every task that has a breaking exact-string assertion.                                                          |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [joinNonEmpty](src/lib/model-prompts.ts#L103) for combining instruction fragments — already used throughout the file.                                         |

## 3. Current Context

### File structure

| File                                                                               | Status | Responsibility                                             |
| :--------------------------------------------------------------------------------- | :----- | :--------------------------------------------------------- |
| [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                               | Modify | All shared prompt builder functions + new shared constants |
| [src/client.ts](src/client.ts)                                                     | Modify | `DEFAULT_SYSTEM_INSTRUCTION` global base instruction       |
| [src/tools/chat.ts](src/tools/chat.ts)                                             | Modify | `buildReducedRepairPrompt` inline strings                  |
| [src/tools/research.ts](src/tools/research.ts)                                     | Modify | Deep-research planning turn prompt string                  |
| [src/prompts.ts](src/prompts.ts)                                                   | Modify | MCP prompt builder label strings                           |
| [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)         | Modify | Exact-string assertions for prompt builders                |
| [**tests**/lib/workspace-context.test.ts](__tests__/lib/workspace-context.test.ts) | Modify | `DEFAULT_SYSTEM_INSTRUCTION` substring assertion           |
| [**tests**/prompts.test.ts](__tests__/prompts.test.ts)                             | Modify | `buildReviewPrompt` regex assertion                        |

### Relevant symbols

| Symbol                                                              | Why it matters                                                |
| :------------------------------------------------------------------ | :------------------------------------------------------------ |
| [DEFAULT_SYSTEM_INSTRUCTION](src/client.ts#L49)                     | Global base instruction prepended to all tool calls           |
| [buildFunctionCallingInstructionText](src/lib/model-prompts.ts#L43) | Generates function-calling mode instructions                  |
| [appendFunctionCallingInstruction](src/lib/model-prompts.ts#L107)   | Appends function-calling text to existing system instructions |
| [buildGroundedAnswerPrompt](src/lib/model-prompts.ts#L119)          | Prompt for grounded answers with source retrieval             |
| [buildFileAnalysisPrompt](src/lib/model-prompts.ts#L168)            | Prompt for single/multi/URL file analysis                     |
| [buildDiffReviewPrompt](src/lib/model-prompts.ts#L227)              | Prompt for diff review and file comparison                    |
| [buildErrorDiagnosisPrompt](src/lib/model-prompts.ts#L276)          | Prompt for error diagnosis with code context                  |
| [buildDiagramGenerationPrompt](src/lib/model-prompts.ts#L318)       | Prompt for Mermaid/PlantUML diagram generation                |
| [buildAgenticResearchPrompt](src/lib/model-prompts.ts#L342)         | Prompt for agentic research with capability awareness         |
| [buildReducedRepairPrompt](src/tools/chat.ts#L203)                  | JSON repair prompt for schema-constrained chat                |
| [buildDiscoverPrompt](src/prompts.ts#L92)                           | MCP discover prompt builder                                   |
| [buildResearchPrompt](src/prompts.ts#L103)                          | MCP research prompt builder                                   |
| [buildReviewPrompt](src/prompts.ts#L115)                            | MCP review prompt builder                                     |

### Existing commands

```bash
# Full check suite (format → lint/type-check/knip → test/build)
node scripts/tasks.mjs

# Quick static-only check (skip test + build)
node scripts/tasks.mjs --quick

# Single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

### Current behavior

Prompt strings contain redundant phrases ("Use a Markdown table", "You must call one or more of these declared functions when needed to complete the request", "After issuing a declared function call, stop and wait for the client to return the function response", "Gemini may emit server-side built-in tool invocation traces for supported tools"), repeated labels ("Research goal:", "Preferred mode:", "User goal:"), and over-explained section headers ("## Answer — response to the goal."). These phrases do not add information the model cannot infer and dilute the signal in the instructions.

## 4. Implementation Phases

### PHASE-001: Extract shared constants ([src/lib/model-prompts.ts](src/lib/model-prompts.ts))

**Goal:** Add `CITE_CODE`, `CITE_WEB`, and `REPORT_SKELETON` as module-level constants before any builder is changed.

|                                   Task                                   | Action               | Depends on | Files                                                | Validate                         |
| :----------------------------------------------------------------------: | :------------------- | :--------: | :--------------------------------------------------- | :------------------------------- |
| [`TASK-001`](#task-001-add-cite_code-cite_web-report_skeleton-constants) | Add shared constants |    none    | [src/lib/model-prompts.ts](src/lib/model-prompts.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-001: Add CITE_CODE, CITE_WEB, REPORT_SKELETON constants

| Field      | Value                                                                                                                                       |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | none                                                                                                                                        |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                                                                                |
| Symbols    | [joinNonEmpty](src/lib/model-prompts.ts#L103)                                                                                               |
| Outcome    | Three named constants exist in the file; `node scripts/tasks.mjs --quick` passes. TDD skipped: pure constant additions with no direct test. |

- [ ] **Step 1: Apply change** — add three constants after the `escapeInstructionBlock` function (after line 41) in [src/lib/model-prompts.ts](src/lib/model-prompts.ts):

```ts
// src/lib/model-prompts.ts — add after escapeInstructionBlock function
const CITE_CODE = 'Cite as `path:line`.';
const CITE_WEB = 'Cite sources as [title](url).';
const REPORT_SKELETON =
  '## Summary — 2–4 sentence overview.\n' +
  '## Findings — body using ### sub-sections or tables.\n' +
  '## Sources — cited URLs as a compact reference list.';
```

- [ ] **Step 3: Verify type-check passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS (TypeScript does not enforce `noUnusedLocals`; constants are used in subsequent tasks within the same file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts
git commit -m "refactor: extract CITE_CODE, CITE_WEB, REPORT_SKELETON constants"
```

---

### PHASE-002: Function-calling instructions ([src/lib/model-prompts.ts](src/lib/model-prompts.ts))

**Goal:** Rewrite `buildFunctionCallingInstructionText` strings and update all exact-string test assertions.

|                                Task                                 | Action                                       | Depends on | Files                                                                                                                            | Validate                                                                                         |
| :-----------------------------------------------------------------: | :------------------------------------------- | :--------: | :------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| [`TASK-002`](#task-002-rewrite-buildfunctioncallinginstructiontext) | Rewrite function-calling instruction strings |    none    | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |

#### TASK-002: Rewrite buildFunctionCallingInstructionText

| Field      | Value                                                                                                                                          |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                           |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Test: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) |
| Symbols    | [buildFunctionCallingInstructionText](src/lib/model-prompts.ts#L43), [appendFunctionCallingInstruction](src/lib/model-prompts.ts#L107)         |
| Outcome    | All four exact-string `appendFunctionCallingInstruction` assertions pass with the new concise strings.                                         |

- [ ] **Step 1: Write the failing tests** — replace the exact-string assertions in the two test cases in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts):

```ts
// __tests__/lib/model-prompts.test.ts
// Replace the 'builds mode-aware function-calling instructions' test body:
it('builds mode-aware function-calling instructions', () => {
  assert.strictEqual(
    appendFunctionCallingInstruction('Base', {
      declaredNames: ['lookup', 'search'],
      mode: 'AUTO',
    }),
    [
      'Base',
      'Available declared functions: lookup, search. Call them only when the request requires it.',
      'After a function call, wait for the client response. Do not invent results.',
    ].join('\n\n'),
  );

  assert.strictEqual(
    appendFunctionCallingInstruction('Base', {
      declaredNames: ['lookup'],
      mode: 'ANY',
    }),
    [
      'Base',
      'Call one or more of these functions as needed: lookup. Parallel calls allowed.',
      'After a function call, wait for the client response. Do not invent results.',
    ].join('\n\n'),
  );

  assert.strictEqual(
    appendFunctionCallingInstruction('Base', {
      declaredNames: ['lookup'],
      mode: 'VALIDATED',
      serverSideToolInvocations: true,
    }),
    [
      'Base',
      'Available declared functions: lookup. Arguments are schema-constrained; the MCP client validates before executing side effects.',
      'Server-side tool traces may also appear. Custom functions are executed by the MCP client. Do not fabricate results.',
    ].join('\n\n'),
  );
});

// Replace the 'uses distinct server-side invocation wording' test body:
it('uses distinct server-side invocation wording for built-ins versus declared functions', () => {
  assert.strictEqual(
    appendFunctionCallingInstruction('Base', {
      declaredNames: ['lookup'],
      mode: 'AUTO',
      serverSideToolInvocations: true,
    }),
    [
      'Base',
      'Available declared functions: lookup. Call them only when the request requires it.',
      'Server-side tool traces may also appear. Custom functions are executed by the MCP client. Do not fabricate results.',
    ].join('\n\n'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: FAIL — the two rewritten tests fail because the source still produces the old verbose strings.

- [ ] **Step 3: Rewrite `buildFunctionCallingInstructionText`** in [src/lib/model-prompts.ts](src/lib/model-prompts.ts) — replace the body of the function (lines 43–75):

```ts
// src/lib/model-prompts.ts — replace buildFunctionCallingInstructionText body
export function buildFunctionCallingInstructionText(
  opts: FunctionCallingInstructionOptions,
): string | undefined {
  const declaredNames = opts.declaredNames?.filter((name) => name.trim().length > 0) ?? [];
  const hasDeclaredFunctions = declaredNames.length > 0;
  const hasBuiltInTraces = opts.serverSideToolInvocations === true;

  if (opts.mode === undefined || opts.mode === 'NONE') {
    return hasBuiltInTraces
      ? 'Server-side tool traces may appear. Treat them as runtime events, not evidence.'
      : undefined;
  }

  if (!hasDeclaredFunctions) {
    return hasBuiltInTraces
      ? 'Server-side tool traces may appear. No declared client functions are available this turn.'
      : undefined;
  }

  const names = declaredNames.join(', ');
  const modeInstruction =
    opts.mode === 'ANY'
      ? `Call one or more of these functions as needed: ${names}. Parallel calls allowed.`
      : opts.mode === 'VALIDATED'
        ? `Available declared functions: ${names}. Arguments are schema-constrained; the MCP client validates before executing side effects.`
        : `Available declared functions: ${names}. Call them only when the request requires it.`;

  const executionInstruction = hasBuiltInTraces
    ? 'Server-side tool traces may also appear. Custom functions are executed by the MCP client. Do not fabricate results.'
    : 'After a function call, wait for the client response. Do not invent results.';

  return joinNonEmpty([modeInstruction, executionInstruction]);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: rewrite buildFunctionCallingInstructionText for conciseness"
```

---

### PHASE-003: Analysis and research prompt builders ([src/lib/model-prompts.ts](src/lib/model-prompts.ts))

**Goal:** Rewrite the five remaining builders (grounded answer, file analysis, diff review, error diagnosis, diagram, agentic research) and update their tests.

|                                         Task                                          | Action                                  |                                      Depends on                                       | Files                                                                                                                            | Validate                                                                                         |
| :-----------------------------------------------------------------------------------: | :-------------------------------------- | :-----------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| [`TASK-003`](#task-003-rewrite-buildgroundedanswerprompt-and-buildfileanalysisprompt) | Rewrite grounded answer + file analysis |                                         none                                          | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|                 [`TASK-004`](#task-004-rewrite-builddiffreviewprompt)                 | Rewrite diff review                     | [`TASK-003`](#task-003-rewrite-buildgroundedanswerprompt-and-buildfileanalysisprompt) | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|               [`TASK-005`](#task-005-rewrite-builderrordiagnosisprompt)               | Rewrite error diagnosis                 |                 [`TASK-004`](#task-004-rewrite-builddiffreviewprompt)                 | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|             [`TASK-006`](#task-006-rewrite-builddiagramgenerationprompt)              | Rewrite diagram generation              |               [`TASK-005`](#task-005-rewrite-builderrordiagnosisprompt)               | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|              [`TASK-007`](#task-007-rewrite-buildagenticresearchprompt)               | Rewrite agentic research                |       [`TASK-001`](#task-001-add-cite_code-cite_web-report_skeleton-constants)        | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |

#### TASK-003: Rewrite buildGroundedAnswerPrompt and buildFileAnalysisPrompt

| Field      | Value                                                                                                                                                                                             |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | none                                                                                                                                                                                              |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Test: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                                                    |
| Symbols    | [buildGroundedAnswerPrompt](src/lib/model-prompts.ts#L119), [buildFileAnalysisPrompt](src/lib/model-prompts.ts#L168)                                                                              |
| Outcome    | Grounded answer says "Answer from sources" (not "using"), file analysis says "## Answer" (no "response to the goal"), and "Do not invent." (not "Do not invent content not present in the file"). |

- [ ] **Step 1: Write the failing tests** — add three negative assertions to the existing `'builds file-analysis prompts for all supported modes'` test in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts):

```ts
// __tests__/lib/model-prompts.test.ts
// Append these assertions inside the existing 'builds file-analysis prompts for all supported modes' test:
assert.ok(!single.systemInstruction?.includes('response to the goal'));
assert.ok(!single.systemInstruction?.includes('Do not invent content'));
assert.ok(!url.systemInstruction?.includes('using content retrieved from'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: FAIL — the three new negative assertions fail because the source still contains "response to the goal", "Do not invent content", and "using content retrieved from".

- [ ] **Step 3: Rewrite the two builders** in [src/lib/model-prompts.ts](src/lib/model-prompts.ts):

```ts
// src/lib/model-prompts.ts — replace buildGroundedAnswerPrompt systemInstruction
systemInstruction: joinNonEmpty([
  retrievalUnavailable ? 'No retrieval tools are available this turn.' : undefined,
  "Answer from sources retrieved this turn. Mark unsupported claims '(unverified)'. If retrieval returned nothing, say so. Do not invent URLs.",
]),

// Replace buildFileAnalysisPrompt — single variant systemInstruction:
systemInstruction:
  'Answer the goal from the attached file.\n## Answer\n## References — excerpts as `path:line`.\nDo not invent.',

// Replace buildFileAnalysisPrompt — url variant systemInstruction:
systemInstruction:
  'Answer the goal from content at the listed URLs.\n## Answer\n## References — sources as [title](url); note any that failed to retrieve.\nIf no URLs retrieved, say so. Do not invent.',

// Replace buildFileAnalysisPrompt — multi variant systemInstruction:
systemInstruction:
  'Analyze the attached files.\n## Answer\n## References — excerpts as `filename:line` or short quotes.\nDo not invent.',
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: rewrite buildGroundedAnswerPrompt and buildFileAnalysisPrompt"
```

---

#### TASK-004: Rewrite buildDiffReviewPrompt

| Field      | Value                                                                                                                                                                                                       |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-rewrite-buildgroundedanswerprompt-and-buildfileanalysisprompt)                                                                                                                       |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Test: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                                                              |
| Symbols    | [buildDiffReviewPrompt](src/lib/model-prompts.ts#L227)                                                                                                                                                      |
| Outcome    | `systemInstruction` says "Review the diff for" (not "unified diff"), "Present findings as a table:" (not "Markdown table"), "Severity:" (not "Severity values:"), uses `CITE_CODE`, and "If clean, say so". |

- [ ] **Step 1: Write the failing test** — replace the `includes('Review the unified diff')` assertion in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts):

```ts
// __tests__/lib/model-prompts.test.ts
// In 'keeps diff-review system instructions when cache mode prepends cache text':
// Replace:
//   assert.ok(prompt.systemInstruction?.includes('Review the unified diff'));
// With:
assert.ok(prompt.systemInstruction?.includes('Review the diff'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: FAIL — the rewritten assertion fails because source still says "Review the unified diff".

- [ ] **Step 3: Rewrite `buildDiffReviewPrompt`** in [src/lib/model-prompts.ts](src/lib/model-prompts.ts) — update the review-mode `systemInstruction` and `docInstruction`:

````ts
// src/lib/model-prompts.ts — replace review-mode systemInstruction and docInstruction

// docInstruction (inside the hasDocs block):
const docInstruction = hasDocs
  ? ' Cross-reference the diff with the documentation context. If the diff makes docs factually incorrect, emit a trailing ```json\n{ "documentationDrift": [...] }\n``` block. Omit it if docs are still accurate. No empty array; no unfenced JSON.'
  : '';

// review-mode systemInstruction:
systemInstruction: `Review the diff for bugs, regressions, and behavior risk. Ignore formatting-only changes.\nPresent findings as a table:\n| Severity | File | Finding | Fix |\nSeverity: Critical · High · Medium · Low · Info\n${CITE_CODE} Do not invent line numbers.\nIf clean, say so in one sentence — no table.${docInstruction}`,

// compare-mode systemInstruction — update the Differences line and Cite line:
systemInstruction: joinNonEmpty([
  'Compare the files.',
  '## Summary — 2–4 sentence overview of what differs and why it matters.',
  '## Differences — table (| Aspect | File A | File B |) for 2+ attributes; prose otherwise.',
  '## Impact — consequences of the differences.',
  `${CITE_CODE} Do not invent line numbers.`,
]),
````

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: rewrite buildDiffReviewPrompt for conciseness"
```

---

#### TASK-005: Rewrite buildErrorDiagnosisPrompt

| Field      | Value                                                                                                                                                                                                                                                  |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-004`](#task-004-rewrite-builddiffreviewprompt)                                                                                                                                                                                                  |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Test: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                                                                                                         |
| Symbols    | [buildErrorDiagnosisPrompt](src/lib/model-prompts.ts#L276)                                                                                                                                                                                             |
| Outcome    | `systemInstruction` says "Diagnose the error from the given context." (merged), "remediation steps. Number them if more than one.", "edge cases or follow-ups.", "Search the error and key identifiers", and "Mark claims not derivable from context". |

- [ ] **Step 1: Write the failing test** — update the `includes('Search the error message and key identifiers')` assertion in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts):

```ts
// __tests__/lib/model-prompts.test.ts
// In 'builds error-diagnosis prompts that match search availability':
// Replace:
//   assert.ok(searchable.systemInstruction?.includes('Search the error message and key identifiers'));
// With:
assert.ok(searchable.systemInstruction?.includes('Search the error and key identifiers'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: FAIL — the assertion fails because source still says "Search the error message and key identifiers".

- [ ] **Step 3: Rewrite `buildErrorDiagnosisPrompt`** in [src/lib/model-prompts.ts](src/lib/model-prompts.ts):

```ts
// src/lib/model-prompts.ts — replace buildErrorDiagnosisPrompt systemInstruction
systemInstruction: joinNonEmpty([
  'Diagnose the error from the given context.',
  `## Cause — most likely root cause. ${CITE_CODE}`,
  '## Fix — remediation steps. Number them if more than one.',
  '## Notes — edge cases or follow-ups. Omit if empty.',
  args.googleSearchEnabled
    ? `Search the error and key identifiers. ${CITE_WEB}`
    : "Mark claims not derivable from context as '(unverified)'.",
]),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: rewrite buildErrorDiagnosisPrompt for conciseness"
```

---

#### TASK-006: Rewrite buildDiagramGenerationPrompt

| Field      | Value                                                                                                                                                                                                                                                        |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-rewrite-builderrordiagnosisprompt)                                                                                                                                                                                                    |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Test: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                                                                                                               |
| Symbols    | [buildDiagramGenerationPrompt](src/lib/model-prompts.ts#L318)                                                                                                                                                                                                |
| Outcome    | `systemInstruction` says "Return one fenced" (not "exactly one"), "No prose." (not "No prose before or after the block."), "Run Code Execution once" (not "You may run"). `cacheText` says "Return one fenced `mermaid block." (updated from "exactly one"). |

- [ ] **Step 1: Write the failing tests** — update two assertions in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts):

````ts
// __tests__/lib/model-prompts.test.ts
// In 'builds diagram prompts with one live task part and a short stable instruction':
// Replace:
//   assert.ok(prompt.systemInstruction?.includes('Return exactly one fenced'));
// With:
assert.ok(prompt.systemInstruction?.includes('Return one fenced'));

// In 'keeps diagram system instructions when cache mode prepends cache text':
// Replace the deepStrictEqual assertion with:
assert.deepStrictEqual(prompt.promptParts, [
  { text: 'Return one fenced ```mermaid block.' },
  { text: 'Task: Show the request flow' },
]);
````

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: FAIL — both updated assertions fail because source still says "Return exactly one fenced".

- [ ] **Step 3: Rewrite `buildDiagramGenerationPrompt`** in [src/lib/model-prompts.ts](src/lib/model-prompts.ts):

```ts
// src/lib/model-prompts.ts — replace buildDiagramGenerationPrompt body
return resolvePartPrompt(
  {
    cacheText: `Return one fenced \`\`\`${args.diagramType} block.`,
    promptParts: [...(args.attachedParts ?? []), { text: `Task: ${args.description}` }],
    systemInstruction: joinNonEmpty([
      `Generate a ${args.diagramType} diagram from the description and files.`,
      `Return one fenced \`\`\`${args.diagramType} block with clear node and edge labels.`,
      'No prose.',
      args.validateSyntax
        ? 'Run Code Execution once to validate syntax. Do not narrate the result.'
        : undefined,
    ]),
  },
  args.cacheName,
);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: rewrite buildDiagramGenerationPrompt for conciseness"
```

---

#### TASK-007: Rewrite buildAgenticResearchPrompt

| Field      | Value                                                                                                                                                                             |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-add-cite_code-cite_web-report_skeleton-constants)                                                                                                          |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Test: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                                    |
| Symbols    | [buildAgenticResearchPrompt](src/lib/model-prompts.ts#L342)                                                                                                                       |
| Outcome    | `systemInstruction` uses `REPORT_SKELETON`, says "grounded report" (not "grounded Markdown report"), "Issue multiple searches as needed.", and "If evidence does not support it". |

- [ ] **Step 1: Write the failing test** — add one negative assertion to the existing agentic-research test in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts):

```ts
// __tests__/lib/model-prompts.test.ts
// Inside 'builds agentic-research prompts without duplicating process instructions in cache mode':
// Append:
assert.ok(!prompt.systemInstruction?.includes('Markdown report'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: FAIL — the new negative assertion fails because source still says "Markdown report".

- [ ] **Step 3: Rewrite `buildAgenticResearchPrompt`** in [src/lib/model-prompts.ts](src/lib/model-prompts.ts):

```ts
// src/lib/model-prompts.ts — replace buildAgenticResearchPrompt systemInstruction block
systemInstruction: joinNonEmpty([
  args.capabilities.googleSearch
    ? `Research with Google Search, then write a grounded report:\n${REPORT_SKELETON}`
    : `Write a grounded report:\n${REPORT_SKELETON}`,
  args.capabilities.multiTurnRetrieval === true
    ? 'Issue multiple searches as needed.'
    : undefined,
  args.capabilities.codeExecution
    ? 'Use Code Execution only for arithmetic, ranking, or consistency checks.'
    : undefined,
  args.deliverable
    ? `Preferred shape: ${args.deliverable}. If evidence does not support it, use the best-supported structure and say why.`
    : undefined,
  `${CITE_WEB} Flag unverified claims. Include dates for time-sensitive facts.`,
]),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: rewrite buildAgenticResearchPrompt using REPORT_SKELETON"
```

---

### PHASE-004: DEFAULT_SYSTEM_INSTRUCTION ([src/client.ts](src/client.ts))

**Goal:** Rewrite the global base instruction to remove "Markdown" from "Markdown table", strip inline citation redundancy, and drop the filler examples.

|                            Task                            | Action                             | Depends on | Files                                                                                                              | Validate                                                                                             |
| :--------------------------------------------------------: | :--------------------------------- | :--------: | :----------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| [`TASK-008`](#task-008-rewrite-default_system_instruction) | Rewrite DEFAULT_SYSTEM_INSTRUCTION |    none    | [src/client.ts](src/client.ts), [**tests**/lib/workspace-context.test.ts](__tests__/lib/workspace-context.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/workspace-context.test.ts` |

#### TASK-008: Rewrite DEFAULT_SYSTEM_INSTRUCTION

| Field      | Value                                                                                                                                                                                               |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                                |
| Files      | Modify: [src/client.ts](src/client.ts); Test: [**tests**/lib/workspace-context.test.ts](__tests__/lib/workspace-context.test.ts)                                                                    |
| Symbols    | [DEFAULT_SYSTEM_INSTRUCTION](src/client.ts#L49)                                                                                                                                                     |
| Outcome    | Constant says "Use a table when content has 2+ attributes per item." (no "Markdown"), "Use bullets" (not "bullet points"), citations use no redundant "inline", and filler rule drops the examples. |

- [ ] **Step 1: Write the failing test** — replace the breaking assertion in [**tests**/lib/workspace-context.test.ts](__tests__/lib/workspace-context.test.ts):

```ts
// __tests__/lib/workspace-context.test.ts
// In 'DEFAULT_SYSTEM_INSTRUCTION — is exported and non-empty':
// Replace:
//   assert.ok(DEFAULT_SYSTEM_INSTRUCTION.includes('Markdown table'));
// With:
assert.ok(DEFAULT_SYSTEM_INSTRUCTION.includes('2+ attributes per item'));
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/workspace-context.test.ts
```

Expected: FAIL — the updated assertion fails because source still says "Markdown table", not "2+ attributes per item" alone (the substring check changes).

- [ ] **Step 3: Rewrite `DEFAULT_SYSTEM_INSTRUCTION`** in [src/client.ts](src/client.ts) (replace lines 49–53):

```ts
// src/client.ts
export const DEFAULT_SYSTEM_INSTRUCTION =
  'Use a table when content has 2+ attributes per item. Use bullets for 3–7 homogeneous items. Use prose for narrative.\n' +
  'Start sections at ##. Use ### for sub-sections. Never use #.\n' +
  'Cite web sources as [title](url). Cite code as `path:line`. Collect URLs in ## Sources when 2+ cited.\n' +
  'No opening filler. No trailing restatements. No unsolicited caveats.';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/workspace-context.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts __tests__/lib/workspace-context.test.ts
git commit -m "refactor: rewrite DEFAULT_SYSTEM_INSTRUCTION for conciseness"
```

---

### PHASE-005: Tool-level inline strings

**Goal:** Rewrite `buildReducedRepairPrompt` in [src/tools/chat.ts](src/tools/chat.ts) and the deep-research planning prompt in [src/tools/research.ts](src/tools/research.ts). No tests have exact-string assertions for these strings so no test changes are needed.

|                             Task                              | Action                           | Depends on | Files                                          | Validate                         |
| :-----------------------------------------------------------: | :------------------------------- | :--------: | :--------------------------------------------- | :------------------------------- |
|   [`TASK-009`](#task-009-rewrite-buildreducedrepairprompt)    | Rewrite buildReducedRepairPrompt |    none    | [src/tools/chat.ts](src/tools/chat.ts)         | `node scripts/tasks.mjs --quick` |
| [`TASK-010`](#task-010-rewrite-deep-research-planning-prompt) | Rewrite research planning prompt |    none    | [src/tools/research.ts](src/tools/research.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-009: Rewrite buildReducedRepairPrompt

| Field      | Value                                                                                                                                                                                  |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                   |
| Files      | Modify: [src/tools/chat.ts](src/tools/chat.ts)                                                                                                                                         |
| Symbols    | [buildReducedRepairPrompt](src/tools/chat.ts#L203)                                                                                                                                     |
| Outcome    | Repair prompt says "Fix the invalid JSON", "Return only valid JSON that matches", "User request:", and "Previous output:". TDD skipped: no exact-string test exists for this function. |

- [ ] **Step 1: Apply change** — replace the four string literals in [src/tools/chat.ts](src/tools/chat.ts) inside `buildReducedRepairPrompt`:

```ts
// src/tools/chat.ts — replace buildReducedRepairPrompt body
return [
  'Fix the invalid JSON from the previous turn.',
  'Return only valid JSON that matches the provided schema.',
  `User request:\n${originalPrompt}`,
  `Validation errors:\n${warningText}`,
  `Previous output:\n${invalidOutputText}`,
].join('\n\n');
```

- [ ] **Step 3: Verify type-check passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/chat.ts
git commit -m "refactor: rewrite buildReducedRepairPrompt for conciseness"
```

---

#### TASK-010: Rewrite deep-research planning prompt

| Field      | Value                                                                                                                                                                              |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                               |
| Files      | Modify: [src/tools/research.ts](src/tools/research.ts)                                                                                                                             |
| Symbols    | none (inline template literal at line 614)                                                                                                                                         |
| Outcome    | Planning turn prompt says `Return JSON: {"queries":["..."]}` and "focused web search queries" (not "public web"). TDD skipped: no exact-string test exists for this inline string. |

- [ ] **Step 1: Apply change** — update the planning turn template literal in [src/tools/research.ts](src/tools/research.ts) (around line 614):

```ts
// src/tools/research.ts — replace planning turn promptText
`Return JSON: {"queries":["..."]}. Produce ${String(Math.min(args.searchDepth, 5))} focused web search queries for:\n${args.topic}`;
```

- [ ] **Step 3: Verify type-check passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/research.ts
git commit -m "refactor: rewrite deep-research planning prompt for conciseness"
```

---

### PHASE-006: MCP prompt builders ([src/prompts.ts](src/prompts.ts))

**Goal:** Rewrite label strings in the three MCP prompt builders and update the one breaking regex in `prompts.test.ts`.

|                        Task                         | Action                           | Depends on | Files                                                                                    | Validate                                                                               |
| :-------------------------------------------------: | :------------------------------- | :--------: | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| [`TASK-011`](#task-011-rewrite-mcp-prompt-builders) | Rewrite MCP prompt label strings |    none    | [src/prompts.ts](src/prompts.ts), [**tests**/prompts.test.ts](__tests__/prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/prompts.test.ts` |

#### TASK-011: Rewrite MCP prompt builders

| Field      | Value                                                                                                                                                                                                              |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                                               |
| Files      | Modify: [src/prompts.ts](src/prompts.ts); Test: [**tests**/prompts.test.ts](__tests__/prompts.test.ts)                                                                                                             |
| Symbols    | [buildDiscoverPrompt](src/prompts.ts#L92), [buildResearchPrompt](src/prompts.ts#L103), [buildReviewPrompt](src/prompts.ts#L115)                                                                                    |
| Outcome    | Labels use "Job:", "Goal:", "Mode:", "Deliverable:", "Subject:" (no "Preferred", "User", "Requested", "Review" prefixes). Review trailing text says "Recommend the review variant" (not "review subject variant"). |

- [ ] **Step 1: Write the failing test** — update the regex in [**tests**/prompts.test.ts](__tests__/prompts.test.ts):

```ts
// __tests__/prompts.test.ts
// In 'builds a prompt that references review subject variants':
// Replace:
//   assert.match(text, /review subject/i);
// With:
assert.match(text, /review variant/i);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/prompts.test.ts
```

Expected: FAIL — the updated assertion fails because source still says "review subject variant".

- [ ] **Step 3: Rewrite the three builders** in [src/prompts.ts](src/prompts.ts):

```ts
// src/prompts.ts — replace buildDiscoverPrompt body
export function buildDiscoverPrompt(args: z.infer<typeof DiscoverPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.job ? [`Job: ${args.job}`] : []),
      ...(args.goal ? [`Goal: ${args.goal}`] : []),
      renderWorkflowSection('start-here'),
      'Recommend the best next job, prompt, and resource.',
    ].join('\n\n'),
  );
}

// Replace buildResearchPrompt body
export function buildResearchPrompt(args: z.infer<typeof ResearchPromptSchema>) {
  return userPromptMessage(
    [
      `Goal: ${args.goal}`,
      ...(args.mode ? [`Mode: ${args.mode}`] : []),
      ...(args.deliverable ? [`Deliverable: ${args.deliverable}`] : []),
      renderWorkflowSection('research'),
      'Explain whether quick or deep research fits better and why.',
    ].join('\n\n'),
  );
}

// Replace buildReviewPrompt body
export function buildReviewPrompt(args: z.infer<typeof ReviewPromptSchema>) {
  return userPromptMessage(
    [
      ...(args.subject ? [`Subject: ${args.subject}`] : []),
      ...(args.focus ? [`Focus: ${args.focus}`] : []),
      renderWorkflowSection('review'),
      'Recommend the review variant and what information to gather first.',
    ].join('\n\n'),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts __tests__/prompts.test.ts
git commit -m "refactor: rewrite MCP prompt label strings for conciseness"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full check suite passes after all tasks

```bash
node scripts/tasks.mjs
```

### [`VAL-002`](#5-testing--validation) — No old verbose phrases remain in source

```bash
# Each grep should return no output
grep -rn "Markdown table\|You must call one or more\|After issuing a declared function call\|Gemini may emit server-side built-in\|Review the unified diff\|response to the goal\|Do not invent content not present\|Return exactly one fenced\|Markdown report\|You may issue multiple\|If the evidence does not\|Cite source URLs.*inline\|Search the error message\|Preferred job:\|User goal:\|Preferred mode:\|Requested deliverable:\|Review subject:\|review subject variant\|No prose before or after\|Repair the invalid JSON response\|Return ONLY valid JSON that conforms exactly\|Original user request:\|Previous invalid output:\|public web search queries" src/ --include="*.ts"
```

Expected: no output (all old phrases removed).

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                                  |
| :--------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | `node scripts/tasks.mjs` completes with exit code 0 after all 11 tasks.                                                                                                             |
| [`AC-002`](#6-acceptance-criteria) | `VAL-002` grep returns no output — all old verbose phrases are removed from `src/`.                                                                                                 |
| [`AC-003`](#6-acceptance-criteria) | `CITE_CODE`, `CITE_WEB`, `REPORT_SKELETON` exist as module-level constants in [src/lib/model-prompts.ts](src/lib/model-prompts.ts) and are referenced by at least one builder each. |
| [`AC-004`](#6-acceptance-criteria) | `DEFAULT_SYSTEM_INSTRUCTION` in [src/client.ts](src/client.ts) no longer contains the word "Markdown" or the phrase "not grounded in the task".                                     |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                           |
| :---------------------------: | :--: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`NOTE-001`](#7-risks--notes) | Note | `cacheText` strings are intentionally not changed — they feed the context cache key and changing them would invalidate live caches in any running server instance. Only `systemInstruction` and `promptText`/`promptParts` are modified.                                                                         |
| [`NOTE-002`](#7-risks--notes) | Note | TASK-007 depends on TASK-001 (constants must exist before `REPORT_SKELETON` is used). All other tasks in PHASE-003 are independent of each other and can be done in sequence without conflict.                                                                                                                   |
| [`RISK-001`](#7-risks--notes) | Risk | The `CITE_CODE` constant ends with a period. When concatenated into a `joinNonEmpty` block that has surrounding sentences, verify the period does not produce double-punctuation (e.g., `"${CITE_CODE} Do not invent line numbers."` produces `"Cite as \`path:line\`. Do not invent line numbers."` — correct). |
| [`NOTE-003`](#7-risks--notes) | Note | The `buildAnalysisPrompt` in [src/tools/review.ts](src/tools/review.ts) is a structured data formatter (paths, stats, diff block), not a system instruction builder. It has no verbose phrases to trim and requires no changes.                                                                                  |
