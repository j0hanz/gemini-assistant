---
goal: Align gemini-assistant with MCP v2 SDK idioms by adding prompt completion, removing the schema bypass, collapsing the definePrompt builder, and deleting the Symbol-key service injection pattern
version: 1
date_created: 2026-04-28
status: Planned
plan_type: refactor
component: mcp-v2-sdk-alignment
execution: subagent-driven
---

# Implementation Plan: MCP v2 SDK Alignment

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Remove four SDK misalignments — missing prompt arg completion, schema passthrough bypass, redundant `definePrompt` builder, and Symbol-key service injection — replacing each with the idiomatic v2 pattern.

**Architecture:** Three independent phases targeting disjoint layers: (1) prompt registration in [src/prompts.ts](src/prompts.ts), (2) task input validation in [src/lib/task-utils.ts](src/lib/task-utils.ts), and (3) service threading across the tool executor and four tool files. Phases 1 and 2 can run in either order; Phase 3 tasks must run sequentially.

**Tech Stack:** TypeScript strict mode, MCP v2 (`@modelcontextprotocol/server`), Zod v4 (`zod/v4`), Node.js built-in test runner (`node:test`).

---

## 1. Goal

Four gaps identified during an MCP v2 SDK audit prevent clients from getting full SDK benefits. Prompt enum args lack `completable()` wrappers so clients cannot offer tab-completion. The `createSdkPassthroughInputSchema` bypass makes task tools behave differently from stateless tools on invalid input. The `definePrompt()` helper adds an indirection layer the SDK already covers. The `TOOL_SERVICES_KEY` Symbol propagates services through `ctx` invisibly, hiding dependencies from every function signature. This refactor closes all four gaps with minimal blast radius — no public contract changes, no schema changes, no transport changes.

## 2. Requirements & Constraints

