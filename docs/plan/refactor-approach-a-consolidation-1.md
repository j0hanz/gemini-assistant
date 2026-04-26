---
goal: Aggressive maintainability refactor (Approach A) — surgical consolidation across existing src files with zero new files and zero observable behavior change
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Planned'
tags: [refactor, maintainability, typescript, consolidation]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan executes Approach A from the brainstorming session: seven small, behavior-preserving refactor tickets that consolidate repeated logic into already-existing modules. The total source file count must remain at 32. No new files are created. No observable behavior changes (return values, errors, side effects, log strings, JSON shapes, session formats, default model `gemini-3-flash-preview`).

## 1. Requirements & Constraints

- **REQ-001**: Total file count under `src/` must remain exactly 32 after every phase. No file creations. No file deletions.
- **REQ-002**: Public MCP surface (`chat`, `research`, `analyze`, `review` tool inputs/outputs, prompt names, resource URIs) is unchanged.
- **REQ-003**: All existing tests under `__tests__/` continue to pass without modification, except where a test asserts a per-file constant string that is being relocated to a single source of truth (TASK-013 only — and only by changing the import, not the literal value).
- **REQ-004**: Default Gemini model remains `gemini-3-flash-preview`.
- **REQ-005**: Each ticket lands as one bisectable commit; no ticket mixes refactor with feature or bug fix.
- **CON-001**: Do NOT introduce centralization files such as `errorMessages.ts`, `mime.ts`, or `prompts/registry.ts` (per repo memory `/memories/repo/gemini-assistant.md`). Reuse existing modules only.
- **CON-002**: `transport.ts`, `lib/validation.ts`, `lib/workspace-context.ts`, `schemas/fields.ts` are out-of-scope.
- **CON-003**: `gemini-2.5-flash` must NOT be introduced anywhere.
- **GUD-001**: Follow the repo's `exactOptionalPropertyTypes: true` discipline — use conditional spreads, not `T | undefined` widening on optional properties.
- **GUD-002**: Prefer named module-level functions (existing repo style) over new classes.
- **PAT-001**: Reuse the existing `applySessionFieldRules` rule-table pattern when collapsing the slim-gated event clone (TASK-010).
- **PAT-002**: Reuse the existing `pickDefined` conditional-spread helper for any new optional-field assembly.
- **SEC-001**: No relaxation of host validation, path validation, public-URL filtering, or session redaction.

## 2. Implementation Steps

### Implementation Phase 1 — Pre-flight

- GOAL-001: Capture a behavior lock and baseline before any production edits.

| Task     | Description                                                                                                                                                    | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | Run `npm run lint && npm run type-check && npm run test` on `master`. Record pass/fail counts as the behavior lock. Abort plan if any baseline failure exists. |           |      |
| TASK-002 | Snapshot `src/` file count (`Get-ChildItem -Path src -Recurse -File \| Measure-Object`). Confirm value is `32`. Persist count for post-phase verification.     |           |      |
| TASK-003 | Create branch `refactor/approach-a-consolidation` from `master`.                                                                                               |           |      |

### Implementation Phase 2 — Ticket 3: `mcpLog` helper (Tier 0)

