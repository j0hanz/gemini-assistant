---
goal: Strip token-noisy fields from all four tool output schemas so every response is shaped exclusively for LLM orchestrator consumption
version: 1
date_created: 2026-04-29
status: Planned
plan_type: refactor
component: llm-optimized-responses
execution: subagent-driven
---

# Implementation Plan: LLM-Optimized Response Payloads

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Remove all token-noisy fields from tool output schemas and handlers so LLM orchestrators receive only signal-bearing data on every call.

**Architecture:** Four sequential phases — schema layer first (breaks TypeScript, guides handler fixes), then response.ts helpers, then handler cleanup per tool, then input description trimming. Each phase produces a compilable, test-passing state before the next begins.

**Tech Stack:** TypeScript strict mode, Zod v4 (`zod/v4`), Node.js built-in test runner with `tsx/esm`, `node scripts/tasks.mjs` orchestration.

---

## 1. Goal

MCP tool responses from `gemini-assistant` are consumed by LLM orchestrators where every token has cost. The current outputs carry diagnostics blocks, redundant URL arrays, echo discriminators, telemetry metadata, path lists, and empty arrays — none of which an LLM can act on. This plan removes that noise permanently. The result: each tool emits only its core answer plus optional `sourceDetails`, `findings`, `stats`, `documentationDrift`, `session.id`, and `warnings`. The full design is in [docs/specs/2026-04-29-llm-optimized-responses-design.md](docs/specs/2026-04-29-llm-optimized-responses-design.md).

## 2. Requirements & Constraints

