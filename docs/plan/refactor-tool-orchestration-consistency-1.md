---
goal: Eliminate Inconsistencies in Gemini Tool Orchestration Layer
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, architecture, orchestration, gemini]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan addresses the inconsistencies identified by the Gemini built-in/custom tool orchestration audit (sections 3, 5, 8, 9 of the audit). It captures only the changes that are highly recommended (i.e. fix real drift, dead code, schema/executor asymmetry, or imminent extension friction). Full registry-style redesign is **out of scope** here and tracked separately.

The changes preserve all observable tool behavior. Public input contracts only **gain** optional fields (`fileSearch` on `analyze`/`review`); no field is removed or renamed.

## 1. Requirements & Constraints

- **REQ-001**: A single shared function MUST translate common public-tool inputs (`googleSearch`, `urls`, `codeExecution`, `fileSearch`, `functions`) into `BuiltInToolSpec[]` + `functionDeclarations` + `functionCallingMode`. Used by both `chat.ts` and `executor.executeGeminiPipeline`.
- **REQ-002**: `executor.executeGeminiPipeline` MUST NOT expose `googleSearch`, `urls`, or `fileSearch` as privileged first-class parameters. It MUST accept a single `builtInToolSpecs?: readonly BuiltInToolSpec[]` plus `urls` (kept only for URL validation + warning logging) and `serverSideToolInvocations`.
- **REQ-003**: The `analyze` and `review` Zod input schemas MUST expose the optional `fileSearch` field (using the existing `OptionalFileSearchSpecSchema`). Plumbing through to the executor MUST be wired.
- **REQ-004**: The dead `serverSideToolInvocations: 'auto'` block in `analyze_diagram` (no `functions` ever active) MUST be removed.
- **REQ-005**: URL Context fallback (when `urls` are provided but URL Context is not active) MUST use a single shared helper. `chat.ts` and `analyze.ts` MUST produce equivalent prompt fragments.
- **REQ-006**: `OrchestrationConfig.toolProfile` MUST be augmented with structured details: `{ fileSearchStoreCount?: number; functionCount?: number; functionCallingMode?: string; serverSideToolInvocations?: boolean }`. The string `toolProfile` field MUST remain unchanged for backward compatibility with `resources.ts` and `sessions.ts`.
- **CON-001**: No public MCP tool input field may be removed or renamed; only additive optional fields are allowed.
- **CON-002**: All existing tests MUST continue to pass without behavioral assertions changing. New tests may be added.
- **CON-003**: `npm run lint`, `npm run type-check`, and `npm run test` MUST pass at the end of every phase.
- **GUD-001**: Prefer co-locating the shared assembly helper inside `src/lib/orchestration.ts`.
- **GUD-002**: Keep `BuiltInToolSpec` discriminated union closed for now. Opening it to a registry is a separate plan.
- **PAT-001**: Keep tool-specific decisions (e.g., `analyze_diagram` deriving `codeExecution` from `validateSyntax`) at the tool layer, not in the shared helper.

## 2. Implementation Steps

### Implementation Phase 1 — Shared spec assembly

- GOAL-001: Eliminate duplication between `chat.ts:buildChatOrchestrationRequest` and `tool-executor.ts:executeGeminiPipeline` spec assembly. Single source of truth for "common Gemini tool inputs → orchestration request".

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In [src/lib/orchestration.ts](src/lib/orchestration.ts), add `export interface CommonToolInputs { googleSearch?: boolean; urls?: readonly string[]; codeExecution?: boolean; fileSearch?: { fileSearchStoreNames: readonly string[]; metadataFilter?: unknown }; functionDeclarations?: readonly FunctionDeclaration[]; functionCallingMode?: FunctionCallingConfigMode; serverSideToolInvocations?: ServerSideToolInvocationsPolicy }` and `export function buildOrchestrationRequestFromInputs(input: CommonToolInputs): OrchestrationRequest`. The function MUST produce an identical `BuiltInToolSpec[]` to the current `chat.ts` mapping (order: `googleSearch`, `urlContext`, `codeExecution`, `fileSearch`, plus extras). | Yes       | 2026-04-26 |
| TASK-002 | In [src/tools/chat.ts](src/tools/chat.ts), replace the body of `buildChatOrchestrationRequest` with a call to `buildOrchestrationRequestFromInputs`, mapping `args.functions?.declarations`, `toFunctionCallingConfigMode(args.functions?.mode)`, etc. Preserve existing return shape.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Yes       | 2026-04-26 |
| TASK-003 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), change `GeminiPipelineRequest` to: drop `googleSearch`, `fileSearch` fields; keep `urls?: readonly string[]` (used by `resolveOrchestration` for URL validation/logging) and `serverSideToolInvocations`; replace with `commonInputs?: CommonToolInputs` **OR** keep accepting `builtInToolSpecs` but route through `buildOrchestrationRequestFromInputs` internally. Pick the `commonInputs` variant.                                                                                                                                                                                                                                                                  | Yes       | 2026-04-26 |
| TASK-004 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), rewrite `executeGeminiPipeline` to call `buildOrchestrationRequestFromInputs(request.commonInputs ?? {})` and merge any caller-provided extra `builtInToolSpecs` (used by deep research auto-injecting `codeExecution`). Remove the inline `selectSearchAndUrlContextTools(...)` + `fileSearch` branch composition.                                                                                                                                                                                                                                                                                                                                                     | Yes       | 2026-04-26 |
| TASK-005 | Update all `executor.executeGeminiPipeline` call sites in [src/tools/research.ts](src/tools/research.ts), [src/tools/analyze.ts](src/tools/analyze.ts), [src/tools/review.ts](src/tools/review.ts) to pass `commonInputs: { googleSearch, urls, fileSearch, ... }` instead of separate top-level fields.                                                                                                                                                                                                                                                                                                                                                                                                                         | Yes       | 2026-04-26 |
| TASK-006 | Run `npm run lint && npm run type-check && npm run test`. Confirm zero regressions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Yes       | 2026-04-26 |

