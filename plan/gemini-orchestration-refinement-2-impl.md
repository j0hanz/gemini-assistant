---
goal: Replace ad-hoc per-tool spec assembly with a declarative, validated profile system that enforces Google's Gemini 3 tool-combination rules.
version: 3
date_created: 2026-04-28
status: Planned
plan_type: refactor
component: gemini-orchestration
---

# Implementation Plan: Gemini 3 Orchestration Refinement

## 1. Goal

Replace ad-hoc per-tool spec assembly in orchestration with a declarative, validated profile system that enforces Google's documented Gemini 3 tool-combination rules, and rewire all four public tools (`chat`, `research`, `analyze`, `review`) to consume it. This reduces complexity and standardizes tool combination rules across the server.

## 2. Requirements & Constraints

| ID | Type | Statement |
| :---: | :--- | :--- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Implement a profile catalog with 11 profiles and a compatibility matrix in `tool-profiles.ts`. |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Unify tool spec input under a single `tools` field (`ToolsSpecSchema`), removing legacy boolean flags. |
| [`REQ-003`](#2-requirements--constraints) | Requirement | The 4 public tools must consume the new `resolveOrchestration` builder. |
| [`CON-001`](#2-requirements--constraints) | Constraint | Tool combinations must strictly enforce Google's Gemini 3 compatibility rules (e.g., `fileSearch` is mutually exclusive with everything else). |

## 3. Current Context

### Relevant files

| File | Why it matters |
| :--- | :--- |
| [src/lib/orchestration.ts](src/lib/orchestration.ts) | Contains the legacy orchestration logic to be refactored. |
| [src/schemas/inputs.ts](src/schemas/inputs.ts) | Defines the input schemas for the 4 public tools that need updating. |

### Relevant symbols

| Symbol | Why it matters |
| :--- | :--- |
| [resolveOrchestration](src/lib/orchestration.ts#L275) | Core orchestration builder function to be rewritten. |
| [ChatInputSchema](src/schemas/inputs.ts#L235) | Chat tool schema to be updated. |
| [ResearchInputSchema](src/schemas/inputs.ts#L360) | Research tool schema to be updated. |
| [AnalyzeInputSchema](src/schemas/inputs.ts#L500) | Analyze tool schema to be updated. |
| [ReviewInputSchema](src/schemas/inputs.ts#L641) | Review tool schema to be updated. |

### Existing commands

```bash
# Verify
npm run lint && npm run type-check && npm run test
```

### Current behavior

The orchestration logic currently uses ad-hoc boolean flags across different tools (like `googleSearch: true`) and manually assembles the `GenerateContentConfig` per tool, risking invalid tool combinations being sent to Gemini.

## 4. Implementation Phases

### PHASE-001: Tool Profiles Module

**Goal:** Implement the new profile catalog, compatibility matrix, and SDK configuration builders.

| Task | Action | Depends on | Files | Validate |
| :---: | :--- | :---: | :--- | :--- |
| [`TASK-001`](#task-001-implement-profile-catalog-and-matrix) | Create catalog & combo matrix | none | [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts); [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) | `npm test -- tool-profiles` |
| [`TASK-002`](#task-002-implement-resolveprofile-and-validateprofile) | Add profile resolution logic & SDK builders | [`TASK-001`](#task-001-implement-profile-catalog-and-matrix) | [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts); [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) | `npm test -- tool-profiles` |

#### TASK-001: Implement profile catalog and matrix

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts); [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) |
| Symbols | none |
| Action | Define `PROFILES` (11 profiles) and `COMBO_MATRIX` constants with their corresponding types. Add exhaustive tests for the catalog. |
| Validate | Run `npm run test` |
| Expected result | Tests pass, asserting all 11 profiles and correct matrix rules. |

#### TASK-002: Implement resolveProfile and validateProfile

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-001`](#task-001-implement-profile-catalog-and-matrix) |
| Files | [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts); [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) |
| Symbols | none |
| Action | Implement `resolveProfile` (with auto-promotions like plain+urls -> grounded, analyze+image+thinking>=medium -> visual-inspect), `validateProfile`, `buildToolsArray`, `buildToolConfig`, and `buildThinkingConfig`. Add exhaustive tests. |
| Validate | Run `npm run test` |
| Expected result | Tests pass asserting correct resolution, auto-promotions, and rejections (e.g., rag + urls). |

### PHASE-002: Orchestration Refactoring

**Goal:** Refactor orchestration.ts to use the new profile-driven builder.

| Task | Action | Depends on | Files | Validate |
| :---: | :--- | :---: | :--- | :--- |
| [`TASK-003`](#task-003-rewrite-orchestration-tests) | Rewrite tests for profile-driven API | [`TASK-002`](#task-002-implement-resolveprofile-and-validateprofile) | [**tests**/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts) | `npm test -- orchestration` |
| [`TASK-004`](#task-004-rewrite-resolveorchestration) | Rewrite resolveOrchestration | [`TASK-003`](#task-003-rewrite-orchestration-tests) | [src/lib/orchestration.ts](src/lib/orchestration.ts) | `npm test -- orchestration` |

#### TASK-003: Rewrite orchestration tests

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-002`](#task-002-implement-resolveprofile-and-validateprofile) |
| Files | [**tests**/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts) |
| Symbols | none |
| Action | Replace the file's contents with profile-driven tests. Assert that chat with no tools defaults to plain, research.deep emits correct built-ins, and temperature is never set. |
| Validate | Run `npm run test` (Expect tests to fail until TASK-004) |
| Expected result | Tests fail because `resolveOrchestration` is not yet updated. |

#### TASK-004: Rewrite resolveOrchestration

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-003`](#task-003-rewrite-orchestration-tests) |
| Files | [src/lib/orchestration.ts](src/lib/orchestration.ts) |
| Symbols | [resolveOrchestration](src/lib/orchestration.ts#L275) |
| Action | Replace legacy orchestration logic with a call to `resolveProfile`, followed by the SDK config builders. Return the assembled `OrchestrationResult`. Remove obsolete types. |
| Validate | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/orchestration.test.ts` |
| Expected result | The orchestration test suite passes. |

### PHASE-003: Schemas Updates

**Goal:** Introduce unified ToolsSpecSchema and apply it to all public tool schemas.

| Task | Action | Depends on | Files | Validate |
| :---: | :--- | :---: | :--- | :--- |
| [`TASK-005`](#task-005-add-toolsspecschema) | Add ToolsSpecSchema | [`TASK-004`](#task-004-rewrite-resolveorchestration) | [src/schemas/fields.ts](src/schemas/fields.ts) | `npm run type-check` |
| [`TASK-006`](#task-006-update-tool-inputs-schemas) | Update tools to use ToolsSpecSchema | [`TASK-005`](#task-005-add-toolsspecschema) | [src/schemas/inputs.ts](src/schemas/inputs.ts); [**tests**/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) | `npm test -- inputs` |

#### TASK-005: Add ToolsSpecSchema

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-004`](#task-004-rewrite-resolveorchestration) |
| Files | [src/schemas/fields.ts](src/schemas/fields.ts) |
| Symbols | none |
| Action | Add `ToolsSpecSchema`, `ProfileNameSchema`, `ThinkingLevelSchema`, `OverridesSchema`, and `FunctionCallingModeSchema`. Remove legacy boolean exports (like `temperatureField`, `OptionalFileSearchSpecSchema`). |
| Validate | Run `npm run type-check` |
| Expected result | Type check fails in places still using the deleted exports, preparing for TASK-006. |

#### TASK-006: Update tool inputs schemas

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-005`](#task-005-add-toolsspecschema) |
| Files | [src/schemas/inputs.ts](src/schemas/inputs.ts); [**tests**/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) |
| Symbols | [ChatInputSchema](src/schemas/inputs.ts#L235); [ResearchInputSchema](src/schemas/inputs.ts#L360); [AnalyzeInputSchema](src/schemas/inputs.ts#L500); [ReviewInputSchema](src/schemas/inputs.ts#L641) |
| Action | Rewrite `createChatInputSchema`, `createResearchInputSchema`, `createAnalyzeInputSchema`, and `createReviewInputSchema` to replace legacy tool flags with the single `tools: ToolsSpecSchema.optional()` field. Update tests to assert legacy flags are rejected. |
| Validate | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts` |
| Expected result | Inputs tests pass. |

### PHASE-004: Tool Handlers Migration

**Goal:** Wire the 4 public tool handlers to use the profile-driven resolveOrchestration.

| Task | Action | Depends on | Files | Validate |
| :---: | :--- | :---: | :--- | :--- |
| [`TASK-007`](#task-007-refactor-chat-tool) | Consume orchestration in chat | [`TASK-006`](#task-006-update-tool-inputs-schemas) | [src/tools/chat.ts](src/tools/chat.ts); [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts) | `npm test -- ask` |
| [`TASK-008`](#task-008-refactor-research-tool) | Consume orchestration in research | [`TASK-006`](#task-006-update-tool-inputs-schemas) | [src/tools/research.ts](src/tools/research.ts); [**tests**/tools/research.test.ts](__tests__/tools/research.test.ts) | `npm test -- research` |
| [`TASK-009`](#task-009-refactor-analyze-tool) | Consume orchestration in analyze | [`TASK-006`](#task-006-update-tool-inputs-schemas) | [src/tools/analyze.ts](src/tools/analyze.ts); [**tests**/tools/analyze-diagram-validation.test.ts](__tests__/tools/analyze-diagram-validation.test.ts); [**tests**/tools/analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts) | `npm test -- analyze` |
| [`TASK-010`](#task-010-refactor-review-tool) | Consume orchestration in review | [`TASK-006`](#task-006-update-tool-inputs-schemas) | [src/tools/review.ts](src/tools/review.ts); [**tests**/tools/pr.test.ts](__tests__/tools/pr.test.ts) | `npm test -- pr` |

#### TASK-007: Refactor chat tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-006`](#task-006-update-tool-inputs-schemas) |
| Files | [src/tools/chat.ts](src/tools/chat.ts); [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts) |
| Symbols | none |
| Action | Replace bespoke spec assembly with `resolveOrchestration`. Ensure `toolProfile` info is echoed in `structuredContent`. Update tests. |
| Validate | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ask.test.ts` |
| Expected result | Chat tests pass. |

#### TASK-008: Refactor research tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-006`](#task-006-update-tool-inputs-schemas) |
| Files | [src/tools/research.ts](src/tools/research.ts); [**tests**/tools/research.test.ts](__tests__/tools/research.test.ts) |
| Symbols | none |
| Action | Replace legacy building with `resolveOrchestration`. Apply per-tool defaults (web-research / deep-research) implicitly via the builder. Update tests. |
| Validate | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/research.test.ts` |
| Expected result | Research tests pass. |

#### TASK-009: Refactor analyze tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-006`](#task-006-update-tool-inputs-schemas) |
| Files | [src/tools/analyze.ts](src/tools/analyze.ts); [**tests**/tools/analyze-diagram-validation.test.ts](__tests__/tools/analyze-diagram-validation.test.ts); [**tests**/tools/analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts) |
| Symbols | none |
| Action | Replace legacy building with `resolveOrchestration`. Supply `hasImageInput` correctly so visual-inspect auto-promotion activates. Update tests. |
| Validate | Run tests matching analyze |
| Expected result | Analyze tests pass. |

#### TASK-010: Refactor review tool

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-006`](#task-006-update-tool-inputs-schemas) |
| Files | [src/tools/review.ts](src/tools/review.ts); [**tests**/tools/pr.test.ts](__tests__/tools/pr.test.ts) |
| Symbols | none |
| Action | Replace legacy building with `resolveOrchestration`. Map subject correctly (diff -> plain, failure -> web-research, compare -> urls-only or plain). Update tests. |
| Validate | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/pr.test.ts` |
| Expected result | Review tests pass. |

### PHASE-005: Discovery & Contract

**Goal:** Expose the new capabilities via gemini://profiles resource and update the public contract.

| Task | Action | Depends on | Files | Validate |
| :---: | :--- | :---: | :--- | :--- |
| [`TASK-011`](#task-011-register-geminiprofiles-resource) | Register gemini://profiles | none | [src/resources.ts](src/resources.ts); [**tests**/resources.test.ts](__tests__/resources.test.ts) | `npm test -- resources` |
| [`TASK-012`](#task-012-update-contract-and-e2e) | Update contract, E2E, bump package version | [`TASK-011`](#task-011-register-geminiprofiles-resource) | [src/public-contract.ts](src/public-contract.ts); [src/catalog.ts](src/catalog.ts); [**tests**/schemas/public-contract.test.ts](__tests__/schemas/public-contract.test.ts); [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts); [package.json](package.json) | `npm run check` |

#### TASK-011: Register gemini://profiles resource

| Field | Value |
| :--- | :--- |
| Depends on | none |
| Files | [src/resources.ts](src/resources.ts); [**tests**/resources.test.ts](__tests__/resources.test.ts) |
| Symbols | none |
| Action | Add a read-only resource `gemini://profiles` that returns the profiles list, combo matrix, modifiers, and per-tool defaults. Add tests. |
| Validate | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources.test.ts` |
| Expected result | Resource tests pass. |

#### TASK-012: Update contract and E2E

| Field | Value |
| :--- | :--- |
| Depends on | [`TASK-011`](#task-011-register-geminiprofiles-resource) |
| Files | [src/public-contract.ts](src/public-contract.ts); [src/catalog.ts](src/catalog.ts); [**tests**/schemas/public-contract.test.ts](__tests__/schemas/public-contract.test.ts); [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts); [package.json](package.json) |
| Symbols | none |
| Action | Update example inputs in public contract and catalog to use the new `tools` field. Add E2E tests for profile defaults and combo rejections. Bump major version in `package.json`. |
| Validate | Run `npm run check` |
| Expected result | Full validation suite passes. |

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Static analysis

```bash
npm run type-check && npm run lint
```

### [`VAL-002`](#5-testing--validation) — Test suite

```bash
npm run test
```

## 6. Acceptance Criteria

| ID | Observable Outcome |
| :---: | :--- |
| [`AC-001`](#6-acceptance-criteria) | All 4 tools accept the single `tools` spec field and reject legacy fields. |
| [`AC-002`](#6-acceptance-criteria) | `gemini://profiles` resource successfully returns a JSON structure containing 11 profiles. |
| [`AC-003`](#6-acceptance-criteria) | The full validation suite (`npm run check`) runs cleanly. |

## 7. Risks / Notes

| ID | Type | Detail |
| :---: | :--- | :--- |
| [`RISK-001`](#7-risks--notes) | Risk | The `package.json` major version bump is strictly necessary as public inputs and responses change shape. |
| [`NOTE-001`](#7-risks--notes) | Note | Do not forget to remove dangling references to `BuiltInToolSpec`, `selectSearchAndUrlContextTools`, and `temperatureField`. |
