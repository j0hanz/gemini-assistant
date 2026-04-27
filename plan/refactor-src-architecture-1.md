---
goal: Reduce coupling and duplication across `src/` by introducing narrow service interfaces, a shared tool runtime context, and consolidating response/validation/JSON helpers.
version: 1
date_created: 2026-04-27
status: Planned
plan_type: refactor
component: src-architecture
---

# Implementation Plan: src/ Architecture Refactor

## 1. Goal

The `src/` layer has working tool isolation but leaks workspace/session internals into `tools/`, duplicates response and validation scaffolding across `tools/analyze.ts`, `tools/chat.ts`, `tools/research.ts`, and `tools/review.ts`, and exposes mutable singletons. This refactor introduces a `ServerContext`-based injection surface, a `createToolContext()` runtime façade, and consolidates JSON/response/structured-validation helpers into `lib/`. Completion is observed when tools no longer import from `lib/validation.ts` or `lib/workspace-context.ts` directly, duplicate progress/validation boilerplate is removed, and `npm run lint`, `npm run type-check`, and `npm run test` all pass.

## 2. Requirements & Constraints

- **REQ-001**: All four tool modules (`analyze.ts`, `chat.ts`, `research.ts`, `review.ts`) must obtain workspace state and progress via injected dependencies, not module-level imports from `lib/workspace-context.ts` or `lib/validation.ts`.
- **REQ-002**: A single `buildStructuredResponse()` helper in `lib/response.ts` must be the only producer of shared structured metadata fields (`usage`, `functionCalls`, `toolEvents`, `citations`).
- **REQ-003**: Session mutation from tools must go through a narrow `SessionAccess` interface; `ContentEntry`, `SessionEventEntry`, and `SessionGenerationContract` must not be imported from `tools/`.
- **REQ-004**: `DISCOVERY_ENTRIES` in `src/public-contract.ts` must be derived from the live tool/prompt registry instead of hand-maintained.
- **REQ-005**: A single `lib/json.ts` module must own JSON parsing helpers consumed by `lib/response.ts`, `schemas/inputs.ts`, and `tools/research.ts`.
- **CON-001**: Public MCP surface (`tools/list`, `prompts/list`, `resources/list`, `tasks/*` endpoints) must remain byte-compatible — no schema, name, or description changes.
- **CON-002**: Existing test files under `__tests__/` must continue to pass without behavioral edits beyond import path updates.
- **CON-003**: No new dependencies; refactor uses only existing packages.
- **SEC-001**: `getAllowedRoots()` semantics (path containment, deny-by-default) must be preserved when access is funneled through `ServerContext`.
- **PAT-001**: Follow `src/lib/tool-executor.ts` style for stateless helpers and `src/lib/orchestration.ts` for context plumbing.
- **PAT-002**: Follow existing Zod v4 + `z.toJSONSchema()` conventions per `src/schemas/`.

## 3. Current Context

- Relevant files:
  - `src/server.ts` — owns tool registration; current injection point for `SessionStore` and `WorkspaceCacheManager`.
  - `src/sessions.ts` — exports `ContentEntry`, `SessionEventEntry`, `SessionGenerationContract`; mutable `Map`/`Set` session state.
  - `src/public-contract.ts` — hand-maintained `DISCOVERY_ENTRIES`.
  - `src/catalog.ts`, `src/prompts.ts` — live registry sources for tools and prompts.
  - `src/tools/analyze.ts`, `src/tools/chat.ts`, `src/tools/research.ts`, `src/tools/review.ts` — duplicate progress/validation/URL-check boilerplate; reach into `lib/validation.ts` and `lib/workspace-context.ts`.
  - `src/lib/response.ts` — `buildSharedStructuredMetadata`, `tryParseJsonResponse`.
  - `src/lib/validation.ts` — `getAllowedRoots`, `safeValidateStructuredContent`, URL validators.
  - `src/lib/workspace-context.ts` — `getWorkspaceCacheName`, `SCAN_FILE_NAMES`.
  - `src/lib/progress.ts` — `ProgressReporter`.
  - `src/schemas/inputs.ts` — `parseResponseSchemaJsonValue`.
  - `src/client.ts` — `let _ai` Gemini singleton.
  - `src/lib/event-store.ts`, `src/transport.ts` — module-level mutable maps and counters.

