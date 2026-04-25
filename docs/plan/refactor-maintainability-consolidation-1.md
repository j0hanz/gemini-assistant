---
goal: Centralize repeated tool workflow logic while preserving the current file-count envelope
version: 1.0
date_created: 2026-04-25
last_updated: 2026-04-25
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, maintainability, typescript, tooling]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Aggressively refactor repeated workflow logic across the Gemini MCP tool surface without changing observable behavior. The refactor centralizes common execution, response, validation, upload, and configuration patterns into existing shared modules instead of splitting the codebase into additional production files. Public MCP tool names, schemas, resource URIs, structured output fields, progress messages, logging semantics, session behavior, and Gemini request behavior MUST remain compatible with the current implementation.

This plan supersedes any broad file-splitting approach for this refactor window. The implementation MUST preserve or reduce the production source file count unless a later phase explicitly removes at least as many production files as it adds in the same commit.

## 1. Requirements & Constraints

- **REQ-001**: Preserve observable behavior for `chat`, `research`, `analyze`, and `review` across return values, thrown errors, MCP `CallToolResult` shape, structured content, progress messages, logs, resource links, session persistence, and Gemini request configuration.
- **REQ-002**: Centralize repeated logic currently duplicated across [src/tools/chat.ts](src/tools/chat.ts), [src/tools/research.ts](src/tools/research.ts), [src/tools/analyze.ts](src/tools/analyze.ts), and [src/tools/review.ts](src/tools/review.ts).
- **REQ-003**: Prefer edits to existing shared modules: [src/lib/tool-executor.ts](src/lib/tool-executor.ts), [src/lib/response.ts](src/lib/response.ts), [src/lib/file.ts](src/lib/file.ts), [src/lib/orchestration.ts](src/lib/orchestration.ts), and [src/schemas/validators.ts](src/schemas/validators.ts).
- **REQ-004**: Keep public registration functions import-compatible: `registerChatTool`, `registerResearchTool`, `registerAnalyzeTool`, and `registerReviewTool` remain exported from their current file paths.
- **REQ-005**: Keep all public tool input schemas and output schemas compatible unless a task explicitly states a no-op internal-only type refactor.
- **REQ-006**: Each implementation commit MUST complete one task or one tightly scoped subtask and MUST pass the validation command listed for that task before proceeding.
- **REQ-007**: Do not introduce new third-party runtime or dev dependencies.
- **SEC-001**: Do not add new network, file-system, environment-variable, subprocess, or secret-handling behavior.
- **SEC-002**: Preserve existing URL validation, workspace-root validation, sensitive-file skipping, and session redaction behavior.
- **CON-001**: Production source file count under `src/` MUST NOT increase at the end of any commit. If a new production file is required, the same commit MUST delete or merge at least one production file so the count is net-neutral or lower.
- **CON-002**: Test file count MAY increase only for characterization coverage that protects the refactor. Production file-count limits still apply.
- **CON-003**: Node runtime remains `>=24`; TypeScript remains strict with `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`.
- **CON-004**: Use existing package manager scripts from [package.json](package.json). Do not run `npm run build` without explicit approval because repo guidance marks builds as ask-first.
- **CON-005**: Do not change `MODEL` defaults or suggest `gemini-2.5-flash`; repository memory forbids adopting that model.
- **GUD-001**: Apply refactor skill ordering: safety net first, smallest behavior-preserving move, one intent per change, proof through tests.
- **GUD-002**: Use TypeScript types to reflect existing runtime behavior; do not make types stricter in ways that reject currently accepted inputs.
- **GUD-003**: Prefer named predicates, parameter objects, discriminated unions, and typed helper APIs only where they remove actual duplication or clarify runtime state.
- **PAT-001**: Preserve existing conditional-spread patterns for optional properties to satisfy `exactOptionalPropertyTypes`.
- **PAT-002**: Preserve existing `safeValidateStructuredContent` behavior: successful results may carry `structuredContent`; error results omit it.

## 2. Implementation Steps

### Implementation Phase 0 - Baseline and Refactor Guardrails

- GOAL-001: Establish measurable current state and lock the constraints before production edits.