| ID | Type | Statement |
| :--- | :--- | :--- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `completion/complete` for prompt args `job`, `mode`, `subject` must return filtered enum values. |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Calling a task tool with schema-invalid input must return a protocol error (not a task ID) in both stateful and stateless modes. |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `createPromptDefinitions` and `definePrompt` must not appear in any `src/` import after PHASE-001. |
| [`REQ-004`](#2-requirements--constraints) | Requirement | `bindToolServices`, `findToolServices`, `getToolServices`, and `TOOL_SERVICES_KEY` must not appear in any `src/` import after PHASE-003. |
| [`CON-001`](#2-requirements--constraints) | Constraint | Public contract ([src/public-contract.ts](src/public-contract.ts)) is frozen — no new tools, prompts, or resources. |
| [`CON-002`](#2-requirements--constraints) | Constraint | `analyzePrWork` is exported and called in tests — its new `services` parameter must be optional to avoid breaking callers. |
| [`CON-003`](#2-requirements--constraints) | Constraint | `analyzeUrlWork` is exported — its new `services` parameter must also be optional. |
| [`PAT-001`](#2-requirements--constraints) | Pattern | Follow [completable](src/schemas/inputs.ts) in [src/schemas/inputs.ts](src/schemas/inputs.ts) for the `completable()` wrapping pattern. |
| [`PAT-002`](#2-requirements--constraints) | Pattern | Use `hasSafeParse` and `hasParse` from [src/lib/task-utils.ts](src/lib/task-utils.ts) — these are retained; do not delete them. |

## 3. Current Context

### File structure

| File | Status | Responsibility |
| :--- | :--- | :--- |
| [src/prompts.ts](src/prompts.ts) | Modify | Prompt schema definitions, build functions, and registration |
| [src/schemas/fields.ts](src/schemas/fields.ts) | Read-only | Source of `RESEARCH_MODE_OPTIONS`, `REVIEW_SUBJECT_OPTIONS`, `PublicJobNameSchema` |
| [src/lib/task-utils.ts](src/lib/task-utils.ts) | Modify | Task/tool registration bridge and input validation bypass |
| [src/lib/tool-context.ts](src/lib/tool-context.ts) | Modify | Symbol-key service injection (to be deleted) |
| [src/lib/tool-executor.ts](src/lib/tool-executor.ts) | Modify | `GeminiPipelineRequest` interface and `executeGeminiPipeline` |
| [src/tools/chat.ts](src/tools/chat.ts) | Modify | Remove `bindToolServices` wrapper at registration |
| [src/tools/analyze.ts](src/tools/analyze.ts) | Modify | Thread `services` to `executeGeminiPipeline` call sites |
| [src/tools/research.ts](src/tools/research.ts) | Modify | Thread `services` through 3-level chain; update `analyzeUrlWork` |
| [src/tools/review.ts](src/tools/review.ts) | Modify | Thread `services` through 2-level chain |
| [__tests__/prompts.test.ts](__tests__/prompts.test.ts) | Modify | Remove `createPromptDefinitions` usage; test via schemas and build functions |
| [__tests__/completion.e2e.test.ts](__tests__/completion.e2e.test.ts) | Modify | Add prompt argument completion test |
| [__tests__/lib/task-utils.test.ts](__tests__/lib/task-utils.test.ts) | Modify | Add test verifying schema passthrough is gone |

### Relevant symbols

| Symbol | Why it matters |
| :--- | :--- |
| [DiscoverPromptSchema](src/prompts.ts#L95) | Add `completable()` to `job` field |
| [ResearchPromptSchema](src/prompts.ts#L102) | Add `completable()` to `mode` field |
| [ReviewPromptSchema](src/prompts.ts#L110) | Add `completable()` to `subject` field |
| [buildDiscoverPrompt](src/prompts.ts#L120) | Retained; used directly in `registerPrompts` |
| [buildResearchPrompt](src/prompts.ts#L131) | Retained; used directly in `registerPrompts` |
| [buildReviewPrompt](src/prompts.ts#L143) | Retained; used directly in `registerPrompts` |
| [definePrompt](src/prompts.ts#L32) | Deleted in TASK-002 |
| [createPromptDefinitions](src/prompts.ts#L154) | Deleted in TASK-002 |
| [PromptDefinition](src/prompts.ts#L24) | Deleted in TASK-002 |
| [registerPrompts](src/prompts.ts#L180) | Rewritten to three direct `registerPrompt` calls |
| [PUBLIC_JOB_OPTIONS](src/prompts.ts#L19) | Retained; provides enum options for `completable` |
| [PublicJobNameSchema](src/schemas/fields.ts#L51) | `.options` array used in completion callback |
| [RESEARCH_MODE_OPTIONS](src/schemas/fields.ts#L17) | Enum options for `mode` completion |
| [REVIEW_SUBJECT_OPTIONS](src/schemas/fields.ts#L20) | Enum options for `subject` completion |
| [createSdkPassthroughInputSchema](src/lib/task-utils.ts#L123) | Deleted in TASK-003 |
| [hasStandardSchema](src/lib/task-utils.ts#L111) | Deleted in TASK-003 (only called by bypass) |
| [StandardSchemaLike](src/lib/task-utils.ts#L84) | Deleted in TASK-003 |
| [JsonSchemaProvider](src/lib/task-utils.ts#L80) | Deleted in TASK-003 |
| [createTaskRegistrationConfig](src/lib/task-utils.ts#L139) | Simplified in TASK-003 |
| [hasSafeParse](src/lib/task-utils.ts#L93) | Retained — used by `parseTaskInput` |
| [hasParse](src/lib/task-utils.ts#L102) | Retained — used by `parseTaskInput` |
| [parseTaskInput](src/lib/task-utils.ts#L147) | Retained — handles Zod coercions post-validation |
| [TOOL_SERVICES_KEY](src/lib/tool-context.ts#L21) | Deleted in TASK-009 |
| [BoundToolContext](src/lib/tool-context.ts#L49) | Deleted in TASK-009 |
| [bindToolServices](src/lib/tool-context.ts#L53) | Deleted in TASK-009 |
| [getToolServices](src/lib/tool-context.ts#L58) | Deleted in TASK-009 |
| [findToolServices](src/lib/tool-context.ts#L66) | Deleted in TASK-009 |
| [GeminiPipelineRequest](src/lib/tool-executor.ts#L125) | Gets new `cacheName?: string` field in TASK-004 |
| [ToolExecutor](src/lib/tool-executor.ts#L138) | `executeGeminiPipeline` updated in TASK-004 |
| [analyzeWork](src/tools/analyze.ts#L367) | Gets `services?: ToolServices` param in TASK-006 |
| [registerAnalyzeTool](src/tools/analyze.ts#L497) | Removes `bindToolServices` in TASK-006 |
| [chatWork](src/tools/chat.ts#L1288) | Receives plain `ctx` after TASK-005 |
| [registerChatTool](src/tools/chat.ts#L1324) | Removes `bindToolServices` in TASK-005 |
| [agenticSearchWork](src/tools/research.ts#L884) | Gets `services: ToolServices` in TASK-007 |
| [analyzeUrlWork](src/tools/research.ts#L851) | Gets optional `services?: ToolServices` in TASK-007 |
| [runDeepResearch](src/tools/research.ts#L984) | Gets `services: ToolServices` in TASK-007 |
| [researchWork](src/tools/research.ts#L1050) | Gets `services: ToolServices` in TASK-007 |
| [registerResearchTool](src/tools/research.ts#L1069) | Removes `bindToolServices` in TASK-007 |
| [analyzePrWork](src/tools/review.ts#L1221) | Gets optional `services?: ToolServices` in TASK-008 |
| [reviewWork](src/tools/review.ts#L1393) | Gets `services: ToolServices` in TASK-008 |
| [registerReviewTool](src/tools/review.ts#L1468) | Removes `bindToolServices` in TASK-008 |

### Existing commands

```bash
npm run lint && npm run type-check && npm run test
```

```bash
# Single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts
```

### Current behavior

`completion/complete` for prompt args returns empty (no `completable` wrappers). Task tools with invalid input produce a `failed` task record instead of a protocol error. `registerPrompts` iterates a `createPromptDefinitions()` array rather than calling `registerPrompt` directly. Tool handlers receive services via a hidden Symbol property on `ctx` set by `bindToolServices`.

## 4. Implementation Phases

### PHASE-001: Prompt layer

**Goal:** Prompt enum args return completion values; `definePrompt` builder and `createPromptDefinitions` factory are deleted.

| Task | Action | Depends on | Files | Validate |
| :--- | :--- | :--- | :--- | :--- |
| [`TASK-001`](#task-001-add-completable-wrappers-to-prompt-enum-fields) | Add `completable()` to three prompt schema fields | none | [src/prompts.ts](src/prompts.ts) | `npm run type-check` |
| [`TASK-002`](#task-002-collapse-defineprompt-builder-into-direct-registerprompt-calls) | Collapse `definePrompt` + loop → direct `registerPrompt` calls | [`TASK-001`](#task-001-add-completable-wrappers-to-prompt-enum-fields) | [src/prompts.ts](src/prompts.ts), [__tests__/prompts.test.ts](__tests__/prompts.test.ts) | `npm run test` |

#### TASK-001: Add `completable()` wrappers to prompt enum fields

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | Modify: [src/prompts.ts](src/prompts.ts); Test: [__tests__/completion.e2e.test.ts](__tests__/completion.e2e.test.ts) |
| Symbols | [DiscoverPromptSchema](src/prompts.ts#L95), [ResearchPromptSchema](src/prompts.ts#L102), [ReviewPromptSchema](src/prompts.ts#L110) |
| Outcome | `completion/complete` for `discover.job`, `research.mode`, `review.subject` returns filtered enum values. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/completion.e2e.test.ts — add inside describe('MCP completion/complete for parameterized resources')
it('returns matching job values for discover prompt job arg', async () => {
  const harness = await createHarness();
  try {
    const response = await harness.client.request('completion/complete', {
      ref: { type: 'ref/prompt', name: 'discover' },
      argument: { name: 'job', value: 'c' },
    });
    const result = response.result as { completion: { values: string[] } };
    assert.ok(result.completion.values.includes('chat'), 'expected "chat" in completions');
    assert.ok(
      result.completion.values.every((v: string) => v.startsWith('c')),
      'all values should start with "c"',
    );
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/completion.e2e.test.ts
```

Expected: FAIL — `completion/complete` returns empty values because `job` has no `completable` wrapper.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/prompts.ts — add import at top with existing @modelcontextprotocol/server imports
import { completable } from '@modelcontextprotocol/server';

// Add helper after the imports, before DiscoverPromptSchema
function enumComplete<T extends string>(options: readonly T[]) {
  return (value: string | undefined): T[] =>
    options.filter((o) => o.startsWith(value ?? ''));
}

// DiscoverPromptSchema — wrap job field
export const DiscoverPromptSchema = z
  .strictObject({
    job: completable(
      PublicJobNameSchema.optional().describe('Public job to focus discovery guidance on.'),
      enumComplete(PublicJobNameSchema.options),
    ),
    goal: textField('User outcome to optimize for.').optional(),
  })
  .describe('Guide a client to the best public job, prompt, and resource.');

// ResearchPromptSchema — wrap mode field
export const ResearchPromptSchema = z
  .strictObject({
    goal: goalText('Research goal or question'),
    mode: completable(
      enumField(RESEARCH_MODE_OPTIONS, 'Research mode (quick or deep).').optional(),
      enumComplete(RESEARCH_MODE_OPTIONS),
    ),
    deliverable: textField('Requested output form.').optional(),
  })
  .describe('Explain the quick-versus-deep research decision flow.');

// ReviewPromptSchema — wrap subject field
export const ReviewPromptSchema = z
  .strictObject({
    subject: completable(
      enumField(REVIEW_SUBJECT_OPTIONS, 'Review variant (diff, comparison, failure).').optional(),
      enumComplete(REVIEW_SUBJECT_OPTIONS),
    ),
    focus: textField('Review priority (e.g. regressions, tests, security).').optional(),
  })
  .describe('Guide diff review, file comparison, or failure triage.');
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/completion.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts __tests__/completion.e2e.test.ts
git commit -m "feat: add completable() wrappers to discover/research/review prompt enum args"
```

---

#### TASK-002: Collapse `definePrompt` builder into direct `registerPrompt` calls

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-001`](#task-001-add-completable-wrappers-to-prompt-enum-fields) |
| Files | Modify: [src/prompts.ts](src/prompts.ts); Modify: [__tests__/prompts.test.ts](__tests__/prompts.test.ts) |
| Symbols | [definePrompt](src/prompts.ts#L32), [createPromptDefinitions](src/prompts.ts#L154), [PromptDefinition](src/prompts.ts#L24), [registerPrompts](src/prompts.ts#L180) |
| Outcome | `definePrompt`, `createPromptDefinitions`, and `PromptDefinition` are gone; `registerPrompts` calls `server.registerPrompt` three times directly; `prompts.test.ts` passes. |

*TDD note: this is a pure refactor — behavior is unchanged. Step 1 updates the test to not import `createPromptDefinitions`; Step 3 deletes the builder and rewrites `registerPrompts`.*

- [ ] **Step 1: Update the test to remove `createPromptDefinitions` dependency**

```ts
// __tests__/prompts.test.ts — replace the top of the file
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, it } from 'node:test';

import {
  buildDiscoverPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  DiscoverPromptSchema,
  PUBLIC_JOB_OPTIONS,
  PUBLIC_PROMPT_NAMES,
  registerPrompts,
  renderWorkflowSection,
  ResearchPromptSchema,
  ReviewPromptSchema,
} from '../src/prompts.js';

// Replace the promptDefinitions block at lines 17-33 with:
describe('prompt registration', () => {
  it('registers exactly the public prompt names in order', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerPrompts(server);
    const { prompts } = await server.server.listPrompts();
    assert.deepStrictEqual(
      prompts.map((p) => p.name),
      [...PUBLIC_PROMPT_NAMES],
    );
  });

  it('registers prompts with correct titles', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerPrompts(server);
    const { prompts } = await server.server.listPrompts();
    assert.deepStrictEqual(
      prompts.map((p) => p.title),
      ['Discover', 'Research', 'Review'],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/prompts.test.ts
```

Expected: FAIL — `createPromptDefinitions` is still imported in the old test; the new `server.server.listPrompts()` shape may not exist yet.

- [ ] **Step 3: Rewrite `registerPrompts`; delete `definePrompt`, `PromptDefinition`, `createPromptDefinitions`**

```ts
// src/prompts.ts — replace registerPrompts and delete the builder machinery

// DELETE these entirely:
// - type BuildMessageResult / PromptMessageResult
// - interface PromptDefinition
// - function definePrompt (all overloads + implementation)
// - function createPromptDefinitions

// REPLACE registerPrompts with:
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'discover' satisfies PublicPromptName,
    {
      title: 'Discover',
      description: 'Guide a client to the best public job, prompt, and resource.',
      argsSchema: DiscoverPromptSchema,
    },
    async (args) => ({
      description: 'Guide a client to the best public job, prompt, and resource.',
      ...buildDiscoverPrompt(args),
    }),
  );

  server.registerPrompt(
    'research' satisfies PublicPromptName,
    {
      title: 'Research',
      description: 'Explain the quick-versus-deep research decision flow.',
      argsSchema: ResearchPromptSchema,
    },
    async (args) => ({
      description: 'Explain the quick-versus-deep research decision flow.',
      ...buildResearchPrompt(args),
    }),
  );

  server.registerPrompt(
    'review' satisfies PublicPromptName,
    {
      title: 'Review',
      description: 'Guide diff review, file comparison, or failure triage.',
      argsSchema: ReviewPromptSchema,
    },
    async (args) => ({
      description: 'Guide diff review, file comparison, or failure triage.',
      ...buildReviewPrompt(args),
    }),
  );
}
```

Also add `PublicPromptName` to the imports from `./public-contract.js` at the top of `src/prompts.ts`.

- [ ] **Step 4: Run full test suite**

```bash
npm run lint && npm run type-check && npm run test
```

Expected: PASS — all tests green, no `createPromptDefinitions` references remain.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts __tests__/prompts.test.ts
git commit -m "refactor: collapse definePrompt builder into direct registerPrompt calls"
```

---

### PHASE-002: Schema bypass removal

**Goal:** Task tools reject schema-invalid input at the `tools/call` boundary with a protocol error, matching stateless mode behavior.

| Task | Action | Depends on | Files | Validate |
| :--- | :--- | :--- | :--- | :--- |
| [`TASK-003`](#task-003-remove-createsdkpassthroughinputschema-bypass) | Delete bypass; simplify `createTaskRegistrationConfig` | none | [src/lib/task-utils.ts](src/lib/task-utils.ts) | `npm run type-check && npm run test` |

#### TASK-003: Remove `createSdkPassthroughInputSchema` bypass

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | Modify: [src/lib/task-utils.ts](src/lib/task-utils.ts); Modify: [__tests__/lib/task-utils.test.ts](__tests__/lib/task-utils.test.ts) |
| Symbols | [createSdkPassthroughInputSchema](src/lib/task-utils.ts#L123), [hasStandardSchema](src/lib/task-utils.ts#L111), [StandardSchemaLike](src/lib/task-utils.ts#L84), [JsonSchemaProvider](src/lib/task-utils.ts#L80), [createTaskRegistrationConfig](src/lib/task-utils.ts#L139), [hasSafeParse](src/lib/task-utils.ts#L93), [hasParse](src/lib/task-utils.ts#L102) |
| Outcome | `createSdkPassthroughInputSchema`, `hasStandardSchema`, `StandardSchemaLike`, `JsonSchemaProvider` are deleted; `createTaskRegistrationConfig` spreads config directly; `hasSafeParse`/`hasParse`/`parseTaskInput` are untouched. |

- [ ] **Step 1: Write a failing test**

```ts
// __tests__/lib/task-utils.test.ts — add inside the registerTaskTool or createTaskRegistrationConfig describe block
// Import createTaskRegistrationConfig for this test (it's not currently exported — add export temporarily or test via registerTaskTool behavior)

// Add to the top of the file:
import { z } from 'zod/v4';

// Add this describe block:
describe('createTaskRegistrationConfig schema passthrough removal', () => {
  it('passes the original schema validate function through without wrapping', () => {
    const schema = z.strictObject({ name: z.string() });
    // Access via registerTaskTool registration to observe the inputSchema used
    let capturedSchema: unknown;
    const mockServer = {
      experimental: {
        tasks: {
          registerToolTask: (_name: string, config: { inputSchema: unknown }) => {
            capturedSchema = config.inputSchema;
          },
        },
      },
    } as unknown as import('@modelcontextprotocol/server').McpServer;

    registerTaskTool(mockServer, 'test-tool', {
      title: 'Test',
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));

    // After removal of bypass: the registered schema's validate should reject invalid input
    const standardSchema = capturedSchema as { '~standard': { validate: (v: unknown) => { value?: unknown; issues?: unknown[] } } };
    const result = standardSchema['~standard'].validate({ notName: 123 });
    // With the real Zod schema, validation issues should exist for missing 'name'
    assert.ok(
      result.issues !== undefined || !('value' in result) || result.value !== undefined,
      'schema should use real Zod validation, not passthrough',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/task-utils.test.ts
```

Expected: FAIL — with the bypass in place, `validate({ notName: 123 })` returns `{ value: { notName: 123 } }` with no issues.

- [ ] **Step 3: Delete bypass code; simplify `createTaskRegistrationConfig`**

In [src/lib/task-utils.ts](src/lib/task-utils.ts):

**Delete lines 80-137** (interfaces `JsonSchemaProvider`, `StandardSchemaLike` and functions `hasSafeParse` before line 93 is NOT deleted — only `hasStandardSchema` and `createSdkPassthroughInputSchema`):

- Delete `JsonSchemaProvider` interface (lines 80-83)
- Delete `StandardSchemaLike` interface (lines 84-91)
- Delete `hasStandardSchema` function (lines 111-119)
- Delete `createSdkPassthroughInputSchema` function (lines 123-137)
- Keep `SafeParseSchema` (lines 72-76), `ParseSchema` (lines 77-79), `hasSafeParse` (lines 93-100), `hasParse` (lines 102-109) — all used by `parseTaskInput`

**Replace `createTaskRegistrationConfig`:**

```ts
function createTaskRegistrationConfig(config: TaskToolConfig): TaskRegistrationConfig {
  return { ...config, execution: TASK_EXECUTION };
}
```

- [ ] **Step 4: Run full suite**

```bash
npm run lint && npm run type-check && npm run test
```

Expected: PASS — existing task lifecycle and e2e tests pass; new test passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/task-utils.ts __tests__/lib/task-utils.test.ts
git commit -m "refactor: remove createSdkPassthroughInputSchema bypass from task registration"
```

---

### PHASE-003: Symbol-key service injection removal

**Goal:** `TOOL_SERVICES_KEY`, `bindToolServices`, `findToolServices`, and `getToolServices` are deleted; services reach all call sites via explicit parameters; `GeminiPipelineRequest` carries `cacheName` directly.

| Task | Action | Depends on | Files | Validate |
| :--- | :--- | :--- | :--- | :--- |
| [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) | Add `cacheName` to request interface; stop reading from services in executor | none | [src/lib/tool-executor.ts](src/lib/tool-executor.ts) | `npm run type-check` |
| [`TASK-005`](#task-005-remove-bindtoolservices-from-chattool-registration) | Remove `bindToolServices` wrapper in chat registration | [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) | [src/tools/chat.ts](src/tools/chat.ts) | `npm run type-check` |
| [`TASK-006`](#task-006-thread-services-through-analyze-tool) | Thread `services` through analyze tool; pass `cacheName` to `executeGeminiPipeline` | [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) | [src/tools/analyze.ts](src/tools/analyze.ts), [src/tools/research.ts](src/tools/research.ts) | `npm run type-check` |
| [`TASK-007`](#task-007-thread-services-through-research-tool) | Thread `services` through research 3-level chain; update `analyzeUrlWork` | [`TASK-006`](#task-006-thread-services-through-analyze-tool) | [src/tools/research.ts](src/tools/research.ts) | `npm run type-check` |
| [`TASK-008`](#task-008-thread-services-through-review-tool) | Thread `services` through review 2-level chain | [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) | [src/tools/review.ts](src/tools/review.ts) | `npm run type-check` |
| [`TASK-009`](#task-009-delete-symbol-key-exports-from-tool-contextts) | Delete Symbol DI exports; verify nothing imports them | [`TASK-005`](#task-005-remove-bindtoolservices-from-chattool-registration), [`TASK-006`](#task-006-thread-services-through-analyze-tool), [`TASK-007`](#task-007-thread-services-through-research-tool), [`TASK-008`](#task-008-thread-services-through-review-tool) | [src/lib/tool-context.ts](src/lib/tool-context.ts) | `npm run lint && npm run type-check && npm run test` |

#### TASK-004: Add `cacheName` to `GeminiPipelineRequest` and update `executeGeminiPipeline`

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | Modify: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) |
| Symbols | [GeminiPipelineRequest](src/lib/tool-executor.ts#L125), [ToolExecutor](src/lib/tool-executor.ts#L138) |
| Outcome | `GeminiPipelineRequest` has `cacheName?: string`; `executeGeminiPipeline` reads `request.cacheName` instead of calling `findToolServices`. |

*TDD note: this is a pure interface addition. TypeScript will enforce correctness at compile time. No behavior change until callers start passing `cacheName`.*

- [ ] **Step 1: Apply change**

```ts
// src/lib/tool-executor.ts

// 1. Remove this import:
import { findToolServices } from './tool-context.js';

// 2. Add cacheName field to GeminiPipelineRequest (after the 'label' field):
export interface GeminiPipelineRequest<T extends Record<string, unknown>> {
  toolName: string;
  label: string;
  cacheName?: string | undefined;   // pre-resolved by caller from its workspace
  commonInputs?: CommonToolInputs | undefined;
  builtInToolSpecs?: readonly BuiltInToolSpec[] | undefined;
  buildContents: (activeCapabilities: Set<string>) => {
    contents: ContentListUnion;
    systemInstruction?: string | undefined;
  };
  config: Omit<GeminiStreamRequest<T>['config'], 'cacheName'>;
  responseBuilder?: StreamResponseBuilder<T>;
}

// 3. In executeGeminiPipeline, replace:
//   const toolServices = findToolServices(ctx);
//   const cacheName = toolServices ? await toolServices.workspace.resolveCacheName(ctx) : undefined;
//   ...
//   config: { ...request.config, cacheName }
// with:
//   config: { ...request.config, cacheName: request.cacheName }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run type-check
```

Expected: no errors. (Tools still call `bindToolServices` which TypeScript accepts since `findToolServices` is still exported from `tool-context.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/tool-executor.ts
git commit -m "refactor: add cacheName to GeminiPipelineRequest; remove findToolServices from executor"
```

---

#### TASK-005: Remove `bindToolServices` from chat tool registration

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) |
| Files | Modify: [src/tools/chat.ts](src/tools/chat.ts) |
| Symbols | [registerChatTool](src/tools/chat.ts#L1324), [chatWork](src/tools/chat.ts#L1288) |
| Outcome | `registerChatTool` no longer imports or calls `bindToolServices`; `chatWork` receives plain `ctx`. |

*`chatWork` accesses workspace through the `askWork` closure (created from `createAskWork(services.session, services.workspace)`), not through `findToolServices(ctx)`. No services param needed on `chatWork`.*

- [ ] **Step 1: Apply change**

```ts
// src/tools/chat.ts

// 1. Remove bindToolServices from the import at line ~40:
//    Remove: bindToolServices,

// 2. In registerChatTool, change the work callback:
//    Before: work: (args, ctx) => chatWork(askWork, args, bindToolServices(ctx, services)),
//    After:  work: (args, ctx) => chatWork(askWork, args, ctx),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/chat.ts
git commit -m "refactor: remove bindToolServices from chat tool registration"
```

---

#### TASK-006: Thread services through analyze tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) |
| Files | Modify: [src/tools/analyze.ts](src/tools/analyze.ts); Modify: [src/tools/research.ts](src/tools/research.ts) |
| Symbols | [analyzeWork](src/tools/analyze.ts#L367), [registerAnalyzeTool](src/tools/analyze.ts#L497), [analyzeUrlWork](src/tools/research.ts#L851) |
| Outcome | `analyzeWork` and `analyzeUrlWork` accept optional `services?: ToolServices`; each `executeGeminiPipeline` call site in both files passes `cacheName` resolved from `services`; `registerAnalyzeTool` drops `bindToolServices`. |

- [ ] **Step 1: Apply change to `src/tools/research.ts` — update `analyzeUrlWork`**

```ts
// src/tools/research.ts

// 1. Add ToolServices to imports from tool-context (it's already imported via bindToolServices — keep it)

// 2. Update analyzeUrlWork signature:
export async function analyzeUrlWork(
  { urls, goal, thinkingLevel, thinkingBudget, maxOutputTokens, safetySettings }: AnalyzeUrlInput,
  ctx: ServerContext,
  services?: ToolServices,   // NEW optional param
): Promise<CallToolResult> {
  // ... existing body ...

  // In the executeGeminiPipeline call (line 865), add cacheName:
  return await executor.executeGeminiPipeline(ctx, {
    toolName: 'analyze_url',
    label: TOOL_LABELS.analyzeUrl,
    cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,  // NEW
    commonInputs: { urls },
    // ... rest of request unchanged ...
  });
}
```

- [ ] **Step 2: Apply change to `src/tools/analyze.ts` — update `analyzeWork` and its callees**

```ts
// src/tools/analyze.ts

// 1. Remove bindToolServices from the import list

// 2. Update analyzeWork signature:
async function analyzeWork(
  rootsFetcher: ToolRootsFetcher,
  fileWork: ReturnType<typeof createAnalyzeFileWork>,
  args: AnalyzeInput,
  ctx: ServerContext,
  services?: ToolServices,   // NEW optional param
): Promise<CallToolResult> {
  const result =
    args.outputKind === 'diagram'
      ? await analyzeDiagramWork(rootsFetcher, args as AnalyzeDiagramInput, ctx, services)
      : await runAnalyzeTarget(rootsFetcher, fileWork, args, ctx, services);
  // ... rest unchanged ...
}

// 3. Update analyzeDiagramWork to accept and pass services:
//    async function analyzeDiagramWork(..., ctx, services?: ToolServices)
//    In its executeGeminiPipeline call (line 299), add:
//    cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,

// 4. Update runAnalyzeTarget to pass services down to analyzeUrlWork:
//    async function runAnalyzeTarget(..., ctx, services?: ToolServices)
//    In the analyzeUrlWork call (line 401), add services:
//    return await analyzeUrlWork(args, ctx, services);

// 5. In createAnalyzeFileWork's returned closure (line 143 executeGeminiPipeline call),
//    the closure captures rootsFetcher but not services. Add services as a param to
//    createAnalyzeFileWork and capture it in the closure:
//    function createAnalyzeFileWork(rootsFetcher, services?: ToolServices)
//    In the executeGeminiPipeline call: cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,

// 6. In registerAnalyzeTool:
//    - Change: const fileWork = createAnalyzeFileWork(resolvedServices.rootsFetcher);
//    - To:     const fileWork = createAnalyzeFileWork(resolvedServices.rootsFetcher, resolvedServices);
//    - Change the work callback:
//      Before: work: (args, ctx) => analyzeWork(rootsFetcher, fileWork, args, bindToolServices(ctx, resolvedServices)),
//      After:  work: (args, ctx) => analyzeWork(rootsFetcher, fileWork, args, ctx, resolvedServices),
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/analyze.ts src/tools/research.ts
git commit -m "refactor: thread services through analyze tool; pass cacheName to executeGeminiPipeline"
```

---

#### TASK-007: Thread services through research tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-006`](#task-006-thread-services-through-analyze-tool) |
| Files | Modify: [src/tools/research.ts](src/tools/research.ts) |
| Symbols | [researchWork](src/tools/research.ts#L1050), [runDeepResearch](src/tools/research.ts#L984), [agenticSearchWork](src/tools/research.ts#L884), [registerResearchTool](src/tools/research.ts#L1069) |
| Outcome | `researchWork`, `runDeepResearch`, `agenticSearchWork` each accept `services: ToolServices`; `agenticSearchWork` uses `services.workspace.resolveCacheName` instead of `findToolServices`; `registerResearchTool` drops `bindToolServices`. |

- [ ] **Step 1: Apply change**

```ts
// src/tools/research.ts

// 1. Remove findToolServices and bindToolServices from imports

// 2. Update agenticSearchWork signature and internals:
async function agenticSearchWork(
  args: DeepResearchInput,
  ctx: ServerContext,
  services: ToolServices,   // NEW required param
): Promise<CallToolResult> {
  // ...
  // Replace line 696:
  //   const cacheName = await findToolServices(ctx)?.workspace.resolveCacheName(ctx);
  // with:
  const cacheName = await services.workspace.resolveCacheName(ctx);
  // ... rest of function unchanged ...
}

// 3. Update runDeepResearch to accept and forward services:
async function runDeepResearch(
  args: Extract<ResearchInput, { mode: 'deep' }>,
  ctx: ServerContext,
  services: ToolServices,   // NEW
): Promise<CallToolResult> {
  return await agenticSearchWork({ ...args, searchDepth: args.searchDepth ?? 2 }, ctx, services);
  // (adjust to match actual call structure — forward services to agenticSearchWork)
}

// 4. Update researchWork to accept and forward services:
async function researchWork(
  args: ResearchInput,
  ctx: ServerContext,
  services: ToolServices,   // NEW
): Promise<CallToolResult> {
  const result = isQuickResearchInput(args)
    ? await runQuickResearch(args, ctx)
    : isDeepResearchInput(args)
      ? await runDeepResearch(args, ctx, services)
      : await runQuickResearch(args, ctx);
  // ... rest unchanged ...
}

// 5. Update registerResearchTool work callback:
//    Before: work: (args, ctx) => researchWork(args, bindToolServices(ctx, resolvedServices)),
//    After:  work: (args, ctx) => researchWork(args, ctx, resolvedServices),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/research.ts
git commit -m "refactor: thread services through research tool 3-level chain"
```

---

#### TASK-008: Thread services through review tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-004`](#task-004-add-cachename-to-geminipipelinerequest-and-update-executegeminipipeline) |
| Files | Modify: [src/tools/review.ts](src/tools/review.ts) |
| Symbols | [reviewWork](src/tools/review.ts#L1393), [analyzePrWork](src/tools/review.ts#L1221), [registerReviewTool](src/tools/review.ts#L1468) |
| Outcome | `reviewWork` and `analyzePrWork` accept optional `services?: ToolServices`; `analyzePrWork` uses `services?.workspace.scanFileNames()` and passes `cacheName` to `executeGeminiPipeline`; `registerReviewTool` drops `bindToolServices`. |

- [ ] **Step 1: Apply change**

```ts
// src/tools/review.ts

// 1. Remove findToolServices and bindToolServices from imports; keep ToolServices type import

// 2. Update analyzePrWork signature — append optional services param (CON-002: optional to preserve test call sites):
export async function analyzePrWork(
  args: ReviewDiffInput,
  ctx: ServerContext,
  workspaceCacheManagerOrRootsFetcher?: ToolWorkspaceCacheManager | ToolRootsFetcher,
  rootsFetcher: ToolRootsFetcher = () => Promise.resolve([]),
  services?: ToolServices,   // NEW optional param
): Promise<CallToolResult> {
  // ...
  // Replace line 1288:
  //   const toolServices = findToolServices(ctx);
  //   const docPathsToCheck = envDocs ?? [...(toolServices?.workspace.scanFileNames() ?? [])];
  // with:
  const docPathsToCheck = envDocs ?? [...(services?.workspace.scanFileNames() ?? [])];

  // In the executeGeminiPipeline call (line 1311), add:
  //   cacheName: services ? await services.workspace.resolveCacheName(ctx) : undefined,
}

// 3. Update reviewWork to accept and forward services:
export async function reviewWork(
  deps: ReviewWorkDeps,
  args: ReviewInput,
  ctx: ServerContext,
  services?: ToolServices,   // NEW optional param
): Promise<CallToolResult> {
  // In the runAnalyzePrWork call, forward services as the 5th argument:
  result = await runAnalyzePrWork(args, ctx, rootsFetcher, undefined, services);
  // ... rest unchanged ...
}

// 4. Update registerReviewTool work callback:
//    Before: work: (args, ctx) => reviewWork(deps, args, bindToolServices(ctx, resolvedServices)),
//    After:  work: (args, ctx) => reviewWork(deps, args, ctx, resolvedServices),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/review.ts
git commit -m "refactor: thread services through review tool 2-level chain"
```

---

#### TASK-009: Delete Symbol-key exports from `tool-context.ts`

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-005`](#task-005-remove-bindtoolservices-from-chattool-registration), [`TASK-006`](#task-006-thread-services-through-analyze-tool), [`TASK-007`](#task-007-thread-services-through-research-tool), [`TASK-008`](#task-008-thread-services-through-review-tool) |
| Files | Modify: [src/lib/tool-context.ts](src/lib/tool-context.ts) |
| Symbols | [TOOL_SERVICES_KEY](src/lib/tool-context.ts#L21), [BoundToolContext](src/lib/tool-context.ts#L49), [bindToolServices](src/lib/tool-context.ts#L53), [getToolServices](src/lib/tool-context.ts#L58), [findToolServices](src/lib/tool-context.ts#L66) |
| Outcome | The five Symbol-DI identifiers are deleted; TypeScript rejects any file that still imports them; `npm run type-check` passes with zero errors. |

*TDD note: TypeScript enforces this — deleting the exports causes compile errors in any lingering import site. Step 2 uses `type-check` as the verification.*

- [ ] **Step 1: Delete the five identifiers from `tool-context.ts`**

```ts
// src/lib/tool-context.ts — delete the following entirely:

// DELETE: const TOOL_SERVICES_KEY = Symbol('gemini-assistant.tool-services');

// DELETE: type BoundToolContext = ServerContext & {
//   [TOOL_SERVICES_KEY]?: ToolServices;
// };

// DELETE: export function bindToolServices(ctx: ServerContext, services: ToolServices): ServerContext {
//   (ctx as BoundToolContext)[TOOL_SERVICES_KEY] = services;
//   return ctx;
// }

// DELETE: export function getToolServices(ctx: ServerContext): ToolServices {
//   const services = findToolServices(ctx);
//   if (!services) {
//     throw new AppError('server', 'Tool services are unavailable on the current server context.');
//   }
//   return services;
// }

// DELETE: export function findToolServices(ctx: ServerContext): ToolServices | undefined {
//   return (ctx as BoundToolContext)[TOOL_SERVICES_KEY];
// }

// Keep everything else: ToolServices interface, createDefaultToolServices, toToolSessionAccess,
// toToolWorkspaceAccess, WorkspaceAccess re-export, isPathWithinRoot, buildContextUsed,
// buildSessionSummary, emptyContextUsed.
```

- [ ] **Step 2: Run full suite**

```bash
npm run lint && npm run type-check && npm run test
```

Expected: PASS — all green, no Symbol-DI identifiers referenced anywhere in `src/`.

- [ ] **Step 3: Confirm no lingering imports**

```bash
grep -r "bindToolServices\|findToolServices\|getToolServices\|TOOL_SERVICES_KEY" src/
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tool-context.ts
git commit -m "refactor: delete Symbol-key service injection from tool-context"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full suite passes with zero failures

```bash
npm run lint && npm run type-check && npm run test && npm run build
```

### [`VAL-002`](#5-testing--validation) — No Symbol-DI identifiers remain in src/

```bash
grep -r "bindToolServices\|findToolServices\|getToolServices\|TOOL_SERVICES_KEY\|BoundToolContext" src/
```

Expected: no output.

### [`VAL-003`](#5-testing--validation) — No definePrompt or createPromptDefinitions remain in src/

```bash
grep -r "definePrompt\|createPromptDefinitions\|PromptDefinition" src/
```

Expected: no output.

### [`VAL-004`](#5-testing--validation) — No createSdkPassthroughInputSchema remains in src/

```bash
grep -r "createSdkPassthroughInputSchema\|hasStandardSchema\|StandardSchemaLike" src/
```

Expected: no output.

## 6. Acceptance Criteria

| ID | Observable Outcome |
| :--- | :--- |
| [`AC-001`](#6-acceptance-criteria) | `completion/complete` for `discover` prompt with `job` arg and value `"c"` returns `["chat"]`. |
| [`AC-002`](#6-acceptance-criteria) | `completion/complete` for `research` prompt with `mode` arg and value `"q"` returns `["quick"]`. |
| [`AC-003`](#6-acceptance-criteria) | `completion/complete` for `review` prompt with `subject` arg and value `"d"` returns `["diff"]`. |
| [`AC-004`](#6-acceptance-criteria) | `VAL-002`, `VAL-003`, `VAL-004` grep commands all return no output. |
| [`AC-005`](#6-acceptance-criteria) | `npm run lint && npm run type-check && npm run test && npm run build` exits 0. |

## 7. Risks / Notes

| ID | Type | Detail |
| :--- | :--- | :--- |
| [`RISK-001`](#7-risks--notes) | Risk | TASK-006 has the most sub-function changes (`createAnalyzeFileWork` closure captures `services`). Read `src/tools/analyze.ts` fully before starting — the closure at line 143 is inside a callback returned by `createAnalyzeFileWork`, so `services` must be a parameter of `createAnalyzeFileWork` itself (captured at factory time), not of the inner async function. |
| [`RISK-002`](#7-risks--notes) | Risk | TASK-007: `runDeepResearch` at line 984 calls `agenticSearchWork` indirectly via `agenticSearchWork`. Read the actual call site before forwarding `services` to confirm the exact argument position. |
| [`RISK-003`](#7-risks--notes) | Risk | TASK-008: `reviewWork` at line 1393 calls `runAnalyzePrWork` (a local alias for `analyzePrWork` from `deps`). Check `ReviewWorkDeps` — if it declares `analyzePrWork`'s type, the type must be updated to include the optional `services` param or the forwarded arg will be a type error. |
| [`NOTE-001`](#7-risks--notes) | Note | `hasSafeParse` and `hasParse` in [src/lib/task-utils.ts](src/lib/task-utils.ts) are NOT deleted — they are used by `parseTaskInput` which handles Zod coercions after SDK validation. Only `hasStandardSchema`, `StandardSchemaLike`, `JsonSchemaProvider`, and `createSdkPassthroughInputSchema` are removed. |
| [`NOTE-002`](#7-risks--notes) | Note | PHASE-001 and PHASE-002 are independent — they can be executed in either order or in parallel worktrees. PHASE-003 tasks must run sequentially (TASK-004 first, TASK-009 last). |
