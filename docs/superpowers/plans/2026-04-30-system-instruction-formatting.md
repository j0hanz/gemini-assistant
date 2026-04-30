---
goal: Replace all systemInstruction strings and DEFAULT_SYSTEM_INSTRUCTION with format-first, noise-free instructions that enforce consistent Markdown tables, heading hierarchy, citation style, and structured output skeletons across every tool mode.
version: 1
date_created: 2026-04-30
status: Planned
plan_type: refactor
component: model-prompts
execution: subagent-driven
---

# Implementation Plan: System Instruction & Response Formatting

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Rewrite all `systemInstruction` string literals and `DEFAULT_SYSTEM_INSTRUCTION` to produce clean, structured Markdown output — format-first rules in the shared base, tool-specific output skeletons in each prompt builder.

**Architecture:** Two files change: the global default in [src/client.ts](src/client.ts) (one constant) and nine `systemInstruction` strings inside five builder functions in [src/lib/model-prompts.ts](src/lib/model-prompts.ts). Two existing test assertions in [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) assert on removed phrases and must be updated first (TDD tasks). The remaining six prompt changes are pure string substitutions whose existing `.includes()` tests continue passing without modification.

**Tech Stack:** TypeScript, Node.js built-in test runner (`tsx/esm`), `node scripts/tasks.mjs` for full verification.

---

## 1. Goal