| Task     | Description                                                                                                                                                                                                                                                                                                                   | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Run `npm run lint`, `npm run type-check`, `npm run test`, and `npm run knip`. Record any pre-existing failures in the implementation notes before editing production files. Do not run `npm run build` in this phase.                                                                                                         | Yes       | 2026-04-25 |
| TASK-002 | Record the current production source file count with `Get-ChildItem -Path src -Filter *.ts -Recurse`, then pipe the result to `Measure-Object`. Treat that value as `BASE_SRC_TS_COUNT`. Completion criterion: every later production-code commit has `CURRENT_SRC_TS_COUNT <= BASE_SRC_TS_COUNT`.                            | Yes       | 2026-04-25 |
| TASK-003 | Add focused characterization tests only where the current suite does not lock repeated workflow behavior. Target existing test areas first: `__tests__/lib/tool-executor.test.ts`, `__tests__/lib/response.test.ts`, `__tests__/lib/orchestration.test.ts`, and tool tests under `__tests__/tools`.                           | Yes       | 2026-04-25 |
| TASK-004 | Capture exact current behavior for these invariants: progress start/completion/failure reporting, `buildGenerateContentConfig` inputs, URL validation failures, structured metadata merging, upload cleanup ordering, and selector-based schema validation errors. Completion criterion: tests fail if these behaviors drift. | Yes       | 2026-04-25 |

### Implementation Phase 1 - Central Gemini Stream Execution

- GOAL-002: Make [src/lib/tool-executor.ts](src/lib/tool-executor.ts) the shared internal entry point for the repeated `resolve orchestration -> build config -> generateContentStream -> merge stream result` workflow.

| Task     | Description                                                                                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-005 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), add internal types for a Gemini stream execution request: tool key, label, orchestration request, signal source, model contents, generation config fields, and stream response builder. Use existing `StreamResponseBuilder<T>` as the response-builder shape.                                | Yes       | 2026-04-25 |
| TASK-006 | Add a `runGeminiStream` method to `ToolExecutor` that wraps `resolveOrchestration`, `getAI().models.generateContentStream`, `buildGenerateContentConfig`, and existing `runStream`. The method MUST return the exact same `CallToolResult` shape as current per-tool helpers.                                                                          | Yes       | 2026-04-25 |
| TASK-007 | Migrate [src/tools/analyze.ts](src/tools/analyze.ts) first by replacing `runAnalyzeGeneration` with `executor.runGeminiStream`. Preserve `ANALYZE_FILE_TOOL_LABEL`, `ANALYZE_TOOL_LABEL`, `ANALYZE_DIAGRAM_TOOL_LABEL`, cost profiles, cache names, media resolution, safety settings, and prompt parts exactly.                                       | Yes       | 2026-04-25 |
| TASK-008 | Run targeted tests for analyze plus shared executor tests by invoking `npm run test` for [analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts) and [tool-executor.test.ts](__tests__/lib/tool-executor.test.ts) if the Node runner accepts file arguments; otherwise run `npm run test`. Then run `npm run type-check`. | Yes       | 2026-04-25 |
| TASK-009 | Migrate [src/tools/review.ts](src/tools/review.ts) by replacing `runReviewGeneration` with `executor.runGeminiStream`. Preserve diff review, file comparison, and failure diagnosis behavior.                                                                                                                                                          | Yes       | 2026-04-25 |
| TASK-010 | Migrate [src/tools/research.ts](src/tools/research.ts) only if `runToolStream` can delegate without changing initial progress logs or research-specific local logging. If exact logging cannot be preserved through the shared method, leave `runToolStream` in place and mark this task `N/A` with reason.                                            | N/A       | 2026-04-25 |

### Implementation Phase 2 - Central Structured Output Composition

- GOAL-003: Consolidate repeated structured-output assembly in [src/lib/response.ts](src/lib/response.ts) while keeping domain-specific fields in tool modules.

| Task     | Description                                                                                                                                                                                                                                                                              | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-011 | In [src/lib/response.ts](src/lib/response.ts), add a typed helper that builds successful tool structured content from `requestId`, warnings, domain fields, and stream metadata. The helper MUST omit empty optional fields the same way `buildSharedStructuredMetadata` currently does. | Yes       | 2026-04-25 |
| TASK-012 | Refactor [src/tools/analyze.ts](src/tools/analyze.ts) `buildAnalyzeStructuredContent` to use the shared response helper. Verify output still satisfies `AnalyzeOutputSchema`.                                                                                                            | Yes       | 2026-04-25 |
| TASK-013 | Refactor [src/tools/research.ts](src/tools/research.ts) `buildResearchStructuredContent` to use the shared response helper. Verify output still satisfies `ResearchOutputSchema`.                                                                                                        | Yes       | 2026-04-25 |
| TASK-014 | Refactor [src/tools/review.ts](src/tools/review.ts) `buildReviewStructuredContent` and review-specific structured builders to use the shared response helper without changing diff statistics, skipped-path arrays, documentation drift fields, or empty-result behavior.                | Yes       | 2026-04-25 |
| TASK-015 | Refactor [src/tools/chat.ts](src/tools/chat.ts) `getAskStructuredContent` and `formatStructuredResult` only where it reduces duplication. Preserve JSON repair warnings, parsed-data behavior, session links, and related task metadata.                                                 | N/A       | 2026-04-25 |
| TASK-016 | Run [response.test.ts](__tests__/lib/response.test.ts), [ask-structured.test.ts](__tests__/tools/ask-structured.test.ts), and all tool tests. Then run `npm run type-check`.                                                                                                             | Yes       | 2026-04-25 |