- GOAL-002: Extract the repeated fire-and-forget MCP log pattern into a single helper in [src/lib/logger.ts](src/lib/logger.ts) and replace every call site.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-004 | Add `export async function mcpLog(ctx: ServerContext, level: 'debug' \| 'info' \| 'warning' \| 'error', message: string): Promise<void>` to [src/lib/logger.ts](src/lib/logger.ts). Body: `await ctx.mcpReq.log(level, message).catch(() => undefined);`. Type `ctx` parameter using existing `ServerContext` import path used elsewhere in the repo.                                                                                                                                                                                                                                                                                                                                  |           |      |
| TASK-005 | Replace fire-and-forget call sites that currently use `void ctx.mcpReq.log(...).catch(() => undefined)` with `await mcpLog(ctx, level, message)`. Sites: [src/tools/research.ts](src/tools/research.ts) (≈6 occurrences around lines 173, 182, 192, 247). Verify no remaining `mcpReq.log(...).catch(() => undefined)` pattern via grep.                                                                                                                                                                                                                                                                                                                                               |           |      |
| TASK-006 | Replace plain `await ctx.mcpReq.log(level, msg)` call sites with `await mcpLog(ctx, level, msg)` in [src/tools/research.ts](src/tools/research.ts) lines 129, 243, 247, 652, 823, 869, 923; [src/tools/review.ts](src/tools/review.ts) lines 263, 348, 985; [src/tools/chat.ts](src/tools/chat.ts) lines 1012, 1034, 1047; [src/tools/analyze.ts](src/tools/analyze.ts) lines 166, 321; [src/lib/orchestration.ts](src/lib/orchestration.ts) lines 201, 205, 219; [src/lib/streaming.ts](src/lib/streaming.ts) lines 377, 875. Do NOT touch [src/lib/progress.ts](src/lib/progress.ts) line 225 (it is the lone log-emit fallback inside the progress reporter and must stay literal). |           |      |
| TASK-007 | Run `npm run lint && npm run type-check && npm run test`. All previously passing tests must still pass. Commit `refactor: introduce mcpLog helper for ctx.mcpReq.log call sites`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |           |      |

### Implementation Phase 3 — Ticket 6: Centralize tool labels (Tier 0)

- GOAL-003: Replace per-file `*_TOOL_LABEL` constants with a single mapping exported from [src/public-contract.ts](src/public-contract.ts).

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-008 | In [src/public-contract.ts](src/public-contract.ts), append: `export const TOOL_LABELS = { chat: 'Chat', research: 'Research', search: 'Web Search', analyzeUrl: 'Analyze URL', agenticSearch: 'Agentic Search', analyze: 'Analyze', analyzeFile: 'Analyze File', analyzeDiagram: 'Analyze Diagram', review: 'Review Diff', compareFiles: 'Compare Files', reviewFailure: 'Review Failure' } as const;` Verify literal values match the existing string constants exactly (case, punctuation, whitespace).                                                                    |           |      |
| TASK-009 | Delete per-file constants and import from `TOOL_LABELS`: [src/tools/chat.ts](src/tools/chat.ts) `ASK_TOOL_LABEL`; [src/tools/research.ts](src/tools/research.ts) `SEARCH_TOOL_LABEL`, `ANALYZE_URL_TOOL_LABEL`, `AGENTIC_SEARCH_TOOL_LABEL`; [src/tools/analyze.ts](src/tools/analyze.ts) `ANALYZE_FILE_TOOL_LABEL`, `ANALYZE_TOOL_LABEL`, `ANALYZE_DIAGRAM_TOOL_LABEL`; [src/tools/review.ts](src/tools/review.ts) `COMPARE_FILE_TOOL_LABEL`, `REVIEW_DIFF_TOOL_LABEL` and the inline `'Review Failure'` literal at line 346. Use `TOOL_LABELS.<key>` at every former usage. |           |      |
| TASK-010 | Run `npm run lint && npm run type-check && npm run test`. Commit `refactor: centralize tool labels in public-contract`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |           |      |

### Implementation Phase 4 — Ticket 7: Chat-input type cleanup (Tier 0)

- GOAL-004: Move chat-only mapped types adjacent to their schema in [src/schemas/inputs.ts](src/schemas/inputs.ts).

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                     | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-011 | In [src/schemas/inputs.ts](src/schemas/inputs.ts), near the `ChatInput` type export, add: `export type WithChatDefaults<T extends { temperature?: unknown; serverSideToolInvocations?: unknown; urls?: unknown }> = Omit<T, 'temperature' \| 'serverSideToolInvocations' \| 'urls'> & { temperature?: T['temperature'] \| undefined; serverSideToolInvocations?: T['serverSideToolInvocations'] \| undefined; urls?: string[] \| undefined };`. |           |      |
| TASK-012 | In [src/tools/chat.ts](src/tools/chat.ts) lines 88–100, delete `WithOptionalTemperature` and `WithOptionalChatDefaults`. Replace `ChatWorkInput` and `AskArgs` with `WithChatDefaults<ChatInput>` and `WithChatDefaults<AskInput> & { cacheName?: string }`. Import `WithChatDefaults` from `../schemas/inputs.js`.                                                                                                                             |           |      |
| TASK-013 | Run `npm run lint && npm run type-check && npm run test`. Commit `refactor: relocate chat-input mapped types next to ChatInput`.                                                                                                                                                                                                                                                                                                                |           |      |