### Implementation Phase 2 — Schema additions for `fileSearch`

- GOAL-002: Make `fileSearch` reachable from every tool whose executor path already supports it.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-007 | In [src/schemas/inputs.ts](src/schemas/inputs.ts) `AnalyzeInputBaseSchema`, add `fileSearch: withFieldMetadata(OptionalFileSearchSpecSchema, 'Enable Gemini File Search over named stores during file/url/multi analysis.')`.                                                                                                                                                                               | Yes       | 2026-04-26 |
| TASK-008 | In [src/schemas/inputs.ts](src/schemas/inputs.ts) `ReviewInputBaseSchema`, add `fileSearch: withFieldMetadata(OptionalFileSearchSpecSchema, 'Enable Gemini File Search over named stores during comparison or failure review. Ignored for subjectKind=diff.')`.                                                                                                                                             | Yes       | 2026-04-26 |
| TASK-009 | In [src/tools/analyze.ts](src/tools/analyze.ts), thread `args.fileSearch` into `analyzeFileWork` (extra interface), `analyzeMultiFileWork` (`AnalyzeMultiExtra`), and `analyzeDiagramWork`. Forward into `commonInputs.fileSearch` of the pipeline call. For `analyzeDiagramWork`, pass `fileSearch` only when `args.targetKind !== 'url'` is irrelevant — pass it always; the model will use it if useful. | Yes       | 2026-04-26 |
| TASK-010 | In [src/tools/review.ts](src/tools/review.ts), thread `args.fileSearch` into `compareFileWork` and `diagnoseFailureWork`. Do NOT forward into `analyzePrWork` (diff review); that path intentionally has no built-ins.                                                                                                                                                                                      | Yes       | 2026-04-26 |
| TASK-011 | Update `__tests__/schemas/inputs.test.ts` and `__tests__/schemas/public-contract.test.ts` (and any catalog/contract snapshots) to include `fileSearch` in expected analyze/review parameter shapes.                                                                                                                                                                                                         | Yes       | 2026-04-26 |
| TASK-012 | Run `npm run lint && npm run type-check && npm run test`.                                                                                                                                                                                                                                                                                                                                                   | Yes       | 2026-04-26 |

### Implementation Phase 3 — Dead code removal & URL fallback unification

- GOAL-003: Remove no-op orchestration directives and unify URL Context fallback rendering across tools.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-013 | In [src/tools/analyze.ts](src/tools/analyze.ts) `analyzeDiagramWork`, remove the line `serverSideToolInvocations: (diagramBuiltInTools.length > 0 ? 'auto' : 'never') satisfies ServerSideToolInvocationsPolicy,`. The `auto` policy is a no-op without `functions`; `never` is the default behavior.                                                                                                                                                              | Yes       | 2026-04-26 |
| TASK-014 | In [src/lib/orchestration.ts](src/lib/orchestration.ts), add `buildUrlContextFallbackPart(urls, activeCapabilities)` returning a single `{ text: 'Context URLs:\n' + urls.join('\n') }` part when `urls?.length > 0` and `urlContext` is not active; otherwise `undefined`. Signature: `(urls?: readonly string[], activeCapabilities: ReadonlySet<string>) => { text: string } \| undefined`.                                                                     |           |            |
| TASK-015 | In [src/tools/analyze.ts](src/tools/analyze.ts) `analyzeFileWork` and `analyzeMultiFileWork`, replace the inline `urlContextPart` construction with `buildUrlContextFallbackPart(urls, activeCaps)`.                                                                                                                                                                                                                                                               | Yes       | 2026-04-26 |
| TASK-016 | In [src/tools/chat.ts](src/tools/chat.ts), replace `buildAskPrompt(message, urls)` URL appending with the same helper applied to a prompt part list, OR keep `buildAskPrompt` but document why chat appends to prompt text rather than emitting a separate `Part`. Decision criterion: if `chat.ts` already passes `contents: [...]` as a string, keep `buildAskPrompt` and add a code comment cross-referencing the helper to acknowledge intentional divergence. | Yes       | 2026-04-26 |
| TASK-017 | Run `npm run lint && npm run type-check && npm run test`.                                                                                                                                                                                                                                                                                                                                                                                                          | Yes       | 2026-04-26 |