Replace the terse `DEFAULT_SYSTEM_INSTRUCTION` with a four-rule formatting policy (table policy, heading policy, citation style, noise suppression). Update each `buildXxxPrompt()` builder to append a tool-specific output skeleton — findings tables for review, `## Summary / ## Findings / ## Sources` for deep research, `## Answer / ## References` for analyze — while keeping all function signatures, `CallToolResult` shapes, and public contract definitions unchanged.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                             |
| :---------------------------------------: | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `DEFAULT_SYSTEM_INSTRUCTION` must state the table-vs-prose rule, heading-level rule, citation format, and three noise anti-patterns.                  |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Deep research (`buildAgenticResearchPrompt`) must include `## Summary`, `## Findings`, `## Sources` skeleton in `systemInstruction`.                  |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Review diff mode must instruct the model to emit a `\| Severity \| File \| Finding \| Fix \|` table; clean diffs get one sentence and no table.       |
| [`REQ-004`](#2-requirements--constraints) | Requirement | Analyze single/url/multi modes must include `## Answer` + `## References` skeleton. Diagram mode must forbid prose around the fenced block.           |
| [`REQ-005`](#2-requirements--constraints) | Requirement | Error diagnosis must replace the flat section list with inline-described sections (`## Cause — …`, `## Fix — …`, `## Notes — …`).                     |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No function signatures, `CallToolResult` shapes, or `public-contract.ts` definitions may change.                                                      |
| [`CON-002`](#2-requirements--constraints) | Constraint  | `cacheText` values must not change — they serve as cache-key hints and are asserted by existing tests.                                                |
| [`CON-003`](#2-requirements--constraints) | Constraint  | All existing test assertions that are not explicitly updated in this plan must continue passing.                                                      |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Use [`joinNonEmpty`](src/lib/model-prompts.ts) to compose multi-part `systemInstruction` strings; it joins with `\n\n` and drops `undefined` entries. |

## 3. Current Context

### File structure

| File                                                                       | Status | Responsibility                                                                                                                                                                                                            |
| :------------------------------------------------------------------------- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/client.ts](src/client.ts)                                             | Modify | Holds `DEFAULT_SYSTEM_INSTRUCTION` — the fallback applied when no tool-level instruction is set.                                                                                                                          |
| [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                       | Modify | All five `buildXxxPrompt()` functions that produce `systemInstruction` strings. Also contains private `buildOutputInstruction` helper that becomes unused after this plan and must be deleted.                            |
| [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | Modify | Two assertions must be updated: one that asserts `## Findings` is absent from deep research (it will now be present) and one that asserts `No web search is available` is present in error diagnosis (phrase is removed). |

### Relevant symbols

| Symbol                                                        | Why it matters                                                                              |
| :------------------------------------------------------------ | :------------------------------------------------------------------------------------------ |
| [DEFAULT_SYSTEM_INSTRUCTION](src/client.ts#L49)               | Fallback `systemInstruction`; the string being replaced in TASK-001.                        |
| [buildGroundedAnswerPrompt](src/lib/model-prompts.ts#L123)    | Research quick-mode prompt builder; `systemInstruction` tightened in TASK-002.              |
| [buildFileAnalysisPrompt](src/lib/model-prompts.ts#L172)      | Analyze single/url/multi builder; all three mode strings updated in TASK-003.               |
| [buildDiffReviewPrompt](src/lib/model-prompts.ts#L231)        | Review diff and compare builder; review-mode updated in TASK-004, compare-mode in TASK-005. |
| [buildDiagramGenerationPrompt](src/lib/model-prompts.ts#L319) | Diagram builder; updated in TASK-006.                                                       |
| [buildAgenticResearchPrompt](src/lib/model-prompts.ts#L342)   | Deep research builder; skeleton added in TASK-007 (TDD).                                    |
| [buildErrorDiagnosisPrompt](src/lib/model-prompts.ts#L280)    | Error diagnosis builder; section labels restructured in TASK-008 (TDD).                     |

### Existing commands

```bash
# Run a single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts

# Full check suite (format → lint/type-check/knip → test/build)
node scripts/tasks.mjs
```

### Current behavior

`DEFAULT_SYSTEM_INSTRUCTION` is `'Be direct, accurate, and concise. Use Markdown when useful.'` — no concrete formatting rules. Each `buildXxxPrompt()` function specifies what to do but not how to structure the output: no table policy, no heading-level constraint, no citation format, inconsistent section shapes across tools.

## 4. Implementation Phases

### PHASE-001: Shared base

**Goal:** Replace `DEFAULT_SYSTEM_INSTRUCTION` with the four-rule formatting policy.

|                           Task                            | Action                  | Depends on | Files                          | Validate                         |
| :-------------------------------------------------------: | :---------------------- | :--------: | :----------------------------- | :------------------------------- |
| [`TASK-001`](#task-001-update-default_system_instruction) | Replace constant string |    none    | [src/client.ts](src/client.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-001: Update DEFAULT_SYSTEM_INSTRUCTION

| Field      | Value                                                                                                                                                             |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                              |
| Files      | Modify: [src/client.ts](src/client.ts)                                                                                                                            |
| Symbols    | [DEFAULT_SYSTEM_INSTRUCTION](src/client.ts#L49)                                                                                                                   |
| Outcome    | `DEFAULT_SYSTEM_INSTRUCTION` is the four-rule formatting policy; `npm run check:static` passes. TDD skipped — no existing test asserts on the exact string value. |

- [ ] **Step 1: Apply change**

Replace lines 49-50 in [src/client.ts](src/client.ts):

```ts
// src/client.ts  (lines 49-50)
export const DEFAULT_SYSTEM_INSTRUCTION =
  'Use a Markdown table when content has 2+ attributes per item (comparisons, option matrices, findings). Use bullet points for 3–7 homogeneous items. Use prose for narrative.\n' +
  'Start sections at ##. Use ### for sub-sections. Never use #.\n' +
  'Cite web sources as [title](url) inline. Cite code as `path:line` inline. Collect URL references in a ## Sources section when more than one source is cited.\n' +
  'No opening filler ("Sure,", "Great question,"). No trailing restatements. No unsolicited caveats not grounded in the task.';
```

- [ ] **Step 2: Verify**

```bash
node scripts/tasks.mjs --quick
```

Expected: all static checks pass (`format`, `lint`, `type-check`, `knip`).

- [ ] **Step 3: Commit**

```bash
git add src/client.ts
git commit -m "refactor: replace DEFAULT_SYSTEM_INSTRUCTION with format-first policy"
```

---

### PHASE-002: Prompt builders — no test changes required

**Goal:** Update six `systemInstruction` strings whose existing tests use `.includes()` substring checks that remain satisfied after the edit.

|                                  Task                                  | Action                                                  |                               Depends on                               | Files                                                | Validate                                                                                         |
| :--------------------------------------------------------------------: | :------------------------------------------------------ | :--------------------------------------------------------------------: | :--------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
|        [`TASK-002`](#task-002-update-buildgroundedanswerprompt)        | Tighten quick-research instruction                      |       [`TASK-001`](#task-001-update-default_system_instruction)        | [src/lib/model-prompts.ts](src/lib/model-prompts.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
| [`TASK-003`](#task-003-update-buildfileanalysisprompt-all-three-modes) | Add Answer+References skeleton                          |        [`TASK-002`](#task-002-update-buildgroundedanswerprompt)        | [src/lib/model-prompts.ts](src/lib/model-prompts.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|    [`TASK-004`](#task-004-update-builddiffreviewprompt-review-mode)    | Replace Output sections with findings table instruction | [`TASK-003`](#task-003-update-buildfileanalysisprompt-all-three-modes) | [src/lib/model-prompts.ts](src/lib/model-prompts.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|   [`TASK-005`](#task-005-update-builddiffreviewprompt-compare-mode)    | Add structured compare skeleton                         |    [`TASK-004`](#task-004-update-builddiffreviewprompt-review-mode)    | [src/lib/model-prompts.ts](src/lib/model-prompts.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
|      [`TASK-006`](#task-006-update-builddiagramgenerationprompt)       | Add no-prose rule                                       |   [`TASK-005`](#task-005-update-builddiffreviewprompt-compare-mode)    | [src/lib/model-prompts.ts](src/lib/model-prompts.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |

#### TASK-002: Update buildGroundedAnswerPrompt

| Field      | Value                                                                                                                                                                                                                |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-update-default_system_instruction)                                                                                                                                                            |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                                                                                                                                                         |
| Symbols    | [buildGroundedAnswerPrompt](src/lib/model-prompts.ts#L123)                                                                                                                                                           |
| Outcome    | Quick-research `systemInstruction` is tightened; existing test assertions (`includes('sources retrieved this turn')`) still pass. TDD skipped — no new behavior; all existing `.includes()` checks remain satisfied. |

- [ ] **Step 1: Apply change**

In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildGroundedAnswerPrompt`, replace the second argument to `joinNonEmpty`:

```ts
// src/lib/model-prompts.ts — inside buildGroundedAnswerPrompt (around line 140)
systemInstruction: joinNonEmpty([
  retrievalUnavailable ? 'No retrieval tools are available this turn.' : undefined,
  "Answer using sources retrieved this turn. Mark unsupported claims '(unverified)'. If retrieval returned nothing, say so. Do not invent URLs.",
]),
```

- [ ] **Step 2: Verify**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/model-prompts.ts
git commit -m "refactor: tighten buildGroundedAnswerPrompt systemInstruction"
```

---

#### TASK-003: Update buildFileAnalysisPrompt all three modes

| Field      | Value                                                                                                                                                                                                                                                                               |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-update-buildgroundedanswerprompt)                                                                                                                                                                                                                            |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                                                                                                                                                                                                                        |
| Symbols    | [buildFileAnalysisPrompt](src/lib/model-prompts.ts#L172)                                                                                                                                                                                                                            |
| Outcome    | All three modes (`single`, `url`, `multi`) have `## Answer` + `## References` skeleton; diagram mode unchanged here. Existing assertions (`includes('attached file')`, `includes('attached files')`, `includes('listed URLs')`) still pass. TDD skipped — key substrings preserved. |

- [ ] **Step 1: Apply change**

In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildFileAnalysisPrompt`, replace all three `systemInstruction` strings:

```ts
// src/lib/model-prompts.ts — kind === 'single' branch (around line 182)
systemInstruction:
  'Answer the goal from the attached file.\n## Answer — response to the goal.\n## References — cited excerpts as `path:line`.\nDo not invent content not present in the file.',
```

```ts
// src/lib/model-prompts.ts — kind === 'url' branch (around line 196)
systemInstruction:
  'Answer the goal using content retrieved from the listed URLs.\n## Answer — response to the goal.\n## References — cite retrieved sources as [title](url). Note any URLs that did not retrieve.\nIf no URLs retrieved, say so in ## Answer. Do not guess content.',
```

```ts
// src/lib/model-prompts.ts — kind === 'multi' branch (around line 206)
systemInstruction:
  'Analyze the attached files.\n## Answer — response to the goal.\n## References — cited excerpts as `filename:line` or short quotes.\nDo not invent content not present in the files.',
```

- [ ] **Step 2: Verify**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/model-prompts.ts
git commit -m "refactor: add Answer+References skeleton to buildFileAnalysisPrompt"
```

---

#### TASK-004: Update buildDiffReviewPrompt review mode

| Field      | Value                                                                                                                                                                                                                                                                                 |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | [`TASK-003`](#task-003-update-buildfileanalysisprompt-all-three-modes)                                                                                                                                                                                                                |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                                                                                                                                                                                                                          |
| Symbols    | [buildDiffReviewPrompt](src/lib/model-prompts.ts#L231)                                                                                                                                                                                                                                |
| Outcome    | Review-mode `systemInstruction` instructs a `\| Severity \| File \| Finding \| Fix \|` findings table; `buildOutputInstruction` is no longer called from this branch. Existing assertion (`includes('Review the unified diff')`) still passes. TDD skipped — key substring preserved. |

- [ ] **Step 1: Apply change**

In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildDiffReviewPrompt`, replace only the `systemInstruction` value in the `mode === 'review'` branch. The `cacheText` and `promptText` lines are unchanged.

```ts
// src/lib/model-prompts.ts — review mode branch (around line 267)
return resolveTextPrompt(
  {
    cacheText: 'Review the diff for bugs and behavior risk. Ignore formatting-only changes.',
    promptText: args.promptText + docContent,
    systemInstruction: `Review the unified diff for bugs, regressions, and behavior risk. Ignore formatting-only changes.\nPresent findings as a Markdown table:\n| Severity | File | Finding | Fix |\nSeverity values: Critical · High · Medium · Low · Info\nCite file paths as \`path:line\`. Do not invent line numbers.\nIf the diff is clean, say so in one sentence — no table.${docInstruction}`,
  },
  args.cacheName,
);
```

- [ ] **Step 2: Verify**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/model-prompts.ts
git commit -m "refactor: replace Output sections with findings table in review-diff systemInstruction"
```

---

#### TASK-005: Update buildDiffReviewPrompt compare mode

| Field      | Value                                                                                                                                                                                                                                |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-004`](#task-004-update-builddiffreviewprompt-review-mode)                                                                                                                                                                     |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                                                                                                                                                                         |
| Symbols    | [buildDiffReviewPrompt](src/lib/model-prompts.ts#L231)                                                                                                                                                                               |
| Outcome    | Compare-mode `systemInstruction` uses `joinNonEmpty` with structured section descriptors; `buildOutputInstruction` no longer called from this branch. Existing assertions (`includes('Compare the files')`) still pass. TDD skipped. |

- [ ] **Step 1: Apply change**

In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildDiffReviewPrompt`, replace only the `systemInstruction` value in the `mode === 'compare'` branch. The `cacheText` and `promptParts` lines are unchanged.

```ts
// src/lib/model-prompts.ts — compare mode branch (around line 245)
systemInstruction: joinNonEmpty([
  'Compare the files.',
  '## Summary — 2–4 sentence overview of what differs and why it matters.',
  '## Differences — table with columns | Aspect | File A | File B | when 2+ attributes differ; prose otherwise.',
  '## Impact — consequences of the differences.',
  'Cite symbols or short quotes as `path:line`. Do not invent line numbers.',
]),
```

- [ ] **Step 2: Verify**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/model-prompts.ts
git commit -m "refactor: add structured section skeleton to buildDiffReviewPrompt compare mode"
```

---

#### TASK-006: Update buildDiagramGenerationPrompt

| Field      | Value                                                                                                                                                                                                                                            |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-update-builddiffreviewprompt-compare-mode)                                                                                                                                                                                |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts)                                                                                                                                                                                     |
| Symbols    | [buildDiagramGenerationPrompt](src/lib/model-prompts.ts#L319)                                                                                                                                                                                    |
| Outcome    | Diagram `systemInstruction` includes "No prose before or after the block." and tightened validateSyntax wording. Existing assertions (`includes('Return exactly one fenced')`, `includes('Do not narrate the result')`) still pass. TDD skipped. |

- [ ] **Step 1: Apply change**

In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildDiagramGenerationPrompt`, replace the `systemInstruction` value:

```ts
// src/lib/model-prompts.ts — inside buildDiagramGenerationPrompt (around line 330)
systemInstruction: joinNonEmpty([
  `Generate a ${args.diagramType} diagram from the description and files.`,
  `Return exactly one fenced \`\`\`${args.diagramType} block with clear node and edge labels.`,
  'No prose before or after the block.',
  args.validateSyntax
    ? 'You may run Code Execution once to validate syntax. Do not narrate the result.'
    : undefined,
]),
```

- [ ] **Step 2: Verify**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/model-prompts.ts
git commit -m "refactor: add no-prose rule to buildDiagramGenerationPrompt systemInstruction"
```

---

### PHASE-003: Prompt builders — test updates required (TDD)

**Goal:** Update the two prompt builders whose changes require flipping or replacing existing test assertions. Write the failing assertion first, confirm it fails, then update the implementation.

|                                           Task                                            | Action                                                                         |                         Depends on                          | Files                                                                                                                            | Validate                                                                                         |
| :---------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------- | :---------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
|                 [`TASK-007`](#task-007-update-buildagenticresearchprompt)                 | Add Summary/Findings/Sources skeleton                                          | [`TASK-006`](#task-006-update-builddiagramgenerationprompt) | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts` |
| [`TASK-008`](#task-008-update-builderrordianosisprompt-and-remove-buildoutputinstruction) | Replace flat section list with inline-described sections; delete unused helper |  [`TASK-007`](#task-007-update-buildagenticresearchprompt)  | [src/lib/model-prompts.ts](src/lib/model-prompts.ts), [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) | `node scripts/tasks.mjs`                                                                         |

#### TASK-007: Update buildAgenticResearchPrompt

| Field      | Value                                                                                                                                                                    |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-006`](#task-006-update-builddiagramgenerationprompt)                                                                                                              |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Modify: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                         |
| Symbols    | [buildAgenticResearchPrompt](src/lib/model-prompts.ts#L342)                                                                                                              |
| Outcome    | Deep research `systemInstruction` always includes `## Summary`, `## Findings`, `## Sources` skeleton. Test flips the `!includes('## Findings')` assertion to `includes`. |

- [ ] **Step 1: Write the failing test**

In [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts), locate the test `'builds agentic-research prompts with primary URLs and output shape'` (around line 263). Find line 281:

```ts
// BEFORE (currently passing — asserts ## Findings is absent):
assert.ok(!prompt.systemInstruction?.includes('## Findings'));
```

Replace that one line and add two assertions directly after it:

```ts
// __tests__/lib/model-prompts.test.ts — inside 'builds agentic-research prompts with primary URLs and output shape'
assert.ok(prompt.systemInstruction?.includes('## Summary'));
assert.ok(prompt.systemInstruction?.includes('## Findings'));
assert.ok(prompt.systemInstruction?.includes('## Sources'));
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: test `'builds agentic-research prompts with primary URLs and output shape'` fails with:

```
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert.ok(prompt.systemInstruction?.includes('## Summary'))
```

- [ ] **Step 3: Update implementation**

In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildAgenticResearchPrompt`, replace the `systemInstruction` value in `resolveTextPrompt` (around line 358):

```ts
// src/lib/model-prompts.ts — inside buildAgenticResearchPrompt
systemInstruction: joinNonEmpty([
  args.capabilities.googleSearch
    ? 'Research with Google Search, then write a grounded Markdown report:\n## Summary — 2–4 sentence overview.\n## Findings — body using ### sub-sections or tables per content type.\n## Sources — cited URLs as a compact reference list.'
    : 'Write a grounded Markdown report:\n## Summary — 2–4 sentence overview.\n## Findings — body using ### sub-sections or tables per content type.\n## Sources — cited URLs as a compact reference list.',
  args.capabilities.multiTurnRetrieval === true
    ? 'You may issue multiple searches when needed.'
    : undefined,
  args.capabilities.codeExecution
    ? 'Use Code Execution only for arithmetic, ranking, or consistency checks.'
    : undefined,
  args.deliverable
    ? `Preferred shape: ${args.deliverable}. If the evidence does not support it, use the best-supported structure and say why.`
    : undefined,
  'Cite source URLs as [title](url) inline for retrieved claims. Flag unverified claims. Include dates for time-sensitive facts.',
]),
```

- [ ] **Step 4: Verify tests pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: add Summary/Findings/Sources skeleton to buildAgenticResearchPrompt"
```

---

#### TASK-008: Update buildErrorDiagnosisPrompt and remove buildOutputInstruction

| Field      | Value                                                                                                                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-007`](#task-007-update-buildagenticresearchprompt)                                                                                                                                                                  |
| Files      | Modify: [src/lib/model-prompts.ts](src/lib/model-prompts.ts); Modify: [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts)                                                                           |
| Symbols    | [buildErrorDiagnosisPrompt](src/lib/model-prompts.ts#L280)                                                                                                                                                                 |
| Outcome    | Error-diagnosis `systemInstruction` uses inline-described sections and citation format; `buildOutputInstruction` private helper is deleted (all three call sites removed); `node scripts/tasks.mjs` passes including knip. |

- [ ] **Step 1: Write the failing test**

In [**tests**/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts), locate the test `'builds error-diagnosis prompts that match search availability'` (around line 197). Find the line that reads:

```ts
// BEFORE — currently passing, phrase being removed:
assert.ok(localOnly.systemInstruction?.includes('No web search is available'));
```

Replace that single line with:

```ts
// __tests__/lib/model-prompts.test.ts — inside 'builds error-diagnosis prompts that match search availability'
assert.ok(localOnly.systemInstruction?.includes('## Cause — most likely root cause'));
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

Expected: test `'builds error-diagnosis prompts that match search availability'` fails with:

```
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert.ok(localOnly.systemInstruction?.includes('## Cause — most likely root cause'))
```

- [ ] **Step 3: Update implementation**

**3a.** In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) inside `buildErrorDiagnosisPrompt`, replace the `systemInstruction` value (around line 308):

```ts
// src/lib/model-prompts.ts — inside buildErrorDiagnosisPrompt
systemInstruction: joinNonEmpty([
  'Diagnose the error. Base the cause and fix on the given context.',
  '## Cause — most likely root cause. Cite relevant code as `path:line`.',
  '## Fix — concrete remediation steps. Use a numbered list if more than one step.',
  '## Notes — secondary considerations, edge cases, or follow-ups. Omit if empty.',
  args.googleSearchEnabled
    ? 'Search the error message and key identifiers; cite retrieved sources as [title](url).'
    : "Mark anything not derivable from the given context as '(unverified)'.",
]),
```

**3b.** Delete the now-unused private function `buildOutputInstruction` (around line 119-121):

```ts
// DELETE these three lines — function is no longer called anywhere:
function buildOutputInstruction(title: string, sections: readonly string[]): string {
  return joinNonEmpty([title, ...sections]);
}
```

- [ ] **Step 4: Verify tests pass and knip is clean**

```bash
node scripts/tasks.mjs
```

Expected: full suite passes — format, lint, type-check, knip (no unused exports/symbols), test, build all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-prompts.ts __tests__/lib/model-prompts.test.ts
git commit -m "refactor: restructure buildErrorDiagnosisPrompt sections and remove buildOutputInstruction"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — All model-prompts tests pass after each task

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/model-prompts.test.ts
```

### [`VAL-002`](#5-testing--validation) — Full check suite passes after TASK-008

```bash
node scripts/tasks.mjs
```

Expected: format → lint → type-check → knip → test → build all pass. No unused symbol warnings from knip (`buildOutputInstruction` deleted).

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                             |
| :--------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | ------- | --- | ------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | `DEFAULT_SYSTEM_INSTRUCTION` contains all four rules: table policy, heading policy, citation format, three noise anti-patterns. Verified by reading `src/client.ts:49`.        |
| [`AC-002`](#6-acceptance-criteria) | `buildAgenticResearchPrompt` systemInstruction includes the literal strings `## Summary`, `## Findings`, `## Sources` for both googleSearch=true and googleSearch=false paths. |
| [`AC-003`](#6-acceptance-criteria) | `buildDiffReviewPrompt` review-mode systemInstruction includes `                                                                                                               | Severity | File | Finding | Fix | `and does NOT contain`Findings\n\nFixes` prose headers. |
| [`AC-004`](#6-acceptance-criteria) | `buildFileAnalysisPrompt` single, url, and multi modes each include `## Answer` and `## References` in their systemInstruction.                                                |
| [`AC-005`](#6-acceptance-criteria) | `buildErrorDiagnosisPrompt` systemInstruction includes `## Cause — most likely root cause` (inline description, not bare heading) for both googleSearch paths.                 |
| [`AC-006`](#6-acceptance-criteria) | `buildOutputInstruction` private function does not exist in `src/lib/model-prompts.ts`.                                                                                        |
| [`AC-007`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 with no failures.                                                                                                                             |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                                                                       |
| :---------------------------: | :--: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`NOTE-001`](#7-risks--notes) | Note | `cacheText` values in `buildDiffReviewPrompt` and `buildErrorDiagnosisPrompt` are intentionally unchanged — they are cache-key hints asserted by existing tests via `promptParts` and `promptText.startsWith()`. Do not modify them.                                                                                                                         |
| [`NOTE-002`](#7-risks--notes) | Note | `joinNonEmpty` joins with `'\n\n'`, producing a blank line between each item. This is intentional — Markdown parsers treat double newlines as paragraph breaks, giving visual separation between instruction clauses.                                                                                                                                        |
| [`NOTE-003`](#7-risks--notes) | Note | The `docInstruction` variable in `buildDiffReviewPrompt` review mode is a local string (empty string or a space-prefixed sentence). Template-literal interpolation `${docInstruction}` at the end of the systemInstruction string is correct — no joinNonEmpty needed here since docInstruction is either empty or a continuation of the preceding sentence. |
| [`RISK-001`](#7-risks--notes) | Risk | If knip flags `joinNonEmpty` as newly unused after `buildOutputInstruction` is deleted, check — `joinNonEmpty` is still called in multiple builders. It is not exported and should remain.                                                                                                                                                                   |
