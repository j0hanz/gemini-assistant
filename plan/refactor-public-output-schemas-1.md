---
goal: Tighten public MCP output schemas for Gemini 3 by separating tool contract from SDK telemetry, typing previously unknown Gemini metadata, and discriminating Research output by mode.
version: 1
date_created: 2026-04-29
status: Planned
plan_type: refactor
component: public-output-schemas
---

# Implementation Plan: Public Output Schema Refactor (Gemini 3 + MCP)

## 1. Goal

Public output schemas for `chat`, `research`, `analyze`, and `review` currently inline 11 streaming/telemetry fields (`thoughts`, `usage`, `safetyRatings`, `citationMetadata`, `groundingMetadata`, `urlContextMetadata`, `functionCalls`, `toolEvents`) into every tool's MCP `outputSchema`, with four of them typed as `z.unknown()`. This refactor partitions those fields into a single optional `diagnostics` block, types the four `unknown` Gemini fields against shapes verified in [@google/genai types.ts](https://github.com/googleapis/js-genai/blob/main/src/types.ts), discriminates `ResearchOutputSchema` on `mode`, and tightens `ChatOutput.data`, `urlMetadata.status`, and the `groundingStatusField` legacy variant. Completion is observed when [.github/schemas.md](.github/schemas.md) regenerates with smaller per-tool `required` shapes, all tests pass, and `data.thoughts` no longer appears at the root of any tool result.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                                                                                                                        |
| :---------------------------------------: | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Move [streamMetadataOutputFields](src/schemas/fields.ts#L331) and `thoughts`/`usage`/`safetyRatings`/`citationMetadata`/`groundingMetadata`/`urlContextMetadata`/`functionCalls`/`toolEvents` under a single optional `diagnostics` strict object on every public output schema. |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Replace `z.unknown()` for `groundingMetadata`, `urlContextMetadata`, `citationMetadata`, `safetyRatings` with shapes derived from `@google/genai` (`GroundingMetadata`, `UrlContextMetadata`, `CitationMetadata`, `SafetyRating[]`).                                             |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Convert [ResearchOutputSchema](src/schemas/outputs.ts#L125) into a `z.discriminatedUnion('mode', ...)` separating quick vs deep response shapes (`toolsUsed`, `findings`, `citations`, `searchDepth`-driven fields apply to deep only).                                          |
| [`REQ-004`](#2-requirements--constraints) | Requirement | Constrain `ChatOutputSchema.data` to a JSON value (`string \| number \| boolean \| null \| record \| array`) instead of `z.unknown()`.                                                                                                                                           |
| [`REQ-005`](#2-requirements--constraints) | Requirement | Drop the legacy `'completed'` variant from [groundingStatusField](src/schemas/fields.ts#L356); valid values become `grounded \| partially_grounded \| ungrounded`. Update `research.ts` and `analyze.ts` summary handlers accordingly.                                           |
| [`REQ-006`](#2-requirements--constraints) | Requirement | Replace `urlMetadata.status` `enum.or(z.string())` fallback with the documented `UrlRetrievalStatus` enum only (forward-compat handled via passthrough in client code, not schema).                                                                                              |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Public surface is frozen per [src/public-contract.ts](src/public-contract.ts); tool names and required top-level fields (`status`, `answer`, `summary`, `kind`, `subjectKind`) MUST not change.                                                                                  |
| [`CON-002`](#2-requirements--constraints) | Constraint  | Use Zod v4 (`zod/v4`) and `z.strictObject()` at MCP boundaries per [CLAUDE.md](CLAUDE.md).                                                                                                                                                                                       |
| [`CON-003`](#2-requirements--constraints) | Constraint  | All four imported Gemini SDK types are concrete interfaces in `@google/genai` (verified against the public `api-report/genai.api.md`); no `z.unknown()` is necessary.                                                                                                            |
| [`SEC-001`](#2-requirements--constraints) | Security    | Diagnostics block must remain opt-in for `thoughts` (already gated by `getExposeThoughts()` in [src/config.ts](src/config.ts#L199)); raw model reasoning MUST NOT appear in the public schema unless the env flag is set.                                                        |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow the discriminated-union + `pipe()` + `superRefine` pattern already used by [AnalyzeOutputSchema](src/schemas/outputs.ts#L162).                                                                                                                                            |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Use `z.strictObject({...}).partial()` instead of `z.object({...}).partial()` for nested SDK objects to keep schemas closed.                                                                                                                                                      |

## 3. Current Context

### Relevant files

| File                                                                                   | Why it matters                                                                                                                                                                                                                               |
| :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/schemas/fields.ts](src/schemas/fields.ts)                                         | Hosts [streamMetadataOutputFields](src/schemas/fields.ts#L331), [publicBaseOutputFieldsWithoutStatus](src/schemas/fields.ts#L360), [groundingStatusField](src/schemas/fields.ts#L356), [UrlMetadataEntrySchema](src/schemas/fields.ts#L382). |
| [src/schemas/outputs.ts](src/schemas/outputs.ts)                                       | Defines [ChatOutputSchema](src/schemas/outputs.ts#L99), [ResearchOutputSchema](src/schemas/outputs.ts#L125), [AnalyzeOutputSchema](src/schemas/outputs.ts#L162), [ReviewOutputSchema](src/schemas/outputs.ts#L173).                          |
| [src/tools/chat.ts](src/tools/chat.ts)                                                 | Builds the chat result; populates `thoughts`, `usage`, `toolEvents`, etc. Must move them under `diagnostics`.                                                                                                                                |
| [src/tools/research.ts](src/tools/research.ts)                                         | Builds research output; quick-vs-deep branch must align with new discriminated union.                                                                                                                                                        |
| [src/tools/analyze.ts](src/tools/analyze.ts)                                           | Builds analyze summary/diagram outputs; must move telemetry to diagnostics.                                                                                                                                                                  |
| [src/tools/review.ts](src/tools/review.ts)                                             | Builds review output; must move telemetry to diagnostics.                                                                                                                                                                                    |
| [src/lib/streaming.ts](src/lib/streaming.ts)                                           | Produces the streaming metadata fields the tools currently spread at the result root.                                                                                                                                                        |
| [src/lib/response.ts](src/lib/response.ts)                                             | Builds final `CallToolResult` (`content[]` + `structuredContent`); validates against the new schema.                                                                                                                                         |
| [src/config.ts](src/config.ts)                                                         | Hosts [getExposeThoughts](src/config.ts#L199); diagnostics inclusion of `thoughts` must remain gated.                                                                                                                                        |
| [.github/schemas.md](.github/schemas.md)                                               | Snapshot of generated public JSON Schemas; expected to regenerate with the new shape.                                                                                                                                                        |
| [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts)                 | Existing assertions for `toolEvents` and friends at the root; must move to `diagnostics`.                                                                                                                                                    |
| [**tests**/schemas/public-contract.test.ts](__tests__/schemas/public-contract.test.ts) | Asserts session event entry audit shape (separate from output schema; verify it does not regress).                                                                                                                                           |

### Relevant symbols

| Symbol                                                            | Why it matters                                                     |
| :---------------------------------------------------------------- | :----------------------------------------------------------------- |
| [streamMetadataOutputFields](src/schemas/fields.ts#L331)          | The block being relocated under `diagnostics`.                     |
| [publicBaseOutputFieldsWithoutStatus](src/schemas/fields.ts#L360) | Will be split into `publicCoreOutputFields` + `DiagnosticsSchema`. |
| [UsageMetadataSchema](src/schemas/fields.ts#L268)                 | Reused inside `diagnostics`.                                       |
| [ToolEventSchema](src/schemas/fields.ts#L329)                     | Reused inside `diagnostics`.                                       |
| [FunctionCallEntrySchema](src/schemas/fields.ts#L291)             | Reused inside `diagnostics`.                                       |
| [groundingStatusField](src/schemas/fields.ts#L356)                | Drop legacy `'completed'`.                                         |
| [UrlMetadataEntrySchema](src/schemas/fields.ts#L382)              | Replace `enum.or(string)` fallback with `UrlRetrievalStatus` enum. |
| [GroundingSignalsSchema](src/schemas/fields.ts#L417)              | Stays in public surface for `research`/`analyze`.                  |
| [ChatOutputSchema](src/schemas/outputs.ts#L99)                    | Move telemetry fields; tighten `data`.                             |
| [ResearchOutputSchema](src/schemas/outputs.ts#L125)               | Become `z.discriminatedUnion('mode', ...)`.                        |
| [AnalyzeOutputSchema](src/schemas/outputs.ts#L162)                | Existing union; add `diagnostics` to both branches.                |
| [ReviewOutputSchema](src/schemas/outputs.ts#L173)                 | Move telemetry fields under `diagnostics`.                         |

### Existing commands

```bash
# Lint
npm run lint

# Type check
npm run type-check

# Test
npm run test

# Static + tests
npm run check
```

### Current behavior

Each public output schema spreads ~11 streaming/telemetry fields at its root. Four of them (`citationMetadata`, `groundingMetadata`, `urlContextMetadata`, `safetyRatings`) are typed as `z.unknown()`, providing no contract value. `ResearchOutputSchema` mixes quick-only and deep-only fields. `groundingStatusField` accepts a legacy `'completed'`. `ChatOutput.data` is `z.unknown()`. `urlMetadata.status` allows arbitrary strings.

## 4. Implementation Phases

### PHASE-001: Introduce DiagnosticsSchema and Gemini SDK metadata shapes

**Goal:** Build the shared `DiagnosticsSchema` and concrete Zod shapes for the four currently-unknown Gemini metadata fields without yet wiring them into the public output schemas.

|                          Task                          | Action                                                                                                                                                              |                       Depends on                       | Files                                          | Validate             |
| :----------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------: | :--------------------------------------------- | :------------------- |
| [`TASK-001`](#task-001-add-gemini-metadata-zod-shapes) | Add `GroundingMetadataSchema`, `UrlContextMetadataSchema`, `CitationMetadataSchema`, `SafetyRatingSchema` in [src/schemas/fields.ts](src/schemas/fields.ts).        |                          none                          | [src/schemas/fields.ts](src/schemas/fields.ts) | `npm run type-check` |
|    [`TASK-002`](#task-002-build-diagnosticsschema)     | Build `DiagnosticsSchema` strict object holding the relocated streaming/telemetry fields.                                                                           | [`TASK-001`](#task-001-add-gemini-metadata-zod-shapes) | [src/schemas/fields.ts](src/schemas/fields.ts) | `npm run type-check` |
|    [`TASK-003`](#task-003-split-base-output-fields)    | Split [publicBaseOutputFieldsWithoutStatus](src/schemas/fields.ts#L360) into `publicCoreOutputFields` (status, requestId, warnings) and export `DiagnosticsSchema`. |    [`TASK-002`](#task-002-build-diagnosticsschema)     | [src/schemas/fields.ts](src/schemas/fields.ts) | `npm run type-check` |

#### TASK-001: Add Gemini metadata Zod shapes

| Field           | Value                                                                                                                                                                                                                                                                                                                                        |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                                                                                         |
| Files           | [src/schemas/fields.ts](src/schemas/fields.ts)                                                                                                                                                                                                                                                                                               |
| Symbols         | new `GroundingMetadataSchema`, `UrlContextMetadataSchema`, `CitationMetadataSchema`, `SafetyRatingSchema` in [src/schemas/fields.ts](src/schemas/fields.ts)                                                                                                                                                                                  |
| Action          | Add four `z.strictObject(...).partial()` schemas mirroring `@google/genai` interfaces `GroundingMetadata` (groundingChunks, groundingSupports, retrievalMetadata, retrievalQueries, searchEntryPoint, webSearchQueries, imageSearchQueries), `UrlContextMetadata` (urlMetadata array), `CitationMetadata` (citations array), `SafetyRating`. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                                                     |
| Expected result | TypeScript reports no errors; `z.infer<typeof GroundingMetadataSchema>` is structurally assignable to `import('@google/genai').GroundingMetadata`.                                                                                                                                                                                           |

#### TASK-002: Build DiagnosticsSchema

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                  |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-001`](#task-001-add-gemini-metadata-zod-shapes)                                                                                                                                                                                                                                                                                                                                 |
| Files           | [src/schemas/fields.ts](src/schemas/fields.ts)                                                                                                                                                                                                                                                                                                                                         |
| Symbols         | new `DiagnosticsSchema`; replace internal use of [streamMetadataOutputFields](src/schemas/fields.ts#L331)                                                                                                                                                                                                                                                                              |
| Action          | Define `DiagnosticsSchema = z.strictObject({ thoughts, usage: UsageMetadataSchema, finishMessage, safetyRatings: z.array(SafetyRatingSchema), citationMetadata: CitationMetadataSchema, groundingMetadata: GroundingMetadataSchema, urlContextMetadata: UrlContextMetadataSchema, functionCalls: FunctionCallEntrySchema[], toolEvents: ToolEventSchema[] }).partial()`. All optional. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                                                                                               |
| Expected result | TypeScript reports no errors; `DiagnosticsSchema` parses an empty object without error.                                                                                                                                                                                                                                                                                                |

#### TASK-003: Split base output fields

| Field           | Value                                                                                                                                                                                                                                                                       |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-002`](#task-002-build-diagnosticsschema)                                                                                                                                                                                                                             |
| Files           | [src/schemas/fields.ts](src/schemas/fields.ts)                                                                                                                                                                                                                              |
| Symbols         | new `publicCoreOutputFields`; deprecate [publicBaseOutputFieldsWithoutStatus](src/schemas/fields.ts#L360)                                                                                                                                                                   |
| Action          | Replace [publicBaseOutputFieldsWithoutStatus](src/schemas/fields.ts#L360) with `publicCoreOutputFields = { requestId, warnings, diagnostics: DiagnosticsSchema.optional() }`. Remove the spread of [streamMetadataOutputFields](src/schemas/fields.ts#L331) from this base. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                    |
| Expected result | TypeScript builds; existing imports from [src/schemas/outputs.ts](src/schemas/outputs.ts) compile (they will be migrated in PHASE-002).                                                                                                                                     |

### PHASE-002: Wire DiagnosticsSchema into all four public outputs

**Goal:** Migrate every public output schema to consume `publicCoreOutputFields` + `diagnostics`, drop legacy `groundingStatusField` `'completed'` variant, tighten `ChatOutput.data`, and discriminate Research output by `mode`.

|                               Task                                | Action                                                                                                            | Depends on                                                                                                             | Files                                                                                            | Validate       |
| :---------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- | :------------- |
|         [`TASK-004`](#task-004-migrate-chatoutputschema)          | Migrate [ChatOutputSchema](src/schemas/outputs.ts#L99) to `publicCoreOutputFields`; tighten `data` to JSON value. | [`TASK-003`](#task-003-split-base-output-fields)                                                                       | [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                 | `npm run test` |
|        [`TASK-005`](#task-005-migrate-analyzeoutputschema)        | Update both branches of [AnalyzeOutputSchema](src/schemas/outputs.ts#L162); drop `'completed'` from grounding.    | [`TASK-003`](#task-003-split-base-output-fields)                                                                       | [src/schemas/outputs.ts](src/schemas/outputs.ts), [src/schemas/fields.ts](src/schemas/fields.ts) | `npm run test` |
| [`TASK-006`](#task-006-discriminate-researchoutputschema-by-mode) | Convert [ResearchOutputSchema](src/schemas/outputs.ts#L125) into `z.discriminatedUnion('mode', ...)`.             | [`TASK-003`](#task-003-split-base-output-fields)                                                                       | [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                 | `npm run test` |
|        [`TASK-007`](#task-007-migrate-reviewoutputschema)         | Migrate [ReviewOutputSchema](src/schemas/outputs.ts#L173) to `publicCoreOutputFields`.                            | [`TASK-003`](#task-003-split-base-output-fields)                                                                       | [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                 | `npm run test` |
|         [`TASK-008`](#task-008-tighten-urlmetadatastatus)         | Drop `enum.or(z.string())` fallback in [UrlMetadataEntrySchema](src/schemas/fields.ts#L382).                      | [`TASK-005`](#task-005-migrate-analyzeoutputschema), [`TASK-006`](#task-006-discriminate-researchoutputschema-by-mode) | [src/schemas/fields.ts](src/schemas/fields.ts)                                                   | `npm run test` |

#### TASK-004: Migrate ChatOutputSchema

| Field           | Value                                                                                                                                                                                                           |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-003`](#task-003-split-base-output-fields)                                                                                                                                                                |
| Files           | [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                                                                                                                                |
| Symbols         | [ChatOutputSchema](src/schemas/outputs.ts#L99)                                                                                                                                                                  |
| Action          | Replace `...publicBaseOutputFieldsWithoutStatus` spread with `...publicCoreOutputFields`. Replace `data: z.unknown()` with a recursive `JsonValueSchema` (`z.lazy(() => z.union([primitive, record, array]))`). |
| Validate        | Run `npm run test`                                                                                                                                                                                              |
| Expected result | All tests pass; emitted JSON Schema for `chat` no longer includes `thoughts`/`usage`/`toolEvents` at the root.                                                                                                  |

#### TASK-005: Migrate AnalyzeOutputSchema

| Field           | Value                                                                                                                                                                                      |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-003`](#task-003-split-base-output-fields)                                                                                                                                           |
| Files           | [src/schemas/outputs.ts](src/schemas/outputs.ts), [src/schemas/fields.ts](src/schemas/fields.ts)                                                                                           |
| Symbols         | `AnalyzeSummaryOutputSchema`, `AnalyzeDiagramOutputSchema` (in [src/schemas/outputs.ts](src/schemas/outputs.ts))                                                                           |
| Action          | Replace base spread with `...publicCoreOutputFields` in both branches. Update [groundingStatusField](src/schemas/fields.ts#L356) enum to `['grounded','partially_grounded','ungrounded']`. |
| Validate        | Run `npm run test`                                                                                                                                                                         |
| Expected result | All tests pass; `analyze` summary status enum no longer includes `'completed'`.                                                                                                            |

#### TASK-006: Discriminate ResearchOutputSchema by mode

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                              |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-003`](#task-003-split-base-output-fields)                                                                                                                                                                                                                                                                                                                                                   |
| Files           | [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                                                                                                                                                                                                                                                                                                                   |
| Symbols         | [ResearchOutputSchema](src/schemas/outputs.ts#L125)                                                                                                                                                                                                                                                                                                                                                |
| Action          | Define `ResearchQuickOutputSchema` (mode=`'quick'` literal; no `toolsUsed`/`findings`/`citations`/`computations`) and `ResearchDeepOutputSchema` (mode=`'deep'` literal; full grounded shape). Combine with `z.discriminatedUnion('mode', [...])`. Both branches share `...publicCoreOutputFields`, `summary`, `sources`, `sourceDetails`, `urlContextSources`, `urlMetadata`, `groundingSignals`. |
| Validate        | Run `npm run test`                                                                                                                                                                                                                                                                                                                                                                                 |
| Expected result | All tests pass; `research` JSON Schema is a `oneOf` between quick and deep variants.                                                                                                                                                                                                                                                                                                               |

#### TASK-007: Migrate ReviewOutputSchema

| Field           | Value                                                                                                                                                                                       |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | [`TASK-003`](#task-003-split-base-output-fields)                                                                                                                                            |
| Files           | [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                                                                                                            |
| Symbols         | [ReviewOutputSchema](src/schemas/outputs.ts#L173)                                                                                                                                           |
| Action          | Replace base spread with `...publicCoreOutputFields`. No discriminated split (subjectKind already provides one but field set is shared); leave existing `subjectKind` enum field unchanged. |
| Validate        | Run `npm run test`                                                                                                                                                                          |
| Expected result | All tests pass; emitted `review` schema does not contain `thoughts`/`usage` at the root.                                                                                                    |

#### TASK-008: Tighten urlMetadata.status

| Field           | Value                                                                                                                                                                                            |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-005`](#task-005-migrate-analyzeoutputschema), [`TASK-006`](#task-006-discriminate-researchoutputschema-by-mode)                                                                           |
| Files           | [src/schemas/fields.ts](src/schemas/fields.ts)                                                                                                                                                   |
| Symbols         | [UrlMetadataEntrySchema](src/schemas/fields.ts#L382)                                                                                                                                             |
| Action          | Replace `.or(z.string())` fallback with the strict `UrlRetrievalStatus` enum re-exported from `@google/genai` (`URL_RETRIEVAL_STATUS_SUCCESS \| _ERROR \| _UNSAFE \| _PAYWALL \| _UNSPECIFIED`). |
| Validate        | Run `npm run test`                                                                                                                                                                               |
| Expected result | Existing tests pass; status field emits a closed enum with no `string` fallback.                                                                                                                 |

### PHASE-003: Migrate runtime tool result builders

**Goal:** Update the four tool implementations and shared helpers to emit `diagnostics` instead of root-level streaming/telemetry fields.

|                         Task                          | Action                                                                                                      | Depends on                                                                                                         | Files                                          | Validate       |
| :---------------------------------------------------: | :---------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- | :------------- |
|    [`TASK-009`](#task-009-update-response-builder)    | Update [src/lib/response.ts](src/lib/response.ts) to assemble a `diagnostics` block from streaming output.  | [`TASK-007`](#task-007-migrate-reviewoutputschema)                                                                 | [src/lib/response.ts](src/lib/response.ts)     | `npm run test` |
|   [`TASK-010`](#task-010-migrate-chat-tool-builder)   | Update [src/tools/chat.ts](src/tools/chat.ts) to nest telemetry under `diagnostics`.                        | [`TASK-009`](#task-009-update-response-builder)                                                                    | [src/tools/chat.ts](src/tools/chat.ts)         | `npm run test` |
| [`TASK-011`](#task-011-migrate-research-tool-builder) | Update [src/tools/research.ts](src/tools/research.ts) to emit either quick or deep variant + `diagnostics`. | [`TASK-009`](#task-009-update-response-builder), [`TASK-006`](#task-006-discriminate-researchoutputschema-by-mode) | [src/tools/research.ts](src/tools/research.ts) | `npm run test` |
| [`TASK-012`](#task-012-migrate-analyze-tool-builder)  | Update [src/tools/analyze.ts](src/tools/analyze.ts) to nest telemetry under `diagnostics`.                  | [`TASK-009`](#task-009-update-response-builder)                                                                    | [src/tools/analyze.ts](src/tools/analyze.ts)   | `npm run test` |
|  [`TASK-013`](#task-013-migrate-review-tool-builder)  | Update [src/tools/review.ts](src/tools/review.ts) to nest telemetry under `diagnostics`.                    | [`TASK-009`](#task-009-update-response-builder)                                                                    | [src/tools/review.ts](src/tools/review.ts)     | `npm run test` |

#### TASK-009: Update response builder

| Field           | Value                                                                                                                                                                                                  |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-007`](#task-007-migrate-reviewoutputschema)                                                                                                                                                     |
| Files           | [src/lib/response.ts](src/lib/response.ts)                                                                                                                                                             |
| Symbols         | result-builder helper(s) in [src/lib/response.ts](src/lib/response.ts)                                                                                                                                 |
| Action          | Add a helper `buildDiagnostics(streamMetadata)` that returns a `DiagnosticsSchema`-shaped object or `undefined`. Honor [getExposeThoughts](src/config.ts#L199) when populating `diagnostics.thoughts`. |
| Validate        | Run `npm run test`                                                                                                                                                                                     |
| Expected result | All tests pass; diagnostics is omitted entirely when stream metadata is empty.                                                                                                                         |

#### TASK-010: Migrate chat tool builder

| Field           | Value                                                                                                                                                                                                    |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-009`](#task-009-update-response-builder)                                                                                                                                                          |
| Files           | [src/tools/chat.ts](src/tools/chat.ts)                                                                                                                                                                   |
| Symbols         | result assembly in [src/tools/chat.ts](src/tools/chat.ts)                                                                                                                                                |
| Action          | Replace root spread of stream metadata with `diagnostics: buildDiagnostics(streamMetadata)`. Keep `status`, `answer`, `data`, `session`, `contextUsed`, `computations`, `workspaceCacheApplied` at root. |
| Validate        | Run `npm run test`                                                                                                                                                                                       |
| Expected result | All chat tests pass; `structuredContent.diagnostics` exists when telemetry is present and is absent otherwise.                                                                                           |

#### TASK-011: Migrate research tool builder

| Field           | Value                                                                                                                                                                             |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-009`](#task-009-update-response-builder), [`TASK-006`](#task-006-discriminate-researchoutputschema-by-mode)                                                                |
| Files           | [src/tools/research.ts](src/tools/research.ts)                                                                                                                                    |
| Symbols         | result assembly in [src/tools/research.ts](src/tools/research.ts)                                                                                                                 |
| Action          | Branch on `input.mode` and emit a quick or deep result object with `diagnostics`. Drop deep-only fields (`toolsUsed`, `findings`, `citations`, `computations`) from quick branch. |
| Validate        | Run `npm run test`                                                                                                                                                                |
| Expected result | Research e2e tests pass; quick output omits deep-only fields; deep output retains them.                                                                                           |

#### TASK-012: Migrate analyze tool builder

| Field           | Value                                                                                                                                                                                       |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | [`TASK-009`](#task-009-update-response-builder)                                                                                                                                             |
| Files           | [src/tools/analyze.ts](src/tools/analyze.ts)                                                                                                                                                |
| Symbols         | summary and diagram result assembly in [src/tools/analyze.ts](src/tools/analyze.ts)                                                                                                         |
| Action          | Replace root spread of stream metadata with `diagnostics: buildDiagnostics(streamMetadata)`. For summary branch, ensure `status` matches the new `groundingStatusField` (no `'completed'`). |
| Validate        | Run `npm run test`                                                                                                                                                                          |
| Expected result | Analyze tests pass; analyze summary status is one of the four grounded values; diagram status remains `'completed'`.                                                                        |

#### TASK-013: Migrate review tool builder

| Field           | Value                                                                                        |
| :-------------- | :------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-009`](#task-009-update-response-builder)                                              |
| Files           | [src/tools/review.ts](src/tools/review.ts)                                                   |
| Symbols         | review result assembly in [src/tools/review.ts](src/tools/review.ts)                         |
| Action          | Replace root spread of stream metadata with `diagnostics: buildDiagnostics(streamMetadata)`. |
| Validate        | Run `npm run test`                                                                           |
| Expected result | Review tests pass; review schema emits no telemetry at root.                                 |

### PHASE-004: Update tests and contract snapshot

**Goal:** Update test fixtures that reference root-level telemetry; regenerate [.github/schemas.md](.github/schemas.md).

|                        Task                         | Action                                                                                           | Depends on                                                                             | Files                                                                                                                                                                                                                                                                                            | Validate        |
| :-------------------------------------------------: | :----------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------- |
|     [`TASK-014`](#task-014-update-output-tests)     | Update [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts) for `diagnostics`. | [`TASK-013`](#task-013-migrate-review-tool-builder)                                    | [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts)                                                                                                                                                                                                                           | `npm run test`  |
|      [`TASK-015`](#task-015-update-tool-tests)      | Update tool-level tests that assert root telemetry.                                              | [`TASK-013`](#task-013-migrate-review-tool-builder)                                    | [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts), [**tests**/tools/research.test.ts](__tests__/tools/research.test.ts), [**tests**/tools/analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts), [**tests**/tools/pr.test.ts](__tests__/tools/pr.test.ts) | `npm run test`  |
| [`TASK-016`](#task-016-regenerate-schemas-snapshot) | Regenerate [.github/schemas.md](.github/schemas.md).                                             | [`TASK-014`](#task-014-update-output-tests), [`TASK-015`](#task-015-update-tool-tests) | [.github/schemas.md](.github/schemas.md)                                                                                                                                                                                                                                                         | `npm run check` |

#### TASK-014: Update output tests

| Field           | Value                                                                                                                                                           |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-013`](#task-013-migrate-review-tool-builder)                                                                                                             |
| Files           | [**tests**/schemas/outputs.test.ts](__tests__/schemas/outputs.test.ts)                                                                                          |
| Symbols         | tests asserting `toolEvents` on chat/research output                                                                                                            |
| Action          | Move `toolEvents`, `usage`, `thoughts` test fixtures under `diagnostics: { ... }`. Add an assertion that root-level `toolEvents` is rejected by `strictObject`. |
| Validate        | Run `npm run test`                                                                                                                                              |
| Expected result | All output schema tests pass; new strict-mode rejection assertion passes.                                                                                       |

#### TASK-015: Update tool tests

| Field           | Value                                                                                                                                                                                                                                                                                            |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-013`](#task-013-migrate-review-tool-builder)                                                                                                                                                                                                                                              |
| Files           | [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts), [**tests**/tools/research.test.ts](__tests__/tools/research.test.ts), [**tests**/tools/analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts), [**tests**/tools/pr.test.ts](__tests__/tools/pr.test.ts) |
| Symbols         | tool-level result assertions                                                                                                                                                                                                                                                                     |
| Action          | Update fixtures and assertions to read telemetry from `result.structuredContent.diagnostics.*` instead of `result.structuredContent.*`.                                                                                                                                                          |
| Validate        | Run `npm run test`                                                                                                                                                                                                                                                                               |
| Expected result | All tool tests pass.                                                                                                                                                                                                                                                                             |

#### TASK-016: Regenerate schemas snapshot

| Field           | Value                                                                                                                                                                                                     |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-014`](#task-014-update-output-tests), [`TASK-015`](#task-015-update-tool-tests)                                                                                                                    |
| Files           | [.github/schemas.md](.github/schemas.md)                                                                                                                                                                  |
| Symbols         | none                                                                                                                                                                                                      |
| Action          | Run the existing schema snapshot generator (or update [.github/schemas.md](.github/schemas.md) by re-emitting `z.toJSONSchema(SCHEMA)` for chat/research/analyze/review) and commit the regenerated file. |
| Validate        | Run `npm run check`                                                                                                                                                                                       |
| Expected result | Snapshot reflects new schemas; `npm run check` passes; per-tool `required` arrays no longer include any of `thoughts`/`usage`/`safetyRatings`/`toolEvents`.                                               |

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — All tests pass after refactor

```bash
npm run test
```

### [`VAL-002`](#5-testing--validation) — Type check is clean

```bash
npm run type-check
```

### [`VAL-003`](#5-testing--validation) — Full static + test gate passes

```bash
npm run check
```

### [`VAL-004`](#5-testing--validation) — Public schemas snapshot reflects new shape

```bash
node scripts/tasks.mjs --quick
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                                                                    |
| :--------------------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | The four public output schemas (`chat`, `research`, `analyze`, `review`) emit at most: `status`, primary content fields, `requestId`, `warnings`, `diagnostics`, `contextUsed`, and tool-specific fields at the root. |
| [`AC-002`](#6-acceptance-criteria) | `diagnostics.groundingMetadata`, `diagnostics.urlContextMetadata`, `diagnostics.citationMetadata`, `diagnostics.safetyRatings` each emit a typed shape, not `{}` (no `z.unknown()`).                                  |
| [`AC-003`](#6-acceptance-criteria) | `research` JSON Schema is a `oneOf` between `mode='quick'` and `mode='deep'` variants; quick variant does not declare `toolsUsed`, `findings`, `citations`, `computations`.                                           |
| [`AC-004`](#6-acceptance-criteria) | Setting `THOUGHTS=false` (default) produces no `diagnostics.thoughts` key in any tool output; setting `THOUGHTS=true` reinstates it.                                                                                  |
| [`AC-005`](#6-acceptance-criteria) | `analyze` summary status enum is exactly `['grounded','partially_grounded','ungrounded']` (no `'completed'`).                                                                                                         |
| [`AC-006`](#6-acceptance-criteria) | `urlMetadata.status` JSON Schema emits a closed `enum` (no `anyOf` with `string`).                                                                                                                                    |
| [`AC-007`](#6-acceptance-criteria) | `npm run check` passes from a clean tree after PHASE-004.                                                                                                                                                             |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                                          |
| :---------------------------: | :--: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`RISK-001`](#7-risks--notes) | Risk | Nesting telemetry under `diagnostics` is a breaking change for any external consumer reading `structuredContent.thoughts`. Mitigation: ship in a single major bump and update [.github/schemas.md](.github/schemas.md) at the same time.                                                                                        |
| [`RISK-002`](#7-risks--notes) | Risk | The four Gemini SDK metadata interfaces have subtly different shapes between `genai-node` and `genai-web` API reports. Mitigation: model only the documented intersection (`groundingChunks`, `groundingSupports`, etc.) and keep `.partial()`.                                                                                 |
| [`RISK-003`](#7-risks--notes) | Risk | `urlRetrievalStatus` may add new enum values in future SDK releases, causing parse failures under the closed enum. Mitigation: keep status types non-strict at the runtime boundary in [src/lib/streaming.ts](src/lib/streaming.ts) and coerce unknown values to `'URL_RETRIEVAL_STATUS_UNSPECIFIED'` before schema validation. |
| [`NOTE-001`](#7-risks--notes) | Note | The `SessionEventEntry` audit shape in [**tests**/schemas/public-contract.test.ts](__tests__/schemas/public-contract.test.ts) is a separate session-only shape and intentionally retains the flat fields; do not refactor it.                                                                                                   |
| [`NOTE-002`](#7-risks--notes) | Note | [getExposeThoughts](src/config.ts#L199) already gates SDK-side `includeThoughts`; keep schema field optional even when env=true so that empty turns omit the key.                                                                                                                                                               |
| [`NOTE-003`](#7-risks--notes) | Note | The Gemini 3 SDK `UsageMetadata` exposes `responseTokenCount` (web build) vs `candidatesTokenCount` (node build); existing [UsageMetadataSchema](src/schemas/fields.ts#L268) covers `candidatesTokenCount` only — leave as-is for this refactor.                                                                                |