### Implementation Phase 5 — Ticket 1: `executor.runWithProgress` (Tier 1)

- GOAL-005: Promote the de-facto `runToolStream` template from [src/tools/research.ts](src/tools/research.ts) into [src/lib/tool-executor.ts](src/lib/tool-executor.ts) and adopt it across all four tools.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-014 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), add a public method on `ToolExecutor`: `async runWithProgress<T extends Record<string, unknown>>(ctx, options): Promise<CallToolResult>` where `options = { toolKey: string; label: string; initialMsg: string; logMessage?: string; logData?: unknown; generator: () => Promise<AsyncGenerator<GenerateContentResponse>>; responseBuilder?: StreamResponseBuilder<T> }`. Body must replicate research.ts lines 121–133: construct `ProgressReporter`, call `progress.send(0, undefined, initialMsg)`, optionally call `mcpLog(ctx, 'info', logMessage)` and `this.scopedLogger.info(logMessage, maybeSummarizePayload(logData, ...))`, then delegate to `this.runStream(ctx, toolKey, label, generator, responseBuilder)`. |           |      |
| TASK-015 | Replace the local `runToolStream` helper in [src/tools/research.ts](src/tools/research.ts) (≈line 120) with calls to `executor.runWithProgress`. Delete the local helper after the last call site is migrated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |           |      |
| TASK-016 | Migrate analogous prologue blocks in [src/tools/chat.ts](src/tools/chat.ts) (lines 551–552, 1013–1014), [src/tools/analyze.ts](src/tools/analyze.ts) (lines 157, 167; 227, 236; 289, 320), [src/tools/review.ts](src/tools/review.ts) (lines 251, 264; 346–348; 1082–1127) to `executor.runWithProgress` ONLY for prologues that exactly match the `progress.send(0, …) + log + runStream` shape. Mid-stream `progress.step` calls remain as-is (they are inside `responseBuilder` callbacks or pre-pipeline upload steps and are NOT part of the prologue template).                                                                                                                                                                                                                |           |      |
| TASK-017 | Run `npm run lint && npm run type-check && npm run test`. Confirm no behavioral change in tool e2e tests under `__tests__/tools/`, `__tests__/e2e.test.ts`, `__tests__/mcp-tools.e2e.test.ts`. Commit `refactor: introduce executor.runWithProgress for tool prologue boilerplate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |           |      |

### Implementation Phase 6 — Ticket 2: Grounding presentation consolidation (Tier 1)

- GOAL-006: Move grounding-output assembly helpers from [src/tools/research.ts](src/tools/research.ts) into [src/lib/response.ts](src/lib/response.ts) (already the canonical home for `appendSources`, `appendUrlStatus`, `formatCountLabel`, `mergeSourceDetails`, etc.).

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-018 | Cut and paste the following functions from [src/tools/research.ts](src/tools/research.ts) into [src/lib/response.ts](src/lib/response.ts) under a `// ── Grounding Presentation ───` section: `buildSourceReportMessage`, `formatSourceLabels`, `collectUrlContextSources`, `buildUrlContextSourceDetails`, `appendSearchEntryPointContent`, `buildDroppedSupportWarnings`, `extractSampledText`, `countOccurrences`. Export each. Resolve any new imports in `lib/response.ts` (`pickDefined` is already local). |           |      |
| TASK-019 | In [src/tools/research.ts](src/tools/research.ts), replace local definitions with named imports from `../lib/response.js`. Confirm `formatCountLabel` import already exists; reuse it.                                                                                                                                                                                                                                                                                                                            |           |      |
| TASK-020 | Run `npm run lint && npm run type-check && npm run test`. Verify `__tests__/tools/research.test.ts` still passes unchanged. Commit `refactor: consolidate grounding presentation helpers in lib/response`.                                                                                                                                                                                                                                                                                                        |           |      |