- Existing commands:
  - Format: `npm run format`
  - Lint: `npm run lint`
  - Typecheck: `npm run type-check`
  - Test: `npm run test`
  - Build: `npm run build` (ask before running per AGENTS.md)

- Current behavior:
  - Each tool independently constructs its `ProgressReporter`, calls `safeValidateStructuredContent`, validates URLs, and reaches into workspace/validation helpers. Session persistence is performed by tools calling three separate appender methods directly. `DISCOVERY_ENTRIES` mirrors registered tools by hand.

## 4. Implementation Phases

### PHASE-001: Introduce narrow service interfaces

Goal: Replace concrete-type tool dependencies with narrow interfaces injected via `ServerContext`.

#### TASK-001: Define `WorkspaceAccess` interface

- Depends on: none
- Files:
  - `src/lib/workspace-context.ts`
- Change:
  - Export interface `WorkspaceAccess` with members: `allowedRoots(): readonly string[]`, `cacheName(): string | undefined`, `scanFileNames(): readonly string[]`.
  - Add `createWorkspaceAccess(manager)` factory returning `WorkspaceAccess` backed by existing functions.
  - Keep existing standalone exports during migration.
- Validate:
  - Run `npm run type-check`
- Expected result:
  - TypeScript exits with code `0`.

#### TASK-002: Define `SessionAccess` interface

- Depends on: none
- Files:
  - `src/sessions.ts`
- Change:
  - Export interface `SessionAccess` with: `appendTurn(id, parts, metadata)`, `appendEvent(id, event)`, `appendTranscript(id, transcript)`, `getSession(id)`, `evict(id)`.
  - Add `createSessionAccess(store)` factory wrapping `SessionStore`.
  - Mark `ContentEntry`, `SessionEventEntry`, `SessionGenerationContract` exports `@internal` via JSDoc; do not remove yet.
- Validate:
  - Run `npm run type-check`
- Expected result:
  - TypeScript exits with code `0`.

#### TASK-003: Extend `ServerContext` with workspace and session access

- Depends on: TASK-001, TASK-002
- Files:
  - `src/server.ts`
  - `src/lib/orchestration.ts` (if `ServerContext` is defined there; otherwise wherever it is exported)
- Change:
  - Add fields `workspace: WorkspaceAccess` and `session: SessionAccess` to `ServerContext`.
  - Populate them in `registerServerTools()` from existing `WorkspaceCacheManager` and `SessionStore` instances.
- Validate:
  - Run `npm run type-check`
- Expected result:
  - TypeScript exits with code `0`.

### PHASE-002: Migrate tools to injected dependencies

Goal: Eliminate direct `tools/ → lib/validation.ts` and `tools/ → lib/workspace-context.ts` imports.

#### TASK-004: Migrate `tools/chat.ts` to `SessionAccess` and `WorkspaceAccess`

- Depends on: TASK-003
- Files:
  - `src/tools/chat.ts`
- Change:
  - Replace direct imports of `getAllowedRoots`, `getWorkspaceCacheName` with `ctx.workspace.*`.
  - Replace `appendSessionContent`, `appendSessionEvent`, `appendSessionTranscript` calls with `ctx.session.appendTurn()`.
  - Update `AskDependencies` to remove `ContentEntry` references.
- Validate:
  - Run `npm run type-check && npm run test -- __tests__/tools/ask.test.ts __tests__/tools/ask-structured.test.ts __tests__/tools/ask-transcript.test.ts`
- Expected result:
  - All targeted tests pass; type-check exits `0`.

#### TASK-005: Migrate `tools/research.ts`

- Depends on: TASK-003
- Files:
  - `src/tools/research.ts`
- Change:
  - Replace `getWorkspaceCacheName` import with `ctx.workspace.cacheName()`.
  - Route any session writes through `ctx.session`.
- Validate:
  - Run `npm run test -- __tests__/tools/research.test.ts`
- Expected result:
  - Test suite passes.

#### TASK-006: Migrate `tools/review.ts`

- Depends on: TASK-003
- Files:
  - `src/tools/review.ts`
- Change:
  - Replace `SCAN_FILE_NAMES` import with `ctx.workspace.scanFileNames()`.
  - Replace any `getAllowedRoots` access with `ctx.workspace.allowedRoots()`.
- Validate:
  - Run `npm run test -- __tests__/tools/pr.test.ts`
- Expected result:
  - Test suite passes.

#### TASK-007: Migrate `tools/analyze.ts`

