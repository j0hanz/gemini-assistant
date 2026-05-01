---
goal: Address MCP-spec, GenAI SDK, and robustness issues identified in the ingest tool inspection
version: 1
date_created: 2026-05-01
status: Planned
plan_type: refactor
component: ingest-tool
---

# Implementation Plan: Ingest tool MCP & GenAI conformance pass

## 1. Goal

Bring the [ingest](src/tools/ingest.ts) tool into line with MCP `CallToolResult` conventions and Google Gen AI SDK best practices. After this plan: destructive operations advertise `destructiveHint: true`, resource links travel inside `content` (not as a non-spec top-level field), upload supports `AbortSignal` cancellation, document identifiers are never spoofed by display names, and per-operation output is unambiguous. Success is observable by passing the existing test suite plus new tests covering cancellation, destructive annotations, and document-id propagation.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                                                                                                                 |
| :---------------------------------------: | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `delete-store` and `delete-document` operations MUST register with `destructiveHint: true`.                                                                                                                                                                               |
| [`REQ-002`](#2-requirements--constraints) | Requirement | `CallToolResult` MUST NOT carry a non-spec top-level `resourceLink` field; resource links MUST be emitted as `{ type: 'resource_link', ... }` content items.                                                                                                              |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Single-file [uploadOne](src/tools/ingest.ts#L228) MUST throw when the SDK does not return a real document resource name; it MUST NOT fall back to `displayName`.                                                                                                          |
| [`REQ-004`](#2-requirements--constraints) | Requirement | [uploadOne](src/tools/ingest.ts#L228) and [uploadAll](src/tools/ingest.ts#L259) MUST honour `ctx.task?.cancellationSignal` (forward to SDK and abort between batches).                                                                                                    |
| [`REQ-005`](#2-requirements--constraints) | Requirement | Duplicated `filePath` / `documentName` runtime guards in [handleUpload](src/tools/ingest.ts#L394) and [handleDeleteDocument](src/tools/ingest.ts#L504) MUST be removed; [IngestInputSchema](src/schemas/ingest-input.ts#L56) `superRefine` is the single source of truth. |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Public tool name `ingest` and the four operation IDs MUST NOT change.                                                                                                                                                                                                     |
| [`CON-002`](#2-requirements--constraints) | Constraint  | Existing 334+ tests MUST continue to pass (`node scripts/tasks.mjs`).                                                                                                                                                                                                     |
| [`CON-003`](#2-requirements--constraints) | Constraint  | Use `zod/v4` patterns already established in [IngestInputSchema](src/schemas/ingest-input.ts#L56); no introduction of `zod-to-json-schema`.                                                                                                                               |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow the per-tool registration shape used by [registerIngestTool](src/tools/ingest.ts#L607); split into two registrations only if a single annotations object cannot express both read-mutating and destructive intent.                                                 |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Reuse [READONLY_NON_IDEMPOTENT_ANNOTATIONS](src/lib/tasks.ts#L271) / [MUTABLE_ANNOTATIONS](src/lib/tasks.ts#L278) shape; add a sibling constant rather than redefining annotations inline.                                                                                |
| [`SEC-001`](#2-requirements--constraints) | Security    | Cancellation MUST stop further uploads even when batches are in-flight; orphaned uploads after abort are tolerable but new uploads MUST NOT start.                                                                                                                        |

## 3. Current Context

### Relevant files

| File                                                             | Why it matters                                                                           |
| :--------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| [src/tools/ingest.ts](src/tools/ingest.ts)                       | Tool implementation, all four operation handlers, and the registration entry point.      |
| [src/schemas/ingest-input.ts](src/schemas/ingest-input.ts)       | Flat input schema with `superRefine` already enforcing per-operation field requirements. |
| [src/schemas/ingest-output.ts](src/schemas/ingest-output.ts)     | Output schema; today every per-op field is optional.                                     |
| [src/lib/tasks.ts](src/lib/tasks.ts)                             | Defines shared annotation constants and `registerWorkTool`.                              |
| [src/resources/links.ts](src/resources/links.ts)                 | `appendResourceLinks` returns `ResourceLink[]`; ingest currently attaches them off-spec. |
| [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts) | Existing schema/contract tests; new behavioural tests will be added here.                |
| [src/client.ts](src/client.ts)                                   | `getAI()` lazy GoogleGenAI client; relevant for SDK abort-signal forwarding.             |

### Relevant symbols

| Symbol                                                       | Why it matters                                                                     |
| :----------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| [registerIngestTool](src/tools/ingest.ts#L607)               | Single registration entry; will need to switch annotations per operation.          |
| [ingestWork](src/tools/ingest.ts#L531)                       | Dispatcher; emits the off-spec `resourceLink` field today.                         |
| [handleUpload](src/tools/ingest.ts#L394)                     | Hosts the duplicate `filePath` guard and triggers single/batch uploads.            |
| [handleDeleteDocument](src/tools/ingest.ts#L504)             | Hosts the duplicate `documentName` guard; destructive operation.                   |
| [handleDeleteStore](src/tools/ingest.ts#L486)                | Destructive (`force: true`) — needs destructive annotation routing.                |
| [uploadOne](src/tools/ingest.ts#L228)                        | Returns `displayName` as a doc id when SDK omits one — bug fixed by REQ-003.       |
| [uploadAll](src/tools/ingest.ts#L259)                        | Batches uploads with progress; needs cancellation between batches.                 |
| [resolveStore](src/tools/ingest.ts#L339)                     | Auto-create on upload; surface `created` as typed output, not only in the message. |
| [IngestInputSchema](src/schemas/ingest-input.ts#L56)         | `superRefine` already enforces required-field rules (REQ-005).                     |
| [IngestOutputSchema](src/schemas/ingest-output.ts#L6)        | Add a typed `created?: boolean` field for upload responses.                        |
| [MUTABLE_ANNOTATIONS](src/lib/tasks.ts#L278)                 | Source of the current (incorrect for delete) `destructiveHint: false`.             |
| [READONLY_NON_IDEMPOTENT_ANNOTATIONS](src/lib/tasks.ts#L271) | Reference shape for adding a `DESTRUCTIVE_ANNOTATIONS` sibling.                    |
| [appendResourceLinks](src/resources/links.ts#L31)            | Continues to return `ResourceLink[]`; consumer (ingest) must repackage as content. |

### Existing commands

```bash
# Full verification (preferred)
node scripts/tasks.mjs

# Single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts
```

### Current behavior

`ingest` registers all four operations under a single tool with `MUTABLE_ANNOTATIONS` (`destructiveHint: false`), even though `delete-store` calls the SDK with `force: true` and `delete-document` is irreversible. The handler returns `{ ...validated, resourceLink }` — `resourceLink` is not part of the MCP `CallToolResult` schema and is silently dropped by spec-compliant clients. `uploadOne` falls back to `displayName` when the SDK omits a document name, which then fails any subsequent `delete-document` because that path expects a real `…/documents/<id>` suffix. The upload pipeline ignores `ctx.task?.cancellationSignal`. Input schema and handler logic both validate `filePath` / `documentName` presence (duplicate enforcement). Auto-store-creation during upload is reported only as prose in `message`.

## 4. Implementation Phases

### PHASE-001: Schema & annotation foundations

**Goal:** Add the typed primitives needed by the handler refactors without changing runtime behaviour yet.

|                               Task                               | Action                                                                                          | Depends on | Files                                                                                                                          | Validate                                                                                    |
| :--------------------------------------------------------------: | :---------------------------------------------------------------------------------------------- | :--------: | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
|   [`TASK-001`](#task-001-add-destructive-annotations-constant)   | Add `DESTRUCTIVE_ANNOTATIONS` sibling constant.                                                 |    none    | [src/lib/tasks.ts](src/lib/tasks.ts)                                                                                           | `npm run type-check`                                                                        |
| [`TASK-002`](#task-002-extend-ingest-output-schema-with-created) | Add optional `created: boolean` field to [IngestOutputSchema](src/schemas/ingest-output.ts#L6). |    none    | [src/schemas/ingest-output.ts](src/schemas/ingest-output.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts` |

#### TASK-001: Add destructive annotations constant

| Field           | Value                                                                                                                                                                                        |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                         |
| Files           | [src/lib/tasks.ts](src/lib/tasks.ts)                                                                                                                                                         |
| Symbols         | [MUTABLE_ANNOTATIONS](src/lib/tasks.ts#L278); [READONLY_NON_IDEMPOTENT_ANNOTATIONS](src/lib/tasks.ts#L271)                                                                                   |
| Action          | Add `export const DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;` next to the existing annotation constants. |
| Validate        | Run `npm run type-check`                                                                                                                                                                     |
| Expected result | Type-check passes; new export is consumable by `src/tools/ingest.ts`.                                                                                                                        |

#### TASK-002: Extend ingest output schema with `created`

| Field           | Value                                                                                                                                                                                               |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                |
| Files           | [src/schemas/ingest-output.ts](src/schemas/ingest-output.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts)                                                                      |
| Symbols         | [IngestOutputSchema](src/schemas/ingest-output.ts#L6)                                                                                                                                               |
| Action          | Add `created` as `optionalField(withFieldMetadata(z.boolean(), 'True if the store was auto-created during this upload'))`. Add a schema-validation test asserting the field is accepted and parsed. |
| Validate        | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts`                                                                                                     |
| Expected result | New field is present in the schema; existing tests still pass; new test covering `created: true` parsing passes.                                                                                    |

### PHASE-002: Handler & registration corrections

**Goal:** Apply the destructive annotation routing, cancellation plumbing, and contract corrections that depend on PHASE-001 primitives.

|                                 Task                                  | Action                                                                                          |                            Depends on                            | Files                                                                                                        | Validate                                                                                    |
| :-------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
|   [`TASK-003`](#task-003-split-registration-by-destructive-intent)    | Split `registerIngestTool` into read/mutate vs destructive-annotated registrations.             |   [`TASK-001`](#task-001-add-destructive-annotations-constant)   | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                   | `node scripts/tasks.mjs --quick`                                                            |
| [`TASK-004`](#task-004-replace-resourcelink-field-with-content-items) | Move `resourceLink` from top-level result into `content` as `resource_link` items.              |                               none                               | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                   | `node scripts/tasks.mjs --quick`                                                            |
|    [`TASK-005`](#task-005-fail-fast-when-sdk-omits-document-name)     | Make `uploadOne` throw when neither `op.response?.documentName` nor `op.name` is present.       |                               none                               | [src/tools/ingest.ts](src/tools/ingest.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts` |
|   [`TASK-006`](#task-006-thread-cancellationsignal-through-uploads)   | Forward `ctx.task?.cancellationSignal` into SDK calls and abort between batches in `uploadAll`. |                               none                               | [src/tools/ingest.ts](src/tools/ingest.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts` |
|        [`TASK-007`](#task-007-remove-duplicate-runtime-guards)        | Remove duplicate `filePath` / `documentName` runtime checks in handlers.                        |                               none                               | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                   | `node scripts/tasks.mjs --quick`                                                            |
|    [`TASK-008`](#task-008-surface-created-flag-from-handleupload)     | Populate the new `created` field from `resolveStore` result in `handleUpload`.                  | [`TASK-002`](#task-002-extend-ingest-output-schema-with-created) | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                   | `node scripts/tasks.mjs --quick`                                                            |

#### TASK-003: Split registration by destructive intent

| Field           | Value                                                                                                                                                                                                                                                                                                      |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-001`](#task-001-add-destructive-annotations-constant)                                                                                                                                                                                                                                               |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                                                                                                                                                                                                                 |
| Symbols         | [registerIngestTool](src/tools/ingest.ts#L607); [DESTRUCTIVE_ANNOTATIONS](src/lib/tasks.ts)                                                                                                                                                                                                                |
| Action          | Because annotations are tool-level (not per-operation) in MCP, set `annotations: DESTRUCTIVE_ANNOTATIONS` for the single `ingest` tool registration (any of its operations can delete) and document this in a JSDoc comment above `registerIngestTool`. Do not split into multiple tool names (`CON-001`). |
| Validate        | Run `node scripts/tasks.mjs --quick`                                                                                                                                                                                                                                                                       |
| Expected result | Lint, type-check, knip pass. Tool registers with `destructiveHint: true`.                                                                                                                                                                                                                                  |

#### TASK-004: Replace `resourceLink` field with content items

| Field           | Value                                                                                                                                                                                                                                         |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                          |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                                                                                                                                                    |
| Symbols         | [ingestWork](src/tools/ingest.ts#L531); [appendResourceLinks](src/resources/links.ts#L31)                                                                                                                                                     |
| Action          | In the success branch of `ingestWork`, drop the `{ ...validated, resourceLink }` spread. Instead, append `{ type: 'resource_link' as const, uri, name, description, mimeType }` items to `validated.content`, preserving `structuredContent`. |
| Validate        | Run `node scripts/tasks.mjs --quick`                                                                                                                                                                                                          |
| Expected result | Lint, type-check, knip pass. Result conforms to MCP `CallToolResult` schema (no extra top-level field).                                                                                                                                       |

#### TASK-005: Fail fast when SDK omits document name

| Field           | Value                                                                                                                                                                                                                                                                |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                 |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts)                                                                                                                                                         |
| Symbols         | [uploadOne](src/tools/ingest.ts#L228)                                                                                                                                                                                                                                |
| Action          | Replace the `op.response?.documentName ?? op.name ?? displayName` fallback with `op.response?.documentName ?? op.name`; if both are undefined return `{ ok: false, error: 'SDK returned no documentName' }`. Add a test mocking the SDK to confirm the failure path. |
| Validate        | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts`                                                                                                                                                                      |
| Expected result | New test asserts that a missing-name SDK response yields `ok: false`; no `displayName` is ever returned as a document id.                                                                                                                                            |

#### TASK-006: Thread cancellation signal through uploads

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                           |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                                                                                                                                            |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts)                                                                                                                                                                                                                                                                                    |
| Symbols         | [uploadOne](src/tools/ingest.ts#L228); [uploadAll](src/tools/ingest.ts#L259); [handleUpload](src/tools/ingest.ts#L394)                                                                                                                                                                                                                                                                          |
| Action          | Read `signal = ctx.task?.cancellationSignal` (typed via existing `ExtendedServerContext`). Pass `abortSignal: signal` into `ai.fileSearchStores.uploadToFileSearchStore({ config: { ... } })` via conditional spread. Between batches in `uploadAll`, throw `AbortError` (or break) when `signal?.aborted`. Add a test that aborts mid-batch and asserts no further `uploadOne` calls are made. |
| Validate        | Run `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts`                                                                                                                                                                                                                                                                                                 |
| Expected result | Abort test passes; remaining tests still pass; `exactOptionalPropertyTypes` is satisfied (use conditional spread for `abortSignal`).                                                                                                                                                                                                                                                            |

#### TASK-007: Remove duplicate runtime guards

| Field           | Value                                                                                         |
| :-------------- | :-------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | none                                                                                          |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts)                                                    |
| Symbols         | [handleUpload](src/tools/ingest.ts#L394); [handleDeleteDocument](src/tools/ingest.ts#L504)    |
| Action          | Delete the `if (input.filePath === undefined                                                  |     | input.filePath.length === 0)`block in`handleUpload`and the`if (documentName === undefined)`block in`handleDeleteDocument`. Rely on`IngestInputSchema.superRefine`. |
| Validate        | Run `node scripts/tasks.mjs --quick`                                                          |
| Expected result | Lint, type-check, knip pass; no behavioural test failure (schema rejection happens upstream). |

#### TASK-008: Surface `created` flag from `handleUpload`

| Field           | Value                                                                                                                                                                                    |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-002`](#task-002-extend-ingest-output-schema-with-created)                                                                                                                         |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts)                                                                                                                                               |
| Symbols         | [handleUpload](src/tools/ingest.ts#L394); [resolveStore](src/tools/ingest.ts#L339)                                                                                                       |
| Action          | Pass `created` from `resolveStore` into both upload return objects (single-file and directory) as a typed `created` field; keep the human-readable `(auto-created)` suffix in `message`. |
| Validate        | Run `node scripts/tasks.mjs --quick`                                                                                                                                                     |
| Expected result | Type-check confirms field is present in both `IngestOutput` returns; runtime parses successfully against updated schema.                                                                 |

### PHASE-003: Verification & docs

**Goal:** Confirm the full pipeline still passes and capture the new contract in tests.

|                      Task                       | Action                                     |                                                                                                                                                                                             Depends on                                                                                                                                                                                              | Files                                                                                                        | Validate                 |
| :---------------------------------------------: | :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------- | :----------------------- |
| [`TASK-009`](#task-009-end-to-end-verification) | Run the repository's chained verification. | [`TASK-003`](#task-003-split-registration-by-destructive-intent); [`TASK-004`](#task-004-replace-resourcelink-field-with-content-items); [`TASK-005`](#task-005-fail-fast-when-sdk-omits-document-name); [`TASK-006`](#task-006-thread-cancellationsignal-through-uploads); [`TASK-007`](#task-007-remove-duplicate-runtime-guards); [`TASK-008`](#task-008-surface-created-flag-from-handleupload) | [src/tools/ingest.ts](src/tools/ingest.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts) | `node scripts/tasks.mjs` |

#### TASK-009: End-to-end verification

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                               |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-003`](#task-003-split-registration-by-destructive-intent); [`TASK-004`](#task-004-replace-resourcelink-field-with-content-items); [`TASK-005`](#task-005-fail-fast-when-sdk-omits-document-name); [`TASK-006`](#task-006-thread-cancellationsignal-through-uploads); [`TASK-007`](#task-007-remove-duplicate-runtime-guards); [`TASK-008`](#task-008-surface-created-flag-from-handleupload) |
| Files           | [src/tools/ingest.ts](src/tools/ingest.ts); [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts)                                                                                                                                                                                                                                                                                        |
| Symbols         | [registerIngestTool](src/tools/ingest.ts#L607); [ingestWork](src/tools/ingest.ts#L531)                                                                                                                                                                                                                                                                                                              |
| Action          | Execute `node scripts/tasks.mjs` and confirm format, lint, type-check, knip, tests, and rebuild all succeed.                                                                                                                                                                                                                                                                                        |
| Validate        | Run `node scripts/tasks.mjs`                                                                                                                                                                                                                                                                                                                                                                        |
| Expected result | All gates green; no regressions across the existing 334+ tests; new ingest tests included in totals.                                                                                                                                                                                                                                                                                                |

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — ingest test suite passes including new cases

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts
```

### [`VAL-002`](#5-testing--validation) — full repo verification clean

```bash
node scripts/tasks.mjs
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                              |
| :--------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | Inspector or `tools/list` for `ingest` reports `annotations.destructiveHint === true`.                                                          |
| [`AC-002`](#6-acceptance-criteria) | Successful `ingest` calls return zero unknown top-level fields on `CallToolResult`; resource links appear inside `content` as `resource_link`.  |
| [`AC-003`](#6-acceptance-criteria) | A single-file upload whose SDK response lacks both `documentName` and `name` fails with `isError: true` instead of returning a display-name id. |
| [`AC-004`](#6-acceptance-criteria) | Aborting a long upload via `ctx.task?.cancellationSignal` halts further `uploadOne` invocations within one batch boundary.                      |
| [`AC-005`](#6-acceptance-criteria) | `IngestOutput.created === true` is present whenever `resolveStore` auto-created a store during `upload`.                                        |
| [`AC-006`](#6-acceptance-criteria) | `handleUpload` and `handleDeleteDocument` no longer contain runtime presence guards for fields enforced by `IngestInputSchema.superRefine`.     |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                               |
| :---------------------------: | :--: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | Setting `destructiveHint: true` on the whole tool may cause stricter clients to gate every operation (including `create-store` and `upload`) behind extra confirmation. Acceptable per MCP guidance because at least one operation is destructive.   |
| [`RISK-002`](#7-risks--notes) | Risk | The `@google/genai` File Search Stores API is out of scope of the in-repo `google-genai` skill; future SDK changes to `uploadToFileSearchStore` config keys may require rework of [`TASK-006`](#task-006-thread-cancellationsignal-through-uploads). |
| [`NOTE-001`](#7-risks--notes) | Note | `verbatimModuleSyntax` is on — keep `import type` for type-only imports when adding `AbortSignal`-typed parameters.                                                                                                                                  |
| [`NOTE-002`](#7-risks--notes) | Note | With `exactOptionalPropertyTypes: true`, forward `abortSignal` via `...(signal ? { abortSignal: signal } : {})` rather than passing `undefined`.                                                                                                     |
| [`NOTE-003`](#7-risks--notes) | Note | Do NOT change the public `ingest` tool name or operation enum values (`CON-001`).                                                                                                                                                                    |