### Implementation Phase 7 — Ticket 5: Slim-gated session-event clone via rule table (Tier 1)

- GOAL-007: Replace the 60-line conditional-spread `cloneSessionEventEntry` in [src/sessions.ts](src/sessions.ts) with a rule-table driven loop, mirroring the existing `applySessionFieldRules` pattern.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-021 | In [src/sessions.ts](src/sessions.ts), define `interface ResponseFieldRule { key: keyof SessionEventEntry['response']; slimOnly: boolean; clone: 'direct' \| 'structuredClone' \| 'shallowSpread' \| 'arrayShallow' }` and a `RESPONSE_FIELD_RULES` array enumerating every response field exactly as currently handled (text=direct/required, finishReason=direct, promptBlockReason=direct, data=structuredClone, functionCalls=arrayShallow, citationMetadata=structuredClone+slim, safetyRatings=structuredClone+slim, finishMessage=direct, schemaWarnings=arrayShallow, thoughts=direct+slim, toolEvents=arrayShallow+slim, usage=shallowSpread, groundingMetadata=structuredClone+slim, urlContextMetadata=structuredClone+slim, promptFeedback=structuredClone+slim, anomalies=shallowSpread). |           |      |
| TASK-022 | Replace the body of `cloneSessionEventEntry` with a single loop that iterates `RESPONSE_FIELD_RULES`, skips `slimOnly` rules when `slim` is true, skips fields whose value is `undefined`, and applies the chosen clone strategy. Preserve `text` as the always-present field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |           |      |
| TASK-023 | Run `npm run lint && npm run type-check && npm run test`. `__tests__/sessions.test.ts` is the primary behavior lock — every assertion must pass. Commit `refactor: drive session-event response clone with field-rule table`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |           |      |

### Implementation Phase 8 — Ticket 4: Analyze discriminated input (Tier 1)