- Depends on: TASK-003
- Files:
  - `src/tools/analyze.ts`
- Change:
  - Replace any `getAllowedRoots` / workspace-context imports with `ctx.workspace.*`.
- Validate:
  - Run `npm run test -- __tests__/tools/analyze-diagram-validation.test.ts __tests__/tools/analyze-diagram-progress.test.ts`
- Expected result:
  - Targeted suites pass.

### PHASE-003: Consolidate runtime helpers

Goal: Remove duplicate `ProgressReporter`/structured-validation/URL-check boilerplate from tool entry points.

#### TASK-008: Add `createToolContext()` runtime façade

- Depends on: TASK-003
- Files:
  - `src/lib/tool-executor.ts`
- Change:
  - Export `createToolContext(name: ToolName, ctx: ServerContext)` returning `{ progress, validateInputs(opts), validateOutput(schema, value) }`.
  - `progress` wraps `new ProgressReporter(ctx, TOOL_LABELS[name])`.
  - `validateInputs` accepts `{ urls?, fileSearch?, responseSchema? }` and runs existing validators.
  - `validateOutput` wraps `safeValidateStructuredContent`.
- Validate:
  - Run `npm run type-check`
- Expected result:
  - TypeScript exits `0`.

#### TASK-009: Adopt `createToolContext` in all four tools

- Depends on: TASK-008
- Files:
  - `src/tools/analyze.ts`
  - `src/tools/chat.ts`
  - `src/tools/research.ts`
  - `src/tools/review.ts`
- Change:
  - Replace inline `new ProgressReporter(...)` with `const tc = createToolContext(name, ctx); tc.progress`.
  - Replace inline `safeValidateStructuredContent` calls with `tc.validateOutput(...)`.
  - Replace duplicated URL pre-flight blocks in `chat.ts` and `review.ts` with `tc.validateInputs({ urls })`.
- Validate:
  - Run `npm run lint && npm run type-check && npm run test`
- Expected result:
  - All commands exit `0`; full suite passes.

#### TASK-010: Centralize structured response builder

- Depends on: TASK-009
- Files:
  - `src/lib/response.ts`
  - `src/tools/chat.ts`
  - `src/tools/research.ts`
- Change:
  - In `lib/response.ts`, export `buildStructuredResponse(result, metadata, domainExtras)` consolidating logic from `buildSharedStructuredMetadata`.
  - Replace `buildAskStructuredContent` (in `chat.ts`) and `buildAgenticSearchResult` (in `research.ts`) with calls to `buildStructuredResponse`, passing only domain-specific fields as `domainExtras`.
- Validate:
  - Run `npm run test -- __tests__/lib/response.test.ts __tests__/tools/ask-structured.test.ts __tests__/tools/research.test.ts`
- Expected result:
  - All targeted suites pass.

#### TASK-011: Consolidate JSON parsing into `lib/json.ts`

- Depends on: none
- Files:
  - `src/lib/json.ts` (new)
  - `src/lib/response.ts`
  - `src/schemas/inputs.ts`
  - `src/tools/research.ts`
- Change:
  - Create `lib/json.ts` exporting `parseJson<T>(text, opts?: { fallback?, schema? })` with consistent error logging via `lib/logger.ts`.
  - Replace `tryParseJsonResponse`, `parseResponseSchemaJsonValue`, and `parsePlannedSubQueries` internals with calls to `parseJson`.
  - Keep existing exported function names as thin wrappers for backward compatibility.
- Validate:
  - Run `npm run test`
- Expected result:
  - Full suite passes.

### PHASE-004: Derive discovery from registry and tighten state

Goal: Eliminate hand-maintained discovery list and harden mutable singletons.

#### TASK-012: Generate `DISCOVERY_ENTRIES` from registry

- Depends on: none
- Files:
  - `src/public-contract.ts`
  - `src/catalog.ts`
  - `src/prompts.ts`
- Change:
  - Replace the static `DISCOVERY_ENTRIES` array with a function `buildDiscoveryEntries({ tools, prompts, resources })` that maps `catalog.ts` tool definitions and `prompts.ts` definitions to discovery entries.
  - Update consumers to call the function once at server bootstrap and cache the result.
- Validate:
  - Run `npm run test -- __tests__/catalog.test.ts __tests__/schemas/public-contract.test.ts`
- Expected result:
  - Both suites pass; emitted discovery payload byte-equal to the previous hand-maintained list (verified by snapshot or deep-equal assertion).