### Implementation Phase 3 - Declarative Selector Validation

- GOAL-004: Replace repeated branch-heavy schema refinements in [src/schemas/validators.ts](src/schemas/validators.ts) with table-driven validation that preserves current error messages and paths.

| Task     | Description                                                                                                                                                                                                                                                                                       | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-017 | In [src/schemas/validators.ts](src/schemas/validators.ts), add an internal `SelectorRule` helper type that declares selector name, selector value, required fields, forbidden fields, and exact error-message format. Do not export this helper unless tests require direct access.               | Yes       | 2026-04-25 |
| TASK-018 | Rewrite `validateFlatAnalyzeInput` using selector rules for `targetKind` and `outputKind`. Preserve exact messages: `filePath is required when targetKind=file.`, `urls is required when targetKind=url.`, `filePaths is required when targetKind=multi.`, and existing forbidden-field messages. | Yes       | 2026-04-25 |
| TASK-019 | Rewrite `validateFlatReviewInput` using selector rules for `subjectKind`. Preserve exact required-field and forbidden-field messages.                                                                                                                                                             | Yes       | 2026-04-25 |
| TASK-020 | Rewrite `validateFlatResearchInput` using selector rules for `mode`. Preserve the current quick/deep allowed-field behavior.                                                                                                                                                                      | Yes       | 2026-04-25 |
| TASK-021 | Add or update tests in [inputs.test.ts](__tests__/schemas/inputs.test.ts) for each required and forbidden field case. Assertions MUST check issue path and message, not only parse failure.                                                                                                       | Yes       | 2026-04-25 |
| TASK-022 | Run schema tests and `npm run type-check`. Reject the refactor if the helper makes the validation harder to read than the current branch form.                                                                                                                                                    | Yes       | 2026-04-25 |

### Implementation Phase 4 - Upload Lifecycle Consolidation

- GOAL-005: Centralize repeated Gemini upload cleanup behavior into [src/lib/file.ts](src/lib/file.ts) without changing cleanup ordering or error logging.

| Task     | Description                                                                                                                                                                                                                                                                                                      | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-023 | In [src/lib/file.ts](src/lib/file.ts), add a `withUploadedFilesCleanup` helper that accepts an async operation, tracks uploaded Gemini file names, and calls `deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx))` in `finally`. The helper MUST preserve existing behavior when no files were uploaded. | Yes       | 2026-04-25 |
| TASK-024 | Migrate [src/tools/analyze.ts](src/tools/analyze.ts) single-file, multi-file, and diagram upload flows to the helper. Preserve progress step numbering and labels exactly.                                                                                                                                       | Yes       | 2026-04-25 |
| TASK-025 | Migrate [src/tools/review.ts](src/tools/review.ts) compare-file upload cleanup to the helper. Preserve uploaded part order and cleanup behavior.                                                                                                                                                                 | Yes       | 2026-04-25 |
| TASK-026 | Run analyze/review tool tests and `npm run type-check`. Add a focused test if cleanup-on-error is not already covered.                                                                                                                                                                                           | Yes       | 2026-04-25 |

### Implementation Phase 5 - Tool File Simplification

- GOAL-006: Remove local duplication from tool files after shared seams are proven stable.

| Task     | Description                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-027 | In [src/tools/analyze.ts](src/tools/analyze.ts), inline or delete obsolete local helpers made redundant by Phases 1 and 4. Completion criterion: file has fewer lines and no duplicate generation/upload cleanup helper remains.                             | Yes       | 2026-04-25 |
| TASK-028 | In [src/tools/review.ts](src/tools/review.ts), inline or delete obsolete local helpers made redundant by Phases 1 and 4. Completion criterion: review generation has one shared path through `ToolExecutor`.                                                 | Yes       | 2026-04-25 |
| TASK-029 | In [src/tools/research.ts](src/tools/research.ts), simplify local stream wrappers only where Phase 1 produced exact parity. Keep research-specific aggregation local. Completion criterion: no behavior-specific logging is hidden in a generic abstraction. | N/A       | 2026-04-25 |
| TASK-030 | In [src/tools/chat.ts](src/tools/chat.ts), extract only local named predicates or parameter objects inside the same file unless a net-neutral file-count change is approved. Do not move session or JSON repair logic before tests prove parity.             | N/A       | 2026-04-25 |
| TASK-031 | Run line-count hotspot command and compare with baseline: `Get-ChildItem -Path src -Filter *.ts -Recurse ... Sort-Object Lines -Descending`. Completion criterion: top tool files shrink or their repeated responsibilities are visibly removed.             | Yes       | 2026-04-25 |