| ID                                        | Type        | Statement                                                                                                                                                                                                                                                   |
| :---------------------------------------- | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `publicCoreOutputFields` retains only `warnings`. `requestId` and `diagnostics` are removed.                                                                                                                                                                |
| [`REQ-002`](#2-requirements--constraints) | Requirement | `ChatOutputSchema` session object contains only `id`. `computations`, `workspaceCacheApplied`, `contextUsed` removed.                                                                                                                                       |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `ResearchOutputSchema` is a single flat schema with `status`, `summary`, `sourceDetails?`, `findings?`. All URL arrays, `groundingSignals`, `citations`, `computations`, `toolsUsed`, `mode` removed.                                                       |
| [`REQ-004`](#2-requirements--constraints) | Requirement | `AnalyzeOutputSchema` is a single flat schema. `kind`, `targetKind`, `groundingSignals`, `urlMetadata`, `analyzedPaths`, `contextUsed` removed.                                                                                                             |
| [`REQ-005`](#2-requirements--constraints) | Requirement | `ReviewOutputSchema` retains only `status`, `summary`, `stats?`, `documentationDrift?`, `warnings?`. The six path arrays, `subjectKind`, `schemaWarnings`, `truncated`, `empty`, `contextUsed` removed; `truncated`/`empty` signals move into `warnings[]`. |
| [`REQ-006`](#2-requirements--constraints) | Requirement | `buildBaseStructuredOutput` no longer accepts or emits `requestId`.                                                                                                                                                                                         |
| [`REQ-007`](#2-requirements--constraints) | Requirement | `buildSharedStructuredMetadata` no longer accepts or emits `contextUsed` or `diagnostics`.                                                                                                                                                                  |
| [`REQ-008`](#2-requirements--constraints) | Requirement | `buildSuccessfulStructuredContent` applies `stripEmpty` — null, undefined, and empty arrays are never serialized.                                                                                                                                           |
| [`REQ-009`](#2-requirements--constraints) | Requirement | Variant-schema field descriptions in `inputs.ts` drop "Allowed only when X=Y" policy prose.                                                                                                                                                                 |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No opt-in flags. Always minimal — one shape per tool, no tiers.                                                                                                                                                                                             |
| [`CON-002`](#2-requirements--constraints) | Constraint  | All schemas use `z.strictObject()`. Unknown keys are rejected.                                                                                                                                                                                              |
| [`CON-003`](#2-requirements--constraints) | Constraint  | Breaking change — no backward-compatibility shims.                                                                                                                                                                                                          |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [pickDefined](src/lib/response.ts#L37) pattern for filtering undefined values in output objects.                                                                                                                                                     |

## 3. Current Context

### File structure

| File                                                                   | Status | Responsibility                                                                                                                            |
| :--------------------------------------------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| [src/schemas/fields.ts](src/schemas/fields.ts)                         | Modify | Remove `requestId` and `diagnostics` from `publicCoreOutputFields`; delete `DiagnosticsSchema`                                            |
| [src/schemas/outputs.ts](src/schemas/outputs.ts)                       | Modify | Slim all four tool output schemas per design; remove `ContextUsedSchema`, `SessionResourceLinksSchema`, `ComputationSchema`               |
| [src/schemas/inputs.ts](src/schemas/inputs.ts)                         | Modify | Strip "Allowed only when X=Y" prose from variant-schema field descriptions                                                                |
| [src/lib/response.ts](src/lib/response.ts)                             | Modify | Remove `requestId` from `buildBaseStructuredOutput`; strip diagnostics/contextUsed from `buildSharedStructuredMetadata`; add `stripEmpty` |
| [src/tools/research.ts](src/tools/research.ts)                         | Modify | Stop populating removed output fields; remove `requestId` from call                                                                       |
| [src/tools/analyze.ts](src/tools/analyze.ts)                           | Modify | Stop populating removed output fields; remove `requestId`, `kind`, `targetKind`, `groundingSignals`, `urlMetadata`, `analyzedPaths`       |
| [src/tools/review.ts](src/tools/review.ts)                             | Modify | Fold `truncated`/`empty`/`schemaWarnings` into `warnings[]`; remove 6 path arrays, `subjectKind`, `requestId`                             |
| [src/tools/chat.ts](src/tools/chat.ts)                                 | Modify | Remove `contextUsed`, `computations`, `workspaceCacheApplied`, `schemaWarnings`; simplify session to `{id}`                               |
| [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts) | Modify | Rewrite to assert new slim schemas; remove tests for deleted fields                                                                       |
| [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts)       | Modify | Update tests for modified `buildBaseStructuredOutput` and `buildSharedStructuredMetadata`; add `stripEmpty` tests                         |
| [**tests**/tools/research.test.ts](__tests__/tools/research.test.ts)   | Modify | Remove assertions for deleted research output fields                                                                                      |
| [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts)             | Modify | Remove assertions for deleted chat output fields                                                                                          |

### Relevant symbols

| Symbol                                                        | Why it matters                                                                                        |
| :------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------- |
| [publicCoreOutputFields](src/schemas/fields.ts#L476)          | Shared base for all tool outputs — removing `requestId` and `diagnostics` here affects all four tools |
| [DiagnosticsSchema](src/schemas/fields.ts#L442)               | Being deleted; must verify no other references remain                                                 |
| [ChatOutputSchema](src/schemas/outputs.ts#L99)                | Session must shrink to `{id}`; three fields removed                                                   |
| [SessionResourceLinksSchema](src/schemas/outputs.ts#L89)      | Being deleted; only used in `ChatOutputSchema`                                                        |
| [ComputationSchema](src/schemas/outputs.ts#L54)               | Being deleted; only used in `ChatOutputSchema` and `ResearchDeepOutputSchema`                         |
| [ContextUsedSchema](src/schemas/outputs.ts#L37)               | Being deleted from outputs; handlers must stop building `ContextUsed` objects                         |
| [ResearchOutputSchema](src/schemas/outputs.ts#L176)           | Discriminated union replaced with flat schema                                                         |
| [ResearchSharedFields](src/schemas/outputs.ts#L130)           | Deleted; fields collapsed into single flat schema                                                     |
| [AnalyzeOutputSchema](src/schemas/outputs.ts#L181)            | Discriminated union replaced with flat schema                                                         |
| [AnalyzeSummaryOutputSchema](src/schemas/outputs.ts#L62)      | Deleted; merged into flat `AnalyzeOutputSchema`                                                       |
| [AnalyzeDiagramOutputSchema](src/schemas/outputs.ts#L74)      | Deleted; merged into flat `AnalyzeOutputSchema`                                                       |
| [ReviewOutputSchema](src/schemas/outputs.ts#L192)             | Loses 9 fields; gains warning-based signal for truncation                                             |
| [DocumentationDriftSchema](src/schemas/outputs.ts#L186)       | Kept — `documentationDrift` survives in Review output                                                 |
| [buildBaseStructuredOutput](src/lib/response.ts#L463)         | Remove `requestId` parameter and return value                                                         |
| [buildSharedStructuredMetadata](src/lib/response.ts#L411)     | Remove `contextUsed`/`diagnostics` params; return only `warnings`                                     |
| [SHARED_STRUCTURED_RESULT_KEYS](src/lib/response.ts#L478)     | Drop `contextUsed` and `diagnostics` from the tuple                                                   |
| [buildSuccessfulStructuredContent](src/lib/response.ts#L519)  | Remove `requestId` param; apply `stripEmpty` to final object                                          |
| [buildResearchStructuredContent](src/tools/research.ts#L1105) | Remove all deleted field assignments                                                                  |
| [buildAnalyzeStructuredContent](src/tools/analyze.ts#L467)    | Remove all deleted field assignments                                                                  |
| [buildReviewStructuredContent](src/tools/review.ts#L1380)     | Fold `truncated`/`empty`/`schemaWarnings` into `warnings[]`; remove path arrays                       |
| [attachContextUsed](src/tools/chat.ts#L341)                   | Delete this function entirely                                                                         |
| [appendAskWarnings](src/tools/chat.ts#L227)                   | Update to stop referencing `schemaWarnings` from structured content                                   |

### Existing commands

```bash
# Run a single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts

# Static checks (lint + type-check + knip; no tests)
node scripts/tasks.mjs --quick

# Full suite
node scripts/tasks.mjs
```

### Current behavior

The four tool outputs contain diagnostics blocks (thoughts, usage, safetyRatings, toolEvents), redundant URL arrays (`sources`, `urlContextSources`, `urlMetadata` alongside `sourceDetails`), echo discriminators (`mode`, `kind`, `targetKind`, `subjectKind`), internal path lists (6 arrays in Review), and low-signal metadata (`requestId`, `contextUsed`, `workspaceCacheApplied`, `computations`, `citations`). These fields appear in every response regardless of whether the LLM orchestrator can use them.

## 4. Implementation Phases

### PHASE-001: Output schema cleanup

**Goal:** All four tool output schemas reflect the slim design; TypeScript compilation guides handler changes in later phases.

| Task                                                                                 | Action                                              | Depends on                                                                           | Files                                            | Validate                         |
| :----------------------------------------------------------------------------------- | :-------------------------------------------------- | :----------------------------------------------------------------------------------- | :----------------------------------------------- | :------------------------------- |
| [`TASK-001`](#task-001-remove-requestid-and-diagnostics-from-publiccoreoutputfields) | Remove `requestId` + `diagnostics` from shared base | none                                                                                 | [src/schemas/fields.ts](src/schemas/fields.ts)   | `node scripts/tasks.mjs --quick` |
| [`TASK-002`](#task-002-slim-chatoutputschema)                                        | Slim `ChatOutputSchema`                             | [`TASK-001`](#task-001-remove-requestid-and-diagnostics-from-publiccoreoutputfields) | [src/schemas/outputs.ts](src/schemas/outputs.ts) | `node scripts/tasks.mjs --quick` |
| [`TASK-003`](#task-003-flatten-researchoutputschema)                                 | Flatten `ResearchOutputSchema`                      | [`TASK-002`](#task-002-slim-chatoutputschema)                                        | [src/schemas/outputs.ts](src/schemas/outputs.ts) | `node scripts/tasks.mjs --quick` |
| [`TASK-004`](#task-004-flatten-analyzeoutputschema)                                  | Flatten `AnalyzeOutputSchema`                       | [`TASK-003`](#task-003-flatten-researchoutputschema)                                 | [src/schemas/outputs.ts](src/schemas/outputs.ts) | `node scripts/tasks.mjs --quick` |
| [`TASK-005`](#task-005-slim-reviewoutputschema)                                      | Slim `ReviewOutputSchema`                           | [`TASK-004`](#task-004-flatten-analyzeoutputschema)                                  | [src/schemas/outputs.ts](src/schemas/outputs.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-001: Remove requestId and diagnostics from publicCoreOutputFields

| Field      | Value                                                                                                                                  |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                   |
| Files      | Modify: [src/schemas/fields.ts](src/schemas/fields.ts); Modify: [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts) |
| Symbols    | [publicCoreOutputFields](src/schemas/fields.ts#L476), [DiagnosticsSchema](src/schemas/fields.ts#L442)                                  |
| Outcome    | `publicCoreOutputFields` contains only `warnings`. `DiagnosticsSchema` is deleted. All existing tests still compile.                   |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/schemas/outputs.test.ts — add inside the existing describe block or at top-level
import { ChatOutputSchema } from '../../src/schemas/outputs.js';

it('ChatOutputSchema rejects requestId as unknown key', () => {
  const result = ChatOutputSchema.safeParse({
    status: 'completed',
    answer: 'hello',
    requestId: 'task-123',
  });
  assert.strictEqual(result.success, false);
});

it('ChatOutputSchema rejects diagnostics as unknown key', () => {
  const result = ChatOutputSchema.safeParse({
    status: 'completed',
    answer: 'hello',
    diagnostics: { usage: { totalTokenCount: 100 } },
  });
  assert.strictEqual(result.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — both assertions fail because `strictObject` currently allows `requestId` and `diagnostics` via `publicCoreOutputFields`.

- [ ] **Step 3: Remove requestId and diagnostics from publicCoreOutputFields**

In [src/schemas/fields.ts](src/schemas/fields.ts), replace lines 476–480:

```ts
// src/schemas/fields.ts
export const publicCoreOutputFields = {
  warnings: z.array(z.string()).describe('Non-fatal warnings for the result').optional(),
};
```

Then delete `DiagnosticsSchema` (lines 442–466) and its associated helper types/interfaces that are only used internally by `DiagnosticsSchema` (check with `grep -n "DiagnosticsSchema\|ToolEventSchema\|ToolEventKind\|toolEventFields\|FunctionCallEntry" src/schemas/fields.ts`). Keep `ToolEventSchema`/`FunctionCallEntrySchema` only if referenced outside `DiagnosticsSchema`.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: PASS for the two new tests. Other tests may show TypeScript errors surfaced by `--quick` — fix those in the same step by removing references to `diagnostics` and `requestId` in existing test assertions (search: `grep -n "diagnostics\|requestId" __tests__/schemas/outputs.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/fields.ts __tests__/schemas/outputs.test.ts
git commit -m "refactor: remove requestId and diagnostics from publicCoreOutputFields"
```

---

#### TASK-002: Slim ChatOutputSchema

| Field      | Value                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-remove-requestid-and-diagnostics-from-publiccoreoutputfields)                                                                      |
| Files      | Modify: [src/schemas/outputs.ts](src/schemas/outputs.ts); Modify: [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts)                  |
| Symbols    | [ChatOutputSchema](src/schemas/outputs.ts#L99), [SessionResourceLinksSchema](src/schemas/outputs.ts#L89), [ComputationSchema](src/schemas/outputs.ts#L54) |
| Outcome    | `ChatOutputSchema` has only `status`, `answer`, `data?`, `session?{id}`, `warnings?`. `SessionResourceLinksSchema` and `ComputationSchema` deleted.       |

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/schemas/outputs.test.ts
it('ChatOutputSchema rejects computations', () => {
  const result = ChatOutputSchema.safeParse({
    status: 'completed',
    answer: 'hello',
    computations: [{ code: 'print(1)', language: 'python' }],
  });
  assert.strictEqual(result.success, false);
});

it('ChatOutputSchema rejects workspaceCacheApplied', () => {
  const result = ChatOutputSchema.safeParse({
    status: 'completed',
    answer: 'hello',
    workspaceCacheApplied: true,
  });
  assert.strictEqual(result.success, false);
});

it('ChatOutputSchema rejects session with resources', () => {
  const result = ChatOutputSchema.safeParse({
    status: 'completed',
    answer: 'hello',
    session: { id: 'abc', resources: { detail: 'gemini://sessions/abc' } },
  });
  assert.strictEqual(result.success, false);
});

it('ChatOutputSchema accepts session with id only', () => {
  const result = ChatOutputSchema.safeParse({
    status: 'completed',
    answer: 'hello',
    session: { id: 'abc' },
  });
  assert.ok(result.success);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — first three assertions fail because those fields are currently accepted.

- [ ] **Step 3: Rewrite ChatOutputSchema**

In [src/schemas/outputs.ts](src/schemas/outputs.ts), replace the `ChatOutputSchema` definition. Also delete `SessionResourceLinksSchema` (lines 89–97) and `ComputationSchema` (lines 54–61) since they become unused. Delete `ContextSourceReportSchema` (lines 27–33) and `ContextUsedSchema` (lines 37–45) if they have no remaining uses (check with `grep -rn "ContextUsed\|ContextSource" src/`):

```ts
// src/schemas/outputs.ts
export const ChatOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: completedStatusField,
  answer: z.string().describe('Chat response text'),
  data: JsonValueSchema.describe('Structured response payload when JSON mode is used').optional(),
  session: z
    .strictObject({
      id: z.string().describe('Server-managed session identifier'),
    })
    .optional()
    .describe('Session metadata. Provide id to continue this session in a future call.'),
});
```

Remove `JsonValueSchema` from imports if it is no longer used elsewhere (it is used for `data` — keep it). Remove `ContextUsedSchema`, `ContextUsed` from exports. Update the import/export list at the top of the file accordingly.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: PASS. Fix any remaining test references to `workspaceCacheApplied`, `computations`, `session.resources`, `session.rebuiltAt` in the test file.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/outputs.ts __tests__/schemas/outputs.test.ts
git commit -m "refactor: slim ChatOutputSchema to status/answer/data/session.id"
```

---

#### TASK-003: Flatten ResearchOutputSchema

| Field      | Value                                                                                                                                                                                                                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-slim-chatoutputschema)                                                                                                                                                                                                                                                                              |
| Files      | Modify: [src/schemas/outputs.ts](src/schemas/outputs.ts); Modify: [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts)                                                                                                                                                                                   |
| Symbols    | [ResearchOutputSchema](src/schemas/outputs.ts#L176), [ResearchSharedFields](src/schemas/outputs.ts#L130), [ResearchQuickOutputSchema](src/schemas/outputs.ts#L153), [ResearchDeepOutputSchema](src/schemas/outputs.ts#L158), [FindingSchema](src/schemas/fields.ts#L524), [SourceDetailSchema](src/schemas/fields.ts#L510) |
| Outcome    | `ResearchOutputSchema` is a single `z.strictObject` with `status`, `summary`, `sourceDetails?`, `findings?`, `warnings?`. Discriminated union and `mode` field removed.                                                                                                                                                    |

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/schemas/outputs.test.ts
it('ResearchOutputSchema rejects mode field', () => {
  const result = ResearchOutputSchema.safeParse({
    status: 'grounded',
    mode: 'quick',
    summary: 'Answer',
  });
  assert.strictEqual(result.success, false);
});

it('ResearchOutputSchema rejects sources array', () => {
  const result = ResearchOutputSchema.safeParse({
    status: 'grounded',
    summary: 'Answer',
    sources: ['https://example.com'],
  });
  assert.strictEqual(result.success, false);
});

it('ResearchOutputSchema rejects groundingSignals', () => {
  const result = ResearchOutputSchema.safeParse({
    status: 'grounded',
    summary: 'Answer',
    groundingSignals: {
      retrievalPerformed: true,
      urlContextUsed: false,
      groundingSupportsCount: 0,
      confidence: 'low',
    },
  });
  assert.strictEqual(result.success, false);
});

it('ResearchOutputSchema accepts status + summary + sourceDetails + findings', () => {
  const result = ResearchOutputSchema.safeParse({
    status: 'grounded',
    summary: 'Answer',
    sourceDetails: [{ url: 'https://example.com', domain: 'example.com', origin: 'googleSearch' }],
    findings: [
      { claim: 'Fact', supportingSourceUrls: ['https://example.com'], verificationStatus: 'cited' },
    ],
  });
  assert.ok(result.success);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — `mode`, `sources`, `groundingSignals` are currently accepted.

- [ ] **Step 3: Replace ResearchOutputSchema with flat schema**

In [src/schemas/outputs.ts](src/schemas/outputs.ts), delete `ResearchSharedFields`, `ResearchQuickOutputSchema`, `ResearchDeepOutputSchema` and replace with:

```ts
// src/schemas/outputs.ts
export const ResearchOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: groundingStatusField,
  summary: z.string().describe('Grounded research summary'),
  sourceDetails: z
    .array(SourceDetailSchema)
    .optional()
    .describe('Structured source entries for client consumption'),
  findings: z
    .array(FindingSchema)
    .optional()
    .describe('Claim-level findings attributed to retrieved sources; not independent proof'),
});
```

Update the import list: remove `publicHttpUrlArray` if no longer used after this change (check all usages with `grep -n "publicHttpUrlArray" src/schemas/outputs.ts`).

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: PASS. Fix any remaining test assertions referencing `sources`, `mode`, `citations`, `computations`, `toolsUsed`, `urlMetadata`, `urlContextSources`, `groundingSignals` in the research test block.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/outputs.ts __tests__/schemas/outputs.test.ts
git commit -m "refactor: flatten ResearchOutputSchema to status/summary/sourceDetails/findings"
```

---

#### TASK-004: Flatten AnalyzeOutputSchema

| Field      | Value                                                                                                                                                                                                                       |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-flatten-researchoutputschema)                                                                                                                                                                        |
| Files      | Modify: [src/schemas/outputs.ts](src/schemas/outputs.ts); Modify: [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts)                                                                                    |
| Symbols    | [AnalyzeOutputSchema](src/schemas/outputs.ts#L181), [AnalyzeSummaryOutputSchema](src/schemas/outputs.ts#L62), [AnalyzeDiagramOutputSchema](src/schemas/outputs.ts#L74)                                                      |
| Outcome    | `AnalyzeOutputSchema` is a single `z.strictObject`. `kind`, `targetKind`, `groundingSignals`, `urlMetadata`, `analyzedPaths`, `contextUsed` removed. `AnalyzeSummaryOutputSchema` and `AnalyzeDiagramOutputSchema` deleted. |

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/schemas/outputs.test.ts
it('AnalyzeOutputSchema rejects kind field', () => {
  const result = AnalyzeOutputSchema.safeParse({
    status: 'ungrounded',
    summary: 'File analysis',
    kind: 'summary',
  });
  assert.strictEqual(result.success, false);
});

it('AnalyzeOutputSchema rejects targetKind field', () => {
  const result = AnalyzeOutputSchema.safeParse({
    status: 'ungrounded',
    summary: 'File analysis',
    targetKind: 'file',
  });
  assert.strictEqual(result.success, false);
});

it('AnalyzeOutputSchema accepts summary-mode payload', () => {
  const result = AnalyzeOutputSchema.safeParse({
    status: 'ungrounded',
    summary: 'File analysis result',
  });
  assert.ok(result.success);
});

it('AnalyzeOutputSchema accepts diagram-mode payload', () => {
  const result = AnalyzeOutputSchema.safeParse({
    status: 'completed',
    diagramType: 'mermaid',
    diagram: 'flowchart TD\nA-->B',
    syntaxValid: true,
  });
  assert.ok(result.success);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — `kind` and `targetKind` are currently accepted (required, in fact).

- [ ] **Step 3: Replace AnalyzeOutputSchema with flat schema**

In [src/schemas/outputs.ts](src/schemas/outputs.ts), delete `AnalyzeSummaryOutputSchema` and `AnalyzeDiagramOutputSchema`, replace `AnalyzeOutputSchema` with:

```ts
// src/schemas/outputs.ts
export const AnalyzeOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: z
    .enum(['grounded', 'partially_grounded', 'ungrounded', 'completed'])
    .describe('Grounding or completion status'),
  summary: z.string().optional().describe('Analysis summary text (summary mode)'),
  diagramType: enumField(DIAGRAM_TYPES, 'Diagram syntax used (diagram mode)').optional(),
  diagram: z.string().optional().describe('Generated diagram source (diagram mode)'),
  explanation: z.string().optional().describe('Short explanation or caveats for the diagram'),
  syntaxErrors: z.array(z.string()).optional().describe('Diagram syntax validation errors'),
  syntaxValid: z.boolean().optional().describe('Whether diagram syntax validated successfully'),
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: PASS. Fix any remaining test assertions for `kind`, `targetKind`, `groundingSignals`, `urlMetadata`, `analyzedPaths` in the analyze test block.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/outputs.ts __tests__/schemas/outputs.test.ts
git commit -m "refactor: flatten AnalyzeOutputSchema; remove kind/targetKind/groundingSignals/urlMetadata"
```

---

#### TASK-005: Slim ReviewOutputSchema

| Field      | Value                                                                                                                                    |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-004`](#task-004-flatten-analyzeoutputschema)                                                                                      |
| Files      | Modify: [src/schemas/outputs.ts](src/schemas/outputs.ts); Modify: [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts) |
| Symbols    | [ReviewOutputSchema](src/schemas/outputs.ts#L192), [DocumentationDriftSchema](src/schemas/outputs.ts#L186)                               |
| Outcome    | `ReviewOutputSchema` has only `status`, `summary`, `stats?`, `documentationDrift?`, `warnings?`. Nine fields removed.                    |

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/schemas/outputs.test.ts
it('ReviewOutputSchema rejects subjectKind', () => {
  const result = ReviewOutputSchema.safeParse({
    status: 'completed',
    summary: 'LGTM',
    subjectKind: 'diff',
  });
  assert.strictEqual(result.success, false);
});

it('ReviewOutputSchema rejects reviewedPaths', () => {
  const result = ReviewOutputSchema.safeParse({
    status: 'completed',
    summary: 'LGTM',
    reviewedPaths: ['src/index.ts'],
  });
  assert.strictEqual(result.success, false);
});

it('ReviewOutputSchema rejects truncated boolean', () => {
  const result = ReviewOutputSchema.safeParse({
    status: 'completed',
    summary: 'LGTM',
    truncated: true,
  });
  assert.strictEqual(result.success, false);
});

it('ReviewOutputSchema accepts minimal payload', () => {
  const result = ReviewOutputSchema.safeParse({
    status: 'completed',
    summary: 'LGTM',
  });
  assert.ok(result.success);
});

it('ReviewOutputSchema accepts warnings array for truncation signal', () => {
  const result = ReviewOutputSchema.safeParse({
    status: 'completed',
    summary: 'Review truncated',
    warnings: ['Diff was truncated: 5 paths omitted due to size limit.'],
  });
  assert.ok(result.success);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — `subjectKind`, `reviewedPaths`, `truncated` are currently accepted.

- [ ] **Step 3: Rewrite ReviewOutputSchema**

In [src/schemas/outputs.ts](src/schemas/outputs.ts), replace `ReviewOutputSchema`:

```ts
// src/schemas/outputs.ts
export const ReviewOutputSchema = z.strictObject({
  ...publicCoreOutputFields,
  status: completedStatusField,
  summary: z.string().describe('Review result summary'),
  stats: z
    .strictObject(diffStatsFields)
    .optional()
    .describe('Diff statistics when subjectKind=diff'),
  documentationDrift: z
    .array(DocumentationDriftSchema)
    .optional()
    .describe('Factual documentation drifts caused by the diff. Omitted if no drift is detected.'),
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: PASS. Fix any remaining test assertions for `subjectKind`, `schemaWarnings`, `reviewedPaths`, `includedUntracked`, `skippedBinaryPaths`, `skippedLargePaths`, `skippedSensitivePaths`, `omittedPaths`, `truncated`, `empty` in the review test block.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/outputs.ts __tests__/schemas/outputs.test.ts
git commit -m "refactor: slim ReviewOutputSchema; truncated/empty move to warnings[]"
```

---

### PHASE-002: response.ts helper cleanup

**Goal:** `buildBaseStructuredOutput` drops `requestId`; `buildSharedStructuredMetadata` drops `contextUsed` and `diagnostics`; `stripEmpty` removes null/undefined/empty-array keys from every output.

| Task                                                                           | Action                                      | Depends on                                                                     | Files                                      | Validate                         |
| :----------------------------------------------------------------------------- | :------------------------------------------ | :----------------------------------------------------------------------------- | :----------------------------------------- | :------------------------------- |
| [`TASK-006`](#task-006-remove-requestid-and-diagnostics-from-response-helpers) | Remove `requestId`/diagnostics from helpers | [`TASK-005`](#task-005-slim-reviewoutputschema)                                | [src/lib/response.ts](src/lib/response.ts) | `node scripts/tasks.mjs --quick` |
| [`TASK-007`](#task-007-add-stripempty-to-buildsuccessfulstructuredcontent)     | Add `stripEmpty`                            | [`TASK-006`](#task-006-remove-requestid-and-diagnostics-from-response-helpers) | [src/lib/response.ts](src/lib/response.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-006: Remove requestId and diagnostics from response helpers

| Field      | Value                                                                                                                                                                                                                                     |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-slim-reviewoutputschema)                                                                                                                                                                                           |
| Files      | Modify: [src/lib/response.ts](src/lib/response.ts); Modify: [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts)                                                                                                              |
| Symbols    | [buildBaseStructuredOutput](src/lib/response.ts#L463), [buildSharedStructuredMetadata](src/lib/response.ts#L411), [SHARED_STRUCTURED_RESULT_KEYS](src/lib/response.ts#L478), [buildSuccessfulStructuredContent](src/lib/response.ts#L519) |
| Outcome    | `buildBaseStructuredOutput` no longer takes or emits `requestId`. `buildSharedStructuredMetadata` accepts only `warnings`. `SHARED_STRUCTURED_RESULT_KEYS` contains only `'warnings'`.                                                    |

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/lib/response.test.ts
import {
  buildBaseStructuredOutput,
  buildSharedStructuredMetadata,
} from '../../src/lib/response.js';

it('buildBaseStructuredOutput does not emit requestId', () => {
  const result = buildBaseStructuredOutput(['warn']);
  assert.ok(!('requestId' in result));
  assert.strictEqual(result.status, 'completed');
});

it('buildSharedStructuredMetadata does not emit diagnostics', () => {
  const result = buildSharedStructuredMetadata({ warnings: ['w1'] });
  assert.ok(!('diagnostics' in result));
  assert.deepStrictEqual(result.warnings, ['w1']);
});

it('buildSharedStructuredMetadata does not emit contextUsed', () => {
  const result = buildSharedStructuredMetadata({ warnings: [] });
  assert.ok(!('contextUsed' in result));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: FAIL — `buildBaseStructuredOutput` currently takes `requestId` as first arg; `buildSharedStructuredMetadata` currently emits `diagnostics` and `contextUsed`.

- [ ] **Step 3: Rewrite the three helpers**

In [src/lib/response.ts](src/lib/response.ts):

**Replace `buildBaseStructuredOutput` (line 463):**

```ts
export function buildBaseStructuredOutput(warnings?: readonly string[]): {
  status: 'completed';
  warnings?: string[];
} {
  return pickDefined({
    status: 'completed' as const,
    warnings: warnings && warnings.length > 0 ? [...warnings] : undefined,
  });
}
```

**Replace `SHARED_STRUCTURED_RESULT_KEYS` (line 478):**

```ts
const SHARED_STRUCTURED_RESULT_KEYS = ['warnings'] as const;
```

**Replace `SharedStructuredMetadata` interface and `buildSharedStructuredMetadata` (line 411):**

```ts
interface SharedStructuredMetadata {
  warnings?: string[];
}

export function buildSharedStructuredMetadata({
  warnings,
}: {
  warnings?: readonly string[];
}): SharedStructuredMetadata {
  return pickDefined({
    warnings: warnings && warnings.length > 0 ? [...warnings] : undefined,
  });
}
```

Also delete the now-unused `SharedStructuredDiagnostics` interface and all parameters that were only forwarded to diagnostics (`thoughtText`, `includeThoughts`, `toolEvents`, `functionCalls`, `usage`, `safetyRatings`, `finishMessage`, `citationMetadata`, `groundingMetadata`, `urlContextMetadata`).

Remove `contextUsed` from `buildSuccessfulStructuredContent` parameters (line 519):

```ts
export function buildSuccessfulStructuredContent<TDomain extends Record<string, unknown>>({
  warnings,
  domain,
  shared,
}: {
  warnings?: readonly string[] | undefined;
  domain: TDomain;
  shared?: Record<string, unknown> | undefined;
}): TDomain & ReturnType<typeof buildBaseStructuredOutput> & Record<string, unknown> {
  return pickDefined({
    ...buildBaseStructuredOutput(warnings),
    ...domain,
    ...(shared ? pickSharedStructuredResultFields(shared) : {}),
  }) as TDomain & ReturnType<typeof buildBaseStructuredOutput> & Record<string, unknown>;
}
```

Remove unused imports (`ContextUsed`, `ToolEvent`, `UsageMetadata` if they are only used in the removed code — verify with `grep -n "ContextUsed\|ToolEvent\|UsageMetadata" src/lib/response.ts` after editing).

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: type-check and lint pass. Run response tests:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: PASS. Fix any existing test that passed `requestId` as first arg to `buildBaseStructuredOutput` or passed `diagnostics`/`contextUsed`/`functionCalls`/`toolEvents` to `buildSharedStructuredMetadata`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/response.ts __tests__/lib/response.test.ts
git commit -m "refactor: remove requestId/diagnostics/contextUsed from response helpers"
```

---

#### TASK-007: Add stripEmpty to buildSuccessfulStructuredContent

| Field      | Value                                                                                                                        |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-006`](#task-006-remove-requestid-and-diagnostics-from-response-helpers)                                               |
| Files      | Modify: [src/lib/response.ts](src/lib/response.ts); Modify: [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts) |
| Symbols    | [buildSuccessfulStructuredContent](src/lib/response.ts#L519), [pickDefined](src/lib/response.ts#L37)                         |
| Outcome    | `buildSuccessfulStructuredContent` never emits `null`, `undefined`, or `[]` values. `stripEmpty` is exported for testing.    |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/response.test.ts
import { buildSuccessfulStructuredContent } from '../../src/lib/response.js';

it('buildSuccessfulStructuredContent strips empty arrays', () => {
  const result = buildSuccessfulStructuredContent({
    warnings: undefined,
    domain: { status: 'completed' as const, summary: 'ok', sourceDetails: [] },
  });
  assert.ok(!('sourceDetails' in result), 'empty sourceDetails must be stripped');
});

it('buildSuccessfulStructuredContent strips null values', () => {
  const result = buildSuccessfulStructuredContent({
    warnings: undefined,
    domain: { status: 'completed' as const, summary: 'ok', explanation: null as unknown as string },
  });
  assert.ok(!('explanation' in result), 'null explanation must be stripped');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: FAIL — `sourceDetails: []` and `explanation: null` currently pass through.

- [ ] **Step 3: Add stripEmpty and wire it in**

In [src/lib/response.ts](src/lib/response.ts), add after `pickDefined` (line 41):

```ts
export function stripEmpty(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmpty);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      result[k] = stripEmpty(v);
    }
    return result;
  }
  return obj;
}
```

Then in `buildSuccessfulStructuredContent`, apply it to the merged output:

```ts
export function buildSuccessfulStructuredContent<TDomain extends Record<string, unknown>>({
  warnings,
  domain,
  shared,
}: {
  warnings?: readonly string[] | undefined;
  domain: TDomain;
  shared?: Record<string, unknown> | undefined;
}): TDomain & ReturnType<typeof buildBaseStructuredOutput> & Record<string, unknown> {
  const merged = pickDefined({
    ...buildBaseStructuredOutput(warnings),
    ...domain,
    ...(shared ? pickSharedStructuredResultFields(shared) : {}),
  });
  return stripEmpty(merged) as TDomain &
    ReturnType<typeof buildBaseStructuredOutput> &
    Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/response.ts __tests__/lib/response.test.ts
git commit -m "feat: add stripEmpty; apply to buildSuccessfulStructuredContent output"
```

---

### PHASE-003: Handler cleanup

**Goal:** All four tool handlers stop populating removed output fields. TypeScript compilation is the guide — fix every `TS2353` (unknown property) and `TS2345` (argument mismatch) error introduced by PHASE-001 and PHASE-002.

| Task                                                            | Action                                                                  | Depends on                                                                 | Files                                          | Validate                         |
| :-------------------------------------------------------------- | :---------------------------------------------------------------------- | :------------------------------------------------------------------------- | :--------------------------------------------- | :------------------------------- |
| [`TASK-008`](#task-008-cleanup-researchtss-output-construction) | Remove deleted fields from research output                              | [`TASK-007`](#task-007-add-stripempty-to-buildsuccessfulstructuredcontent) | [src/tools/research.ts](src/tools/research.ts) | `node scripts/tasks.mjs --quick` |
| [`TASK-009`](#task-009-cleanup-analyzetss-output-construction)  | Remove deleted fields from analyze output                               | [`TASK-008`](#task-008-cleanup-researchtss-output-construction)            | [src/tools/analyze.ts](src/tools/analyze.ts)   | `node scripts/tasks.mjs --quick` |
| [`TASK-010`](#task-010-cleanup-reviewtss-output-construction)   | Move truncated/empty into warnings[]; remove path arrays                | [`TASK-009`](#task-009-cleanup-analyzetss-output-construction)             | [src/tools/review.ts](src/tools/review.ts)     | `node scripts/tasks.mjs --quick` |
| [`TASK-011`](#task-011-cleanup-chattss-output-construction)     | Remove contextUsed/computations/workspaceCacheApplied; simplify session | [`TASK-010`](#task-010-cleanup-reviewtss-output-construction)              | [src/tools/chat.ts](src/tools/chat.ts)         | `node scripts/tasks.mjs --quick` |

#### TASK-008: Cleanup research.ts output construction

| Field      | Value                                                                                                                                                                                                                                                                            |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-007`](#task-007-add-stripempty-to-buildsuccessfulstructuredcontent)                                                                                                                                                                                                       |
| Files      | Modify: [src/tools/research.ts](src/tools/research.ts); Modify: [**tests**/tools/research.test.ts](__tests__/tools/research.test.ts)                                                                                                                                             |
| Symbols    | [buildResearchStructuredContent](src/tools/research.ts#L1105)                                                                                                                                                                                                                    |
| Outcome    | `buildResearchStructuredContent` emits only `status`, `summary`, `sourceDetails?`, `findings?`. No `mode`, `sources`, `urlContextSources`, `urlMetadata`, `groundingSignals`, `citations`, `computations`, `toolsUsed`, `requestId`, `contextUsed`. TypeScript compiles cleanly. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/tools/research.test.ts
// Add near the existing structured-content assertions:
it('research structured content has no mode or sources fields', () => {
  // Use the existing mock or stub that produces a structured content object.
  // The key assertion: after calling buildResearchStructuredContent with
  // a mock stream result, the returned object must not contain mode/sources/groundingSignals.
  const structured = {
    status: 'grounded',
    mode: 'quick',
    summary: 'Answer',
    sources: ['https://example.com'],
    groundingSignals: {
      retrievalPerformed: true,
      urlContextUsed: false,
      groundingSupportsCount: 0,
      confidence: 'low',
    },
  };
  // Validate against the new schema — it should reject the old shape:
  const parseResult = ResearchOutputSchema.safeParse(structured);
  assert.strictEqual(parseResult.success, false, 'old shape must be rejected by new schema');
});
```

Import `ResearchOutputSchema` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/research.test.ts
```

Expected: FAIL — the old structured payload shape is still produced; schema rejects it.

- [ ] **Step 3: Rewrite buildResearchStructuredContent in research.ts**

In [src/tools/research.ts](src/tools/research.ts), find `buildResearchStructuredContent` (line 1105) and update it to stop computing and assigning all removed fields. The key changes:

1. Remove `computations`, `toolsUsed`, `citations`, `urlMetadata`, `urlContextSources`, `sources`, `groundingSignals`, `mode`, `requestId`, `contextUsed` from the returned object.
2. Keep `sourceDetails` (computed from `collectGroundedSourceDetails` / `mergeSourceDetails`).
3. Keep `findings` (derived from `deriveFindingsFromCitations` — **keep this call**, just remove `citations` from the output).
4. Keep `status` (derived from `deriveOverallStatus`).
5. Remove the `requestId: ctx.task?.id` line.
6. Remove dead variable assignments for `computations`, `urlMetadataResult`, `urlContextSources`.

The returned object shape:

```ts
return buildSuccessfulStructuredContent({
  warnings: allWarnings.length > 0 ? allWarnings : undefined,
  domain: {
    status,
    summary: textContent,
    ...(sourceDetails.length > 0 ? { sourceDetails } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  },
});
```

Remove unused imports: `collectUrlMetadataWithCounts`, `collectUrlContextSources`, `appendUrlStatus`, `deriveComputationsFromToolEvents`, `computeGroundingSignals`, `collectGroundedSources`, and any others only used for deleted fields. Run `node scripts/tasks.mjs --quick` to see exact TypeScript errors and fix them one by one.

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/tasks.mjs --quick
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/research.test.ts
```

Expected: type-check PASS, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/research.ts __tests__/tools/research.test.ts
git commit -m "refactor: strip removed fields from research tool output"
```

---

#### TASK-009: Cleanup analyze.ts output construction

| Field      | Value                                                                                                                                                                                                                                                  |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-008`](#task-008-cleanup-researchtss-output-construction)                                                                                                                                                                                        |
| Files      | Modify: [src/tools/analyze.ts](src/tools/analyze.ts)                                                                                                                                                                                                   |
| Symbols    | [buildAnalyzeStructuredContent](src/tools/analyze.ts#L467)                                                                                                                                                                                             |
| Outcome    | `buildAnalyzeStructuredContent` emits only `status`, `summary?`, `diagram?`, `diagramType?`, `explanation?`, `syntaxErrors?`, `syntaxValid?`. No `kind`, `targetKind`, `groundingSignals`, `urlMetadata`, `analyzedPaths`, `contextUsed`, `requestId`. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/schemas/outputs.test.ts (or a new analyze-specific test)
it('AnalyzeOutputSchema rejects kind that analyze.ts currently emits', () => {
  // Simulate what analyze.ts currently returns before cleanup:
  const oldShape = {
    status: 'completed' as const,
    kind: 'diagram' as const,
    targetKind: 'file' as const,
    diagramType: 'mermaid' as const,
    diagram: 'graph TD\nA-->B',
  };
  const result = AnalyzeOutputSchema.safeParse(oldShape);
  assert.strictEqual(result.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — `kind` and `targetKind` are still emitted by the handler, but the test above uses the schema which now rejects them. (If the schema tests from TASK-004 already cover this, skip adding a duplicate test and proceed to Step 3 directly.)

- [ ] **Step 3: Rewrite buildAnalyzeStructuredContent**

In [src/tools/analyze.ts](src/tools/analyze.ts), find `buildAnalyzeStructuredContent` (line 467) and update both branches (diagram and summary):

**Diagram branch:**

```ts
return buildSuccessfulStructuredContent({
  warnings: warnings?.length ? warnings : undefined,
  domain: {
    status: 'completed' as const,
    diagramType: args.diagramType ?? 'mermaid',
    diagram: structured.diagram,
    ...(structured.explanation ? { explanation: structured.explanation } : {}),
    ...deriveDiagramSyntaxValidation(structured.toolEvents ?? []),
  },
});
```

**Summary branch:**

```ts
return buildSuccessfulStructuredContent({
  warnings: warnings?.length ? warnings : undefined,
  domain: {
    status: deriveOverallStatus(computeGroundingSignals(...)) as 'grounded' | 'partially_grounded' | 'ungrounded' | 'completed',
    summary: structured.summary,
  },
});
```

Remove `requestId: ctx.task?.id`, `kind`, `targetKind`, `groundingSignals`, `urlMetadata`, `analyzedPaths`, `contextUsed`, `diagnostics` from the domain object. Remove unused imports (`ContextUsed` if only used there). Run `node scripts/tasks.mjs --quick` to get exact TypeScript error list.

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/analyze.ts
git commit -m "refactor: strip removed fields from analyze tool output"
```

---

#### TASK-010: Cleanup review.ts output construction

| Field      | Value                                                                                                                                                                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-009`](#task-009-cleanup-analyzetss-output-construction)                                                                                                                                                                                                                                            |
| Files      | Modify: [src/tools/review.ts](src/tools/review.ts)                                                                                                                                                                                                                                                        |
| Symbols    | [buildReviewStructuredContent](src/tools/review.ts#L1380), [buildTextResult](src/tools/review.ts#L1104)                                                                                                                                                                                                   |
| Outcome    | `buildReviewStructuredContent` emits only `status`, `summary`, `stats?`, `documentationDrift?`, `warnings?`. `truncated=true` → `warnings.push("Diff was truncated: {n} paths omitted.")`. `empty=true` → `warnings.push("No changes detected in the diff.")`. `schemaWarnings` spread into `warnings[]`. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/schemas/outputs.test.ts
it('ReviewOutputSchema rejects the old shape that review.ts currently emits', () => {
  const oldShape = {
    status: 'completed' as const,
    summary: 'LGTM',
    subjectKind: 'diff' as const,
    reviewedPaths: ['src/index.ts'],
    truncated: false,
    empty: false,
  };
  const result = ReviewOutputSchema.safeParse(oldShape);
  assert.strictEqual(result.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: FAIL — old shape with `subjectKind`, `reviewedPaths`, `truncated` is still accepted by the pre-cleanup handler. (If TASK-005 schema tests already cover this, skip adding a duplicate — proceed to Step 3.)

- [ ] **Step 3: Rewrite buildReviewStructuredContent**

In [src/tools/review.ts](src/tools/review.ts), find `buildReviewStructuredContent` (line 1380). Replace it:

```ts
function buildReviewStructuredContent(
  taskId: string | undefined,
  structured: ReviewStructuredOutput,
): Record<string, unknown> {
  const warnings: string[] = [];

  // Fold schemaWarnings into warnings
  if (Array.isArray(structured.schemaWarnings)) {
    warnings.push(...structured.schemaWarnings.filter((w): w is string => typeof w === 'string'));
  }

  // Fold truncation signal into warnings
  if (structured.truncated === true) {
    const omittedCount = structured.omittedPaths?.length ?? 0;
    warnings.push(
      omittedCount > 0
        ? `Diff was truncated: ${String(omittedCount)} paths omitted due to size limit.`
        : 'Diff was truncated due to size limit.',
    );
  }

  // Fold empty-diff signal into warnings
  if (structured.empty === true) {
    warnings.push('No changes detected in the diff.');
  }

  return buildSuccessfulStructuredContent({
    warnings: warnings.length > 0 ? warnings : undefined,
    domain: {
      status: 'completed' as const,
      summary: structured.summary,
      ...(structured.stats ? { stats: structured.stats } : {}),
      ...(structured.documentationDrift?.length
        ? { documentationDrift: structured.documentationDrift }
        : {}),
    },
  });
}
```

Remove `taskId` (requestId) from the call site — the caller at line 1492 passes `ctx.task?.id`, remove that argument. Remove `subjectKind`, `reviewedPaths`, `includedUntracked`, `skippedBinaryPaths`, `skippedLargePaths`, `skippedSensitivePaths`, `omittedPaths` from the `ReviewStructuredOutput` type and from all places that populate it.

Run `node scripts/tasks.mjs --quick` to identify remaining TypeScript errors.

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/review.ts
git commit -m "refactor: fold truncated/empty into warnings[]; remove path arrays from review output"
```

---

#### TASK-011: Cleanup chat.ts output construction

| Field      | Value                                                                                                                                                                                                      |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-010`](#task-010-cleanup-reviewtss-output-construction)                                                                                                                                              |
| Files      | Modify: [src/tools/chat.ts](src/tools/chat.ts); Modify: [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts)                                                                                         |
| Symbols    | [attachContextUsed](src/tools/chat.ts#L341), [appendAskWarnings](src/tools/chat.ts#L227)                                                                                                                   |
| Outcome    | chat.ts emits `{ status, answer, data?, session?{id}, warnings? }`. `attachContextUsed` deleted. `computations`, `workspaceCacheApplied`, `schemaWarnings`, `contextUsed` removed from all output objects. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/tools/ask.test.ts
it('ChatOutputSchema rejects workspaceCacheApplied that chat.ts currently emits', () => {
  // The handler currently sets workspaceCacheApplied in the structured output.
  // The schema now rejects it.
  const oldChatOutput = {
    status: 'completed' as const,
    answer: 'hello',
    workspaceCacheApplied: false,
  };
  const result = ChatOutputSchema.safeParse(oldChatOutput);
  assert.strictEqual(result.success, false);
});
```

Import `ChatOutputSchema` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ask.test.ts
```

Expected: FAIL — current handler emits `workspaceCacheApplied` which the new schema now rejects.

- [ ] **Step 3: Rewrite chat.ts output construction**

In [src/tools/chat.ts](src/tools/chat.ts):

1. **Delete `attachContextUsed`** (line 341) entirely. Remove all its call sites (search: `grep -n "attachContextUsed" src/tools/chat.ts`).

2. **Remove `contextUsed` parameter** from `askNewSession`, `askResumedSession`, and `askFunctionResponse` function signatures. Remove all `contextUsed` variable assignments and usages.

3. **Stop computing `computations`** (line 266) — delete that variable and its use.

4. **Remove `schemaWarnings` / `workspaceCacheApplied`** from the structured content object. The key change is around line 271–279 where the structured content is built. Replace the domain object with:

```ts
{
  status: 'completed' as const,
  answer: textContent,
  ...(data !== undefined ? { data } : {}),
  ...(sessionId ? { session: { id: sessionId } } : {}),
}
```

1. **Remove `schemaWarnings` extraction** (around line 1244) — warnings now flow purely through `warnings[]`.

2. **Remove unused imports**: `ContextUsed`, `deriveComputationsFromToolEvents`, `ContextSourceReportSchema` if referenced, and any others that become dead.

Run `node scripts/tasks.mjs --quick` to surface every TypeScript error and fix them.

- [ ] **Step 4: Run test to verify it passes**

```bash
node scripts/tasks.mjs --quick
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ask.test.ts
```

Expected: both PASS. Also update any existing `ask.test.ts` assertions that check for `workspaceCacheApplied`, `computations`, `contextUsed`, `session.resources`, `session.rebuiltAt`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/chat.ts __tests__/tools/ask.test.ts
git commit -m "refactor: remove contextUsed/computations/workspaceCacheApplied from chat output; simplify session"
```

---

### PHASE-004: Input description cleanup

**Goal:** Variant-schema field descriptions in `inputs.ts` drop "Allowed only when X=Y" policy prose that duplicates structural constraints already enforced by the discriminated union.

| Task                                                                        | Action                                       | Depends on                                                  | Files                                          | Validate                         |
| :-------------------------------------------------------------------------- | :------------------------------------------- | :---------------------------------------------------------- | :--------------------------------------------- | :------------------------------- |
| [`TASK-012`](#task-012-strip-policy-prose-from-variant-schema-descriptions) | Strip policy prose from variant descriptions | [`TASK-011`](#task-011-cleanup-chattss-output-construction) | [src/schemas/inputs.ts](src/schemas/inputs.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-012: Strip policy prose from variant schema descriptions

| Field      | Value                                                                                                                                                                                                                                                                                                           |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-011`](#task-011-cleanup-chattss-output-construction)                                                                                                                                                                                                                                                     |
| Files      | Modify: [src/schemas/inputs.ts](src/schemas/inputs.ts)                                                                                                                                                                                                                                                          |
| Symbols    | none                                                                                                                                                                                                                                                                                                            |
| Outcome    | All "Allowed only when X=Y" and "Allowed only when subjectKind=Y" clauses removed from variant schema field descriptions. Descriptions remain purposeful. No schema behavior changes. TDD skipped — this is a pure description string edit with no runtime effect; verified by type-check + schema parse tests. |

- [ ] **Step 1: Apply the description changes**

In [src/schemas/inputs.ts](src/schemas/inputs.ts), find and update these descriptions in the **variant** schemas (`AnalyzeFileSchema`, `AnalyzeUrlSchema`, `AnalyzeMultiSchema`, `ReviewDiffSchema`, `ReviewComparisonSchema`, `ReviewFailureSchema`, `ResearchDeepSchema`). Leave the **base** schema descriptions untouched.

Key replacements:

```
"Workspace-relative or absolute path to analyze when targetKind=file. Allowed only when targetKind=file."
→ "File path to analyze."

"Public URLs to analyze when targetKind=url. Allowed only when targetKind=url."
→ "Public URLs to analyze."

"Local files to analyze when targetKind=multi. Allowed only when targetKind=multi."
→ "Local files to analyze."

"Skip model review for subjectKind=diff."
→ "Skip model review and return diff stats only."

"Primary language hint for diff or failure review."
→ "Primary language hint for the review."

"Workspace-relative or absolute path to the first file when subjectKind=comparison"
→ "First file to compare."

"Workspace-relative or absolute path to the second file when subjectKind=comparison"
→ "Second file to compare."

"Error message or stack trace when subjectKind=failure."
→ "Error message or stack trace."

"Relevant source code context when subjectKind=failure."
→ "Relevant source code context."

"Requested output form (brief, report, checklist, etc.). Allowed only when mode=deep."
→ "Requested output form (brief, report, checklist, etc.)."

"Search depth, default 2. Allowed only when mode=deep."
→ "Search depth (1-5, default 2)."
```

- [ ] **Step 2: Verify**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS — no behavior change, only description strings changed.

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
```

Expected: PASS — no schema behavior changed.

- [ ] **Step 3: Commit**

```bash
git add src/schemas/inputs.ts
git commit -m "refactor: strip policy prose from variant schema field descriptions"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full test suite passes

```bash
node scripts/tasks.mjs
```

Expected: all tasks green (format, lint, type-check, knip, tests, build).

### [`VAL-002`](#5-testing--validation) — Schema rejects removed fields

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/outputs.test.ts
```

Expected: PASS — new tests assert that `requestId`, `diagnostics`, `mode`, `kind`, `targetKind`, `subjectKind`, `sources`, `groundingSignals`, `computations`, `citations`, `contextUsed`, `workspaceCacheApplied`, `reviewedPaths`, `truncated`, `empty` are all rejected by their respective schemas.

### [`VAL-003`](#5-testing--validation) — stripEmpty removes empty arrays in output

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: PASS — `stripEmpty` tests confirm `[]` and `null` values are stripped from `buildSuccessfulStructuredContent` output.

### [`VAL-004`](#5-testing--validation) — TypeScript strict-mode clean

```bash
npm run type-check
```

Expected: zero errors. Exact flag used by the project: `tsc --noEmit`.

## 6. Acceptance Criteria

| ID                                 | Observable Outcome                                                                                                                                                                    |
| :--------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`AC-001`](#6-acceptance-criteria) | `ChatOutputSchema.safeParse({ status:'completed', answer:'hi', requestId:'x' }).success === false`                                                                                    |
| [`AC-002`](#6-acceptance-criteria) | `ChatOutputSchema.safeParse({ status:'completed', answer:'hi', session:{id:'abc'} }).success === true`                                                                                |
| [`AC-003`](#6-acceptance-criteria) | `ResearchOutputSchema.safeParse({ status:'grounded', summary:'s', mode:'quick' }).success === false`                                                                                  |
| [`AC-004`](#6-acceptance-criteria) | `ResearchOutputSchema.safeParse({ status:'grounded', summary:'s', sourceDetails:[] }).success === true` but the returned object has no `sourceDetails` key (stripped by `stripEmpty`) |
| [`AC-005`](#6-acceptance-criteria) | `AnalyzeOutputSchema.safeParse({ status:'ungrounded', summary:'s', kind:'summary' }).success === false`                                                                               |
| [`AC-006`](#6-acceptance-criteria) | `ReviewOutputSchema.safeParse({ status:'completed', summary:'ok', truncated:true }).success === false`                                                                                |
| [`AC-007`](#6-acceptance-criteria) | When review diff is truncated, `warnings` array in output contains a string starting with `"Diff was truncated"`                                                                      |
| [`AC-008`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 — all format, lint, type-check, knip, test, build checks pass                                                                                        |

## 7. Risks / Notes

| ID                            | Type | Detail                                                                                                                                                                                                                                                                                                                            |
| :---------------------------- | :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | Removing `ContextUsedSchema` from `outputs.ts` exports may break external consumers that import it by name. Verify with `grep -rn "ContextUsed" src/ __tests__/` before deleting. If referenced in tests only, delete those references too.                                                                                       |
| [`RISK-002`](#7-risks--notes) | Risk | `buildSharedStructuredMetadata` is called in `buildStructuredResponse` which may be called from places outside the four main tool handlers (e.g. tasks infrastructure). Run `grep -rn "buildSharedStructuredMetadata\|buildStructuredResponse" src/` and update every call site.                                                  |
| [`RISK-003`](#7-risks--notes) | Risk | The e2e tests in [**tests**/e2e.test.ts](__tests__/e2e.test.ts) and [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts) may assert specific output shapes. Run them separately after PHASE-003: `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/e2e.test.ts`. Update any failing assertions. |
| [`NOTE-001`](#7-risks--notes) | Note | `deriveOverallStatus` and `computeGroundingSignals` in `response.ts` are still used by handlers to compute the `status` field — keep them. Only the `groundingSignals` _object_ is removed from the output; the derived `status` string is kept.                                                                                  |
| [`NOTE-002`](#7-risks--notes) | Note | `DiagnosticsSchema` and related sub-schemas (`ToolEventSchema`, `FunctionCallEntrySchema`) in `fields.ts` may be imported by test files. Check with `grep -rn "DiagnosticsSchema\|ToolEventSchema\|FunctionCallEntry" __tests__/` and remove those imports/usages.                                                                |
| [`NOTE-003`](#7-risks--notes) | Note | `knip` (unused export checker) will flag exports that are no longer referenced after the cleanup. Run `npm run lint` (which includes knip) to identify them and delete the exports.                                                                                                                                               |