#### TASK-013: Harden session eviction atomicity

- Depends on: TASK-002
- Files:
  - `src/sessions.ts`
- Change:
  - In every code path that inserts or replaces an entry in the active session map, call `evictedSessions.delete(id)` immediately before `sessions.set(id, entry)`.
- Validate:
  - Run `npm run test -- __tests__/sessions.test.ts`
- Expected result:
  - Suite passes.

#### TASK-014: Wrap Gemini client singleton

- Depends on: none
- Files:
  - `src/client.ts`
- Change:
  - Replace `let _ai` module variable with a `GeminiClientHolder` class instance (`{ get(): GoogleGenAI }`) exported via existing `getAI()` API.
  - Keep `getAI()` signature unchanged.
- Validate:
  - Run `npm run test -- __tests__/client.test.ts`
- Expected result:
  - Suite passes.

### PHASE-005: Remove deprecated exports

Goal: Drop transitional exports once all tools are migrated.

#### TASK-015: Remove tool-side imports of deprecated helpers

- Depends on: TASK-004, TASK-005, TASK-006, TASK-007, TASK-009
- Files:
  - `src/lib/workspace-context.ts`
  - `src/lib/validation.ts`
  - `src/sessions.ts`
- Change:
  - Verify no `tools/*.ts` file still imports `getAllowedRoots`, `getWorkspaceCacheName`, `SCAN_FILE_NAMES`, `ContentEntry`, `SessionEventEntry`, or `SessionGenerationContract`.
  - Mark those symbols `@internal` and remove from barrel exports if present.
- Validate:
  - Run `npm run lint && npm run type-check && npm run test`
- Expected result:
  - All commands exit `0`; `grep -R "getAllowedRoots\|getWorkspaceCacheName\|SCAN_FILE_NAMES" src/tools` returns no matches.

## 5. Testing & Validation

- **VAL-001**: `npm run lint` exits `0`.
- **VAL-002**: `npm run type-check` exits `0`.
- **VAL-003**: `npm run test` runs the full Node test runner suite (currently 31 files) with zero failures.
- **VAL-004**: `grep -R "from '.*lib/workspace-context'\|from '.*lib/validation'" src/tools` returns no matches after PHASE-002.
- **VAL-005**: Snapshot or deep-equal assertion in `__tests__/schemas/public-contract.test.ts` confirms `DISCOVERY_ENTRIES` payload is unchanged after TASK-012.

## 6. Acceptance Criteria

- **AC-001**: No file under `src/tools/` imports from `src/lib/workspace-context.ts` or `src/lib/validation.ts`.
- **AC-002**: `lib/response.ts` is the sole producer of structured metadata fields (`usage`, `functionCalls`, `toolEvents`, `citations`); `buildAskStructuredContent` and `buildAgenticSearchResult` are gone or are thin wrappers around `buildStructuredResponse`.
- **AC-003**: Each tool in `src/tools/` constructs its progress reporter and validates structured output through `createToolContext()` exactly once.
- **AC-004**: `DISCOVERY_ENTRIES` is computed from the tool/prompt registry; manual edits are no longer required when adding a tool.
- **AC-005**: `SessionStore.storeSession()` and any sibling insertion paths atomically remove the id from `evictedSessions`.
- **AC-006**: Public MCP `tools/list`, `prompts/list`, `resources/list` outputs are byte-identical pre- and post-refactor (verified by existing contract tests).
- **AC-007**: `npm run lint`, `npm run type-check`, and `npm run test` all pass.

## 7. Risks / Notes

- **RISK-001**: Changing `ServerContext` shape may break in-tree test fixtures that build a partial context. Mitigation: provide a `createTestServerContext()` helper or default the new fields to no-op implementations during the transition.
- **RISK-002**: Replacing `DISCOVERY_ENTRIES` may shift property ordering in serialized output. Mitigation: assert deep equality (not stringified equality) and, if needed, sort keys deterministically before emission.
- **NOTE-001**: Per `AGENTS.md`, ask before running `npm run build`; lint/type-check/test are always-allowed.
- **NOTE-002**: Per existing user-memory note, reinsertion into the active session map must always purge the evicted set — TASK-013 codifies this.
- **NOTE-003**: Keep `exactOptionalPropertyTypes` semantics in mind when widening `ServerContext`; use conditional spreads for optional fields.