### Implementation Phase 6 - Final Verification and Documentation

- GOAL-007: Prove behavior parity and document the new internal refactor boundary.

| Task     | Description                                                                                                                                                                                                      | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-032 | Run `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`, and `npm run knip`. Do not run `npm run build` unless explicitly approved before this phase.                                         | Yes       | 2026-04-25 |
| TASK-033 | Re-run source file count command and verify `CURRENT_SRC_TS_COUNT <= BASE_SRC_TS_COUNT`. If the count increased, revert or merge files until the constraint holds.                                               | Yes       | 2026-04-25 |
| TASK-034 | Update this plan file with completed task dates and any tasks marked `N/A` with technical reasons.                                                                                                               | Yes       | 2026-04-25 |
| TASK-035 | Add a short note to the relevant existing docs only if public contributor guidance changed. Do not update README for internal-only refactors unless commands, public behavior, or architecture guidance changed. | N/A       | 2026-04-25 |

## 3. Alternatives

- **ALT-001**: Split each large tool into folders and many smaller modules. Rejected for this plan because it increases production file count and conflicts with the user constraint.
- **ALT-002**: Perform local cleanup inside each tool file without changing shared modules. Rejected because it leaves the repeated orchestration, streaming, response, and cleanup patterns duplicated.
- **ALT-003**: Create a new `src/lib/tool-workflow.ts` module for all shared logic. Rejected unless paired with deleting or merging an existing production file in the same commit, because the plan must keep production file count net-neutral or lower.
- **ALT-004**: Start with [src/tools/chat.ts](src/tools/chat.ts) because it is the largest file. Rejected because chat has the highest behavioral risk due to sessions, replay history, function calls, and JSON repair. Analyze and review provide safer first migrations.
- **ALT-005**: Convert tools to classes. Rejected because the codebase currently favors module-level functions, and classes would add ceremony without preserving clearer call sites.

## 4. Dependencies

- **DEP-001**: Node.js `>=24` runtime from [package.json](package.json).
- **DEP-002**: Existing TypeScript compiler configuration in [tsconfig.json](tsconfig.json).
- **DEP-003**: Existing test runner command `npm run test` using Node built-in test runner with `tsx/esm`.
- **DEP-004**: Existing `@google/genai` SDK API for `generateContentStream`, `GenerateContentConfig`, `ToolListUnion`, and upload parts.
- **DEP-005**: Existing `@modelcontextprotocol/server` SDK API for `CallToolResult`, `ServerContext`, tasks, and progress reporting.
- **DEP-006**: Existing Zod v4 schemas and `z.toJSONSchema`-compatible contract tests.

## 5. Files

- **FILE-001**: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) - central Gemini stream execution helper.
- **FILE-002**: [src/lib/response.ts](src/lib/response.ts) - shared structured-output composition.
- **FILE-003**: [src/lib/file.ts](src/lib/file.ts) - upload cleanup lifecycle helper.
- **FILE-004**: [src/lib/orchestration.ts](src/lib/orchestration.ts) - reused orchestration request types; no public behavior change expected.
- **FILE-005**: [src/schemas/validators.ts](src/schemas/validators.ts) - declarative selector validation refactor.
- **FILE-006**: [src/tools/analyze.ts](src/tools/analyze.ts) - first migration target for shared execution and upload lifecycle.
- **FILE-007**: [src/tools/review.ts](src/tools/review.ts) - second migration target for shared execution and upload lifecycle.
- **FILE-008**: [src/tools/research.ts](src/tools/research.ts) - optional migration target for stream helper if logging parity holds.
- **FILE-009**: [src/tools/chat.ts](src/tools/chat.ts) - final and most conservative cleanup target.
- **FILE-010**: `__tests__/lib/tool-executor.test.ts`, `__tests__/lib/response.test.ts`, `__tests__/lib/orchestration.test.ts`, `__tests__/schemas/inputs.test.ts`, and relevant tests under `__tests__/tools` - characterization and parity tests.
- **FILE-011**: [docs/plan/refactor-maintainability-consolidation-1.md](docs/plan/refactor-maintainability-consolidation-1.md) - this plan.