- GOAL-008: Express `AnalyzeInput` as a discriminated union so runtime guards `requireAnalyzeField`, `requireAnalyzeFilePath`, `requireAnalyzeUrls`, `requireAnalyzeFilePaths`, `requireAnalyzeDiagramType` are eliminated.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-024 | In [src/schemas/inputs.ts](src/schemas/inputs.ts), redefine `AnalyzeInputSchema` using `z.discriminatedUnion('targetKind', [fileVariant, urlVariant, multiVariant])` where each variant requires its own set of fields (`filePath` for file; `urls` for url; `filePaths` for multi). Cross with `outputKind`: keep `outputKind` and `diagramType` as object-level fields, and add a `.superRefine` that asserts `diagramType` is present iff `outputKind === 'diagram'`. Preserve every existing field, default, and `.describe()` text. |           |      |
| TASK-025 | Re-export `AnalyzeInput = z.infer<typeof AnalyzeInputSchema>` so consumers continue to import the same name. Verify the inferred union structurally narrows on `targetKind`.                                                                                                                                                                                                                                                                                                                                                             |           |      |
| TASK-026 | In [src/tools/analyze.ts](src/tools/analyze.ts), delete `requireAnalyzeField`, `requireAnalyzeFilePath`, `requireAnalyzeUrls`, `requireAnalyzeFilePaths`, `requireAnalyzeDiagramType` (lines 51–78). Replace each call site with direct property access guarded by a discriminator check (e.g., `if (args.targetKind === 'file') { args.filePath … }`).                                                                                                                                                                                  |           |      |
| TASK-027 | Run `npm run lint && npm run type-check && npm run test`. The primary behavior locks are `__tests__/tools/analyze-diagram-progress.test.ts`, `__tests__/schemas/inputs.test.ts`, `__tests__/schemas/public-contract.test.ts`. Confirm validator error messages are preserved (Zod's discriminated-union path may change wording — if any test asserts an exact error string, prefer keeping a manual `.superRefine` that emits the previous message verbatim). Commit `refactor: model AnalyzeInput as a discriminated union`.           |           |      |

### Implementation Phase 9 — Verification & wrap-up

- GOAL-009: Confirm all gates hold and the file count is unchanged.

| Task     | Description                                                                                                                                     | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-028 | Re-run `Get-ChildItem -Path src -Recurse -File \| Measure-Object`. Assert count equals `32` (baseline from TASK-002). If not, abort and revert. |           |      |
| TASK-029 | Run `npm run format && npm run lint && npm run type-check && npm run test` on the branch tip. All must pass.                                    |           |      |
| TASK-030 | Update `last_updated` field of this plan to today's date and set `status` to `Completed`. Commit.                                               |           |      |

## 3. Alternatives

- **ALT-001**: Aggressive merge of `tools/research.ts` and `tools/analyze.ts` into a single read-tool module. Rejected: tool boundaries are real (grounded vs. ungrounded paths) and would force test churn beyond mechanical refactor scope.
- **ALT-002**: Full discriminated-union rewrite of `ResearchInput` and `ReviewInput` in addition to `AnalyzeInput`. Rejected for `review` because its three subjects share too many fields without a clean discriminator; rejected for `research` because mode is already a clean enum and runtime guards are minimal.
- **ALT-003**: Introduce new files (`errorMessages.ts`, `mime.ts`, `prompts/registry.ts`) for centralization. Rejected: violates CON-001 and the user's stated maintainability preference recorded in `/memories/repo/gemini-assistant.md`.
- **ALT-004**: Refactor `transport.ts` for managed-pair reuse. Rejected: Tier 2+ risk, no current behavior pressure, out of scope.

## 4. Dependencies

- **DEP-001**: Existing test suite under `__tests__/` (32 test files including `analyze-diagram-progress.test.ts`, `sessions.test.ts`, `tools/research.test.ts`, `mcp-tools.e2e.test.ts`). No new test infrastructure required.
- **DEP-002**: `zod/v4` (already a direct dependency) — required for `z.discriminatedUnion` in TASK-024.
- **DEP-003**: `@modelcontextprotocol/server` `ServerContext` type (already imported across the repo) for `mcpLog` signature.
- **DEP-004**: No new npm packages. No version bumps.

## 5. Files

- **FILE-001**: [src/lib/logger.ts](src/lib/logger.ts) — add `mcpLog` helper (Phase 2).
- **FILE-002**: [src/lib/orchestration.ts](src/lib/orchestration.ts) — adopt `mcpLog` (Phase 2).
- **FILE-003**: [src/lib/streaming.ts](src/lib/streaming.ts) — adopt `mcpLog` (Phase 2).
- **FILE-004**: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — add `runWithProgress` (Phase 5).
- **FILE-005**: [src/lib/response.ts](src/lib/response.ts) — absorb grounding presentation helpers (Phase 6).
- **FILE-006**: [src/public-contract.ts](src/public-contract.ts) — add `TOOL_LABELS` (Phase 3).
- **FILE-007**: [src/schemas/inputs.ts](src/schemas/inputs.ts) — add `WithChatDefaults` (Phase 4); remodel `AnalyzeInputSchema` as discriminated union (Phase 8).
- **FILE-008**: [src/sessions.ts](src/sessions.ts) — replace `cloneSessionEventEntry` body with rule-table loop (Phase 7).
- **FILE-009**: [src/tools/chat.ts](src/tools/chat.ts) — adopt `mcpLog`, `TOOL_LABELS`, `WithChatDefaults`, `executor.runWithProgress`.
- **FILE-010**: [src/tools/research.ts](src/tools/research.ts) — adopt `mcpLog`, `TOOL_LABELS`, `executor.runWithProgress`; remove relocated grounding helpers.
- **FILE-011**: [src/tools/analyze.ts](src/tools/analyze.ts) — adopt `mcpLog`, `TOOL_LABELS`, `executor.runWithProgress`; remove `requireAnalyze*` guards; consume discriminated `AnalyzeInput`.
- **FILE-012**: [src/tools/review.ts](src/tools/review.ts) — adopt `mcpLog`, `TOOL_LABELS`, `executor.runWithProgress`.

Total files modified: 12. Total files created: 0. Total files deleted: 0. Final src file count: 32 (unchanged).

## 6. Testing

- **TEST-001**: `__tests__/lib/tool-executor.test.ts` — must pass after TASK-014; add no new test, the existing `runStream` coverage exercises the new method indirectly.
- **TEST-002**: `__tests__/tools/research.test.ts` — must pass unchanged after Phases 5 and 6 (covers grounding presentation and stream prologue).
- **TEST-003**: `__tests__/tools/analyze-diagram-progress.test.ts` — must pass unchanged after Phase 8 (covers discriminated `AnalyzeInput` paths).
- **TEST-004**: `__tests__/sessions.test.ts` — must pass unchanged after Phase 7 (behavior lock for slim-gated event cloning).
- **TEST-005**: `__tests__/schemas/inputs.test.ts` and `__tests__/schemas/public-contract.test.ts` — must pass after Phase 8 (Zod schema shape and contract consistency).
- **TEST-006**: `__tests__/mcp-tools.e2e.test.ts` and `__tests__/e2e.test.ts` — must pass after every phase (end-to-end behavior lock).
- **TEST-007**: `__tests__/contract-surface.test.ts` and `__tests__/contract-errors.e2e.test.ts` — must pass after Phase 3 (TOOL_LABELS values must literally match prior strings).
- **TEST-008**: `npm run lint`, `npm run type-check`, `npm run format` must pass at every phase boundary.

## 7. Risks & Assumptions

- **RISK-001**: Zod `z.discriminatedUnion` may change validator error wording from the current `.superRefine`-based message in `validateFlatAnalyzeInput`. Mitigation: keep a `.superRefine` post-step that emits the previous error string verbatim if any test asserts on it.
- **RISK-002**: `executor.runWithProgress` adoption may accidentally swallow the per-tool log message ordering (MCP log vs. local scoped logger). Mitigation: replicate the exact ordering in TASK-014; visually diff against research.ts `runToolStream` body before commit.
- **RISK-003**: TOOL_LABELS literal drift — any whitespace or case mismatch breaks tests that assert progress messages. Mitigation: TASK-008 explicitly requires byte-identical string values.
- **RISK-004**: Slim-gated rule-table loop subtly changes which fields appear in cloned events when `slim=true`. Mitigation: enumerate every existing branch in TASK-021 and assert `__tests__/sessions.test.ts` passes unchanged.
- **ASSUMPTION-001**: All current tests on `master` pass before plan starts (validated by TASK-001).
- **ASSUMPTION-002**: No concurrent feature branch is touching any of FILE-001 … FILE-012; rebase-conflict cost is negligible.
- **ASSUMPTION-003**: The `runToolStream` helper in `tools/research.ts` is the canonical prologue shape; chat/analyze/review prologues are structurally compatible (verified during brainstorming).

## 8. Related Specifications / Further Reading

- [docs/plan/refactor-gemini-tools-1.md](docs/plan/refactor-gemini-tools-1.md)
- [docs/plan/refactor-string-consolidation-1.md](docs/plan/refactor-string-consolidation-1.md)
- [docs/specs/2026-04-26-refactor-design.md](docs/specs/2026-04-26-refactor-design.md)
- [AGENTS.md](AGENTS.md)
- Repo memory: `/memories/repo/gemini-assistant.md` (no-new-files constraint)
- Refactor skill: `c:\Users\PC\.agents\skills\refactor\SKILL.md`
- TypeScript advanced types skill: `c:\Users\PC\.agents\skills\typescript-advanced-types\SKILL.md`