### Implementation Phase 4 — Structured `toolProfile` details

- GOAL-004: Make tool profile observable enough for runtime triage without breaking string consumers.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-018 | In [src/lib/orchestration.ts](src/lib/orchestration.ts), add `export interface ToolProfileDetails { fileSearchStoreCount?: number; functionCount?: number; functionCallingMode?: string; serverSideToolInvocations?: boolean; }` and extend `OrchestrationConfig` with `toolProfileDetails: ToolProfileDetails`. Populate inside `buildOrchestrationConfig`. | Yes       | 2026-04-26 |
| TASK-019 | In [src/lib/orchestration.ts](src/lib/orchestration.ts) `resolveOrchestration`, include `toolProfileDetails` in the structured info-log payload.                                                                                                                                                                                                             | Yes       | 2026-04-26 |
| TASK-020 | Decide whether to expose `toolProfileDetails` on the chat session record `request` (in [src/sessions.ts](src/sessions.ts) line ~65). If yes, add an optional `toolProfileDetails?: ToolProfileDetails` field; do not surface it in resource markdown unless requested.                                                                                       | Yes       | 2026-04-26 |
| TASK-021 | Add a unit test in `__tests__/lib/orchestration.test.ts` (create if missing) asserting `toolProfileDetails` for: `googleSearch+urlContext`, `fileSearch` with 2 stores, `functions` with 3 declarations + `VALIDATED` mode, and combined `built-in + functions` (verifying `serverSideToolInvocations: true`).                                               | Yes       | 2026-04-26 |
| TASK-022 | Run `npm run format && npm run lint && npm run type-check && npm run test`.                                                                                                                                                                                                                                                                                  | Yes       | 2026-04-26 |

## 3. Alternatives

- **ALT-001**: Full capability registry rewrite (audit §10). Rejected for this plan — too large; covered separately.
- **ALT-002**: Keep `chat.ts` and `executor.executeGeminiPipeline` separate but copy any future change to both. Rejected — perpetuates documented drift risk and already produced the `codeExecution` asymmetry.
- **ALT-003**: Add `fileSearch` only to `analyze`, not `review`. Rejected — the executor already accepts it for `compare_files` and `review_failure`; asymmetric exposure is exactly the inconsistency this plan removes.
- **ALT-004**: Keep `serverSideToolInvocations: 'auto'` in `analyze_diagram` "for forward-compatibility". Rejected — `'auto'` semantics require `functions` to be present, which `analyze_diagram` schema does not allow. Misleading no-op.

## 4. Dependencies

- **DEP-001**: `@google/genai` (existing).
- **DEP-002**: `zod/v4` (existing).
- **DEP-003**: `@modelcontextprotocol/server` (existing).
- **DEP-004**: `OptionalFileSearchSpecSchema` and `ServerSideToolInvocationsSchema` already defined in [src/schemas/fields.ts](src/schemas/fields.ts).

## 5. Files