## 6. Testing

- **TEST-001**: `npm run lint` MUST pass after every phase that edits production code.
- **TEST-002**: `npm run type-check` MUST pass after every phase that edits TypeScript types or production code.
- **TEST-003**: `npm run test` MUST pass after every phase; targeted tests may be run inside a phase, but the full test suite is required before the phase is complete.
- **TEST-004**: `npm run knip` MUST pass in Phase 0 and Phase 6, and after any task that adds, removes, or changes exports.
- **TEST-005**: Tool executor tests MUST cover success, error, stream error, terminal progress, and structured-content merging after `runGeminiStream` is introduced.
- **TEST-006**: Response tests MUST cover omission of empty metadata, inclusion of warnings, preservation of `requestId`, preservation of usage metadata, and schema-validation fallback behavior.
- **TEST-007**: Schema input tests MUST assert exact issue messages and paths for analyze, review, and research selector rules.
- **TEST-008**: Analyze and review tests MUST cover upload cleanup on success and failure.
- **TEST-009**: Chat structured-output tests MUST cover JSON parse failure, JSON schema warning, retry warning text, function calls, related task metadata, and session resource links after response helper changes.

## 7. Risks & Assumptions

- **RISK-001**: A shared stream helper could hide tool-specific logging or progress details. Mitigation: migrate analyze first, then review, then research only if exact parity is demonstrable.
- **RISK-002**: Over-generalizing response composition could make output shape harder to understand. Mitigation: keep domain-specific fields in tool files and centralize only base metadata assembly.
- **RISK-003**: Declarative validation tables could obscure simple branching logic. Mitigation: reject Phase 3 if the helper is less readable than the current code or if error messages drift.
- **RISK-004**: `exactOptionalPropertyTypes` regressions may appear when introducing parameter objects. Mitigation: use conditional spreads and avoid assigning `undefined` to optional external API fields.
- **RISK-005**: Upload lifecycle abstraction could change cleanup order or error swallowing. Mitigation: helper tracks names in insertion order and reuses existing `deleteUploadedFiles` plus existing cleanup error logger.
- **RISK-006**: Existing broad tests may depend on subtle log/progress strings. Mitigation: add characterization assertions before changing production code.
- **RISK-007**: The new implementation plan file increases repository file count. Mitigation: the file-count constraint is applied to production source files under `src/`; implementation commits must keep `src/**/*.ts` net-neutral or lower.
- **ASSUMPTION-001**: Internal refactors can be validated with mocked Gemini streams and do not require live Gemini API calls.
- **ASSUMPTION-002**: No external consumer imports unexported internal helpers from current tool files.
- **ASSUMPTION-003**: The existing test suite is authoritative for public MCP contract behavior, with added characterization tests filling identified gaps.
- **ASSUMPTION-004**: File-count constraint is intended to prevent production module proliferation, not to forbid this requested plan document.

## 8. Related Specifications / Further Reading

- [docs/plan/refactor-tools-modularization-1.md](docs/plan/refactor-tools-modularization-1.md) - prior file-splitting refactor plan; superseded for this constraint set.
- [docs/plan/refactor-gemini-tool-orchestration-1.md](docs/plan/refactor-gemini-tool-orchestration-1.md) - existing orchestration context.
- [docs/plan/architecture-orchestration-extensibility-1.md](docs/plan/architecture-orchestration-extensibility-1.md) - architecture context for orchestration boundaries.
- [AGENTS.md](AGENTS.md) - repository commands, constraints, and safety boundaries.

## 9. Implementation Notes

- Phase 0 baseline: `npm run lint`, `npm run type-check`, and `npm run test` passed before production edits. `npm run knip` exited 1 with pre-existing unused export/type findings. `BASE_SRC_TS_COUNT` was 38.
- Final verification: `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test` passed. Final full suite: 860 tests passed. `npm run knip` still exits 1 with baseline-only findings: `SafetySettingsSchema` plus 14 unused exported types.
- Final production source count: `CURRENT_SRC_TS_COUNT` is 38, equal to `BASE_SRC_TS_COUNT`.
- TASK-010/TASK-029: research stream wrapping was intentionally left local because `runToolStream` owns research-specific initial progress and sanitized local logging; hiding that inside the generic executor would reduce clarity and risk log drift.
- TASK-015/TASK-030: chat structured/session logic was left unchanged because its JSON repair, session persistence, function-response replay, and related-task metadata are already tightly coupled and no lower-risk duplication removal was identified.
- TASK-035: no public commands, behavior, or contributor guidance changed; no README or external documentation update was needed.