- **FILE-001**: [src/lib/orchestration.ts](src/lib/orchestration.ts) — add `CommonToolInputs`, `buildOrchestrationRequestFromInputs`, `buildUrlContextFallbackPart`, `ToolProfileDetails`. Extend `OrchestrationConfig` and `resolveOrchestration` log payload.
- **FILE-002**: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — drop privileged `googleSearch`/`fileSearch` params on `GeminiPipelineRequest`; route through `buildOrchestrationRequestFromInputs`.
- **FILE-003**: [src/tools/chat.ts](src/tools/chat.ts) — replace `buildChatOrchestrationRequest` body with shared helper call.
- **FILE-004**: [src/tools/analyze.ts](src/tools/analyze.ts) — thread `fileSearch`; remove dead `serverSideToolInvocations: 'auto'`; use `buildUrlContextFallbackPart`.
- **FILE-005**: [src/tools/review.ts](src/tools/review.ts) — thread `fileSearch` to `compareFileWork` and `diagnoseFailureWork` only.
- **FILE-006**: [src/tools/research.ts](src/tools/research.ts) — adjust `executeGeminiPipeline` call sites to use `commonInputs`.
- **FILE-007**: [src/schemas/inputs.ts](src/schemas/inputs.ts) — add `fileSearch` to `AnalyzeInputBaseSchema` and `ReviewInputBaseSchema`.
- **FILE-008**: [src/sessions.ts](src/sessions.ts) — optionally extend session `request` with `toolProfileDetails`.
- **FILE-009**: `__tests__/lib/orchestration.test.ts` — new file or extension; assertions for `toolProfileDetails` and shared helper.
- **FILE-010**: `__tests__/schemas/inputs.test.ts`, `__tests__/schemas/public-contract.test.ts` — accept new optional `fileSearch` field on analyze/review.
- **FILE-011**: `__tests__/tools/registration.test.ts` and `__tests__/contract-surface.test.ts` — update if catalog snapshots include analyze/review parameter lists.

## 6. Testing

- **TEST-001**: Unit — `buildOrchestrationRequestFromInputs` produces identical `BuiltInToolSpec[]` and order to the legacy `chat.ts` `buildChatOrchestrationRequest` for a representative input matrix (8 cases: each capability on/off).
- **TEST-002**: Unit — `buildUrlContextFallbackPart` returns `undefined` when `urlContext` is active or `urls` is empty; returns the expected text when both conditions fail.
- **TEST-003**: Unit — `OrchestrationConfig.toolProfileDetails` correctly counts `fileSearchStoreCount`, `functionCount`, captures `functionCallingMode`, and reflects `serverSideToolInvocations` for `auto` policy + combined built-in + functions.
- **TEST-004**: Schema — `AnalyzeInputSchema.parse({ ..., fileSearch: { fileSearchStoreNames: ['stores/x'] } })` succeeds for `targetKind=file`/`multi`/`url`.
- **TEST-005**: Schema — `ReviewInputSchema.parse({ ..., fileSearch: { ... } })` succeeds for `subjectKind=comparison` and `subjectKind=failure`; passes (ignored) for `subjectKind=diff` without error.
- **TEST-006**: Contract — existing `__tests__/schemas/public-contract.test.ts` snapshot updated; no other tool schemas regress.
- **TEST-007**: E2E — existing `__tests__/mcp-tools.e2e.test.ts` and `__tests__/e2e.test.ts` continue to pass with mocked Gemini environment.
- **TEST-008**: Behavior — when `analyze_diagram` runs with `validateSyntax=true` and `targetKind=url`, the dispatched `tools` list still contains `urlContext` and `codeExecution` (regression guard for TASK-013).

## 7. Risks & Assumptions

- **RISK-001**: Hidden call sites of `executeGeminiPipeline` outside the four primary tool files. Mitigation: full repo grep before TASK-005; current grep shows only the four expected files.
- **RISK-002**: Test snapshots may include hashed parameter lists that change when `fileSearch` is added. Mitigation: update snapshots as part of TASK-011.
- **RISK-003**: Adding `fileSearch` plumbing to `analyze_diagram` may interact with file uploads. Mitigation: the orchestration layer already handles `fileSearch` independently of attached parts; no new code required besides forwarding.
- **RISK-004**: Removing `serverSideToolInvocations: 'auto'` from `analyze_diagram` could be perceived as a behavior change. Mitigation: under current code paths, `'auto'` resolves to `undefined` because `functions` is not present, so the resolved `toolConfig` is identical.
- **ASSUMPTION-001**: `BuiltInToolSpec` ordering does not affect Gemini behavior. Verified by audit — order in `tools` list is preserved but not semantically significant.
- **ASSUMPTION-002**: All four primary tool files (`chat`, `research`, `analyze`, `review`) are the complete set using `executeGeminiPipeline`. Verified via grep `executeGeminiPipeline` across `src/`.
- **ASSUMPTION-003**: `OptionalFileSearchSpecSchema` shape is suitable for `analyze` and `review` without modification. Verified — same schema is in use on `chat` and `research`.

## 8. Related Specifications / Further Reading

- [docs/plan/refactor-gemini-tools-1.md](../plan/refactor-gemini-tools-1.md)
- [docs/plan/refactor-approach-a-consolidation-1.md](../plan/refactor-approach-a-consolidation-1.md)
- [.github/google-genai-api.md](../../.github/google-genai-api.md) §15 (tool combination), §20 (File Search), §25 (config fields)
- [src/lib/orchestration.ts](../../src/lib/orchestration.ts)
- [src/lib/tool-executor.ts](../../src/lib/tool-executor.ts)
