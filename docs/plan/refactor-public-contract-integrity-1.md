---
goal: Align public contract with runtime behavior and harden public input surface
version: 1.0
date_created: 2026-04-23
last_updated: 2026-04-23
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['refactor', 'contract', 'public-api', 'security', 'architecture']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan resolves the five findings in `.github/report.md` against the current `master` branch. The findings describe public-contract/runtime mismatches (P0-1, P1-4), an under-validated public input (P0-2), a missing Gemini-native mode (P1-3), and over-broad server-side-tool-invocation forcing in research flows (P1-5). This plan replaces inconsistent wording, tightens schemas, and restores parity between documented and runtime behavior. It supersedes any conflicting guidance in `docs/plan/refactor-gemini-tool-orchestration-1.md` and `docs/plan/architecture-orchestration-extensibility-1.md` for the surfaces it touches.

## 1. Requirements & Constraints

- **REQ-001**: The resource `gemini://sessions/{sessionId}/turns/{turnIndex}/parts` MUST return bytes that match its advertised wording; either persist raw Gemini `Part[]` alongside the replay-filtered variant OR weaken the wording to describe the filtered variant precisely.
- **REQ-002**: `additionalTools` MUST NOT be exposed as `z.unknown().array()` on public tool inputs. The field MUST be removed or replaced by a strict allow-listed schema; orchestration MUST reject unknown keys before dispatch to Gemini.
- **REQ-003**: `FUNCTION_CALLING_MODE_OPTIONS` MUST include `VALIDATED`, and `toFunctionCallingConfigMode()` (chat) and the orchestration plumbing MUST map it to `FunctionCallingConfigMode.VALIDATED`.
- **REQ-004**: Public field descriptions for `serverSideToolInvocations` and `thinkingBudget` MUST match runtime semantics exactly, including explicit precedence.
- **REQ-005**: Research flows MUST default to `serverSideToolInvocations: 'auto'` and only set `'always'` where traces are demonstrably needed (mixed built-in + function-calling synthesis).
- **SEC-001**: No existing safety / URL-validation / redaction behavior may regress. `sanitizeHistoryParts` / `buildReplayHistoryParts` contracts stay intact.
- **SEC-002**: Strictening `additionalTools` MUST reject unknown object keys at the Zod boundary (`z.strictObject` / discriminated union), preventing unmodeled Gemini tool shapes from reaching the SDK.
- **CON-001**: Public tool names, workflow names, and resource URIs in `src/public-contract.ts` MUST remain stable. Only descriptions, `inputs` lists, and `returns` text may change.
- **CON-002**: Session persistence memory footprint MUST NOT grow unboundedly. If raw parts are persisted, the same `replayInlineDataMaxBytes`-style ceiling MUST apply to raw-part storage (or a dedicated cap MUST be introduced).
- **CON-003**: `@google/genai` SDK version is fixed by the repo; `FunctionCallingConfigMode.VALIDATED` is already available (verified in `node_modules/@google/genai/dist/node/node.d.ts`).
- **GUD-001**: Contract descriptions stay concise and factual; precedence rules are stated anywhere overlapping knobs are exposed.
- **PAT-001**: Public input schemas use `z.strictObject` with explicit field shapes, matching the rest of `src/schemas/inputs.ts`.

## 2. Implementation Steps

### Implementation Phase 1 — P0 contract truthfulness

- GOAL-001: Make `gemini://sessions/.../parts` truthful and tighten `additionalTools` to a safe public shape.

| Task     | Description                                                                                                                                                                                                                                                                                                                                       | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/sessions.ts` add optional `rawParts?: Part[]` to `ContentEntry` alongside existing `parts: Part[]`. Update `cloneContentEntry` to clone `rawParts` when present. Do NOT filter `rawParts` through `buildReplayHistoryParts`.                                                                                                              | Yes       | 2026-04-23 |
| TASK-002 | In `src/sessions.ts` introduce `getSessionLimits().rawPartsInlineDataMaxBytes` (default = existing `replayInlineDataMaxBytes`). Add a private `capRawParts(parts)` helper that drops only oversized `inlineData` (keeps `thought` parts and nameless functionCalls — raw means raw).                                                              | Yes       | 2026-04-23 |
| TASK-003 | In `src/tools/chat.ts` at the two model-turn persistence sites (lines ~467 and ~841) pass both `parts: buildReplayHistoryParts(...)` (replay) and `rawParts: capRawParts(structuredClone(originalParts))` (raw, SDK-faithful). Preserve `thoughtSignature` on every retained part.                                                                | Yes       | 2026-04-23 |
| TASK-004 | In `src/resources.ts` update `readSessionTurnPartsResource` to return `entry.rawParts ?? entry.parts` (fallback keeps legacy behavior for pre-existing sessions) and to expose this via `application/json` unchanged.                                                                                                                             | Yes       | 2026-04-23 |
| TASK-005 | In `src/resources.ts` update the `session-turn-parts` resource description to: "Raw Gemini model-turn `Part[]` for replay-safe orchestration. Oversized `inlineData` payloads are elided but all other parts — including `thought` and `thoughtSignature` — are served verbatim."                                                                 | Yes       | 2026-04-23 |
| TASK-006 | In `src/public-contract.ts` (entry for `gemini://sessions/{sessionId}/turns/{turnIndex}/parts` and the `chat` tool `returns` field) mirror the same wording from TASK-005. Remove the phrase "raw turn parts for replay orchestration when sessions are active" from the `chat` `returns` if the raw-parts path is not written by that call site. | Yes       | 2026-04-23 |
| TASK-007 | In `src/schemas/inputs.ts` delete the three `additionalTools: withFieldMetadata(z.unknown().array().optional(), ...)` fields (chat, research base, analyze). Remove `additionalTools` from `ChatInput`, `ResearchInputBase`, and the analyze variant.                                                                                             | Yes       | 2026-04-23 |
| TASK-008 | In `src/public-contract.ts` remove every `'additionalTools?'` entry from discovery `inputs` arrays and from any workflow / catalog wording.                                                                                                                                                                                                       | Yes       | 2026-04-23 |
| TASK-009 | In `src/tools/research.ts` remove the 5 `...(args.additionalTools ? { additionalTools: args.additionalTools as ToolListUnion } : {})` conditional spreads and the `additionalTools` destructures at lines ~798, ~923, ~962.                                                                                                                       | Yes       | 2026-04-23 |
| TASK-010 | In `src/tools/chat.ts` remove any reference to `args.additionalTools` in orchestration request building.                                                                                                                                                                                                                                          | Yes       | 2026-04-23 |
| TASK-011 | In `src/lib/orchestration.ts` remove the `additionalTools?: ToolListUnion` field from `OrchestrationRequest` and its consumption in `buildOrchestrationConfig` (`extraTools`, the `[...builtInTools, ...functionTools, ...extraTools]` concat).                                                                                                   | Yes       | 2026-04-23 |
| TASK-012 | Update `__tests__/lib/orchestration.test.ts`, `__tests__/tools/research.test.ts`, `__tests__/tools/ask.test.ts` to remove all `additionalTools`-based cases. Add a single negative test asserting that sending `additionalTools` at the tool boundary fails strict-object validation with `-32602`.                                               | Yes       | 2026-04-23 |

### Implementation Phase 2 — P1 contract/runtime parity

- GOAL-002: Add `VALIDATED`, correct public descriptions, and right-size research trace policy.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                   | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-013 | In `src/schemas/fields.ts` change `FUNCTION_CALLING_MODE_OPTIONS` to `['AUTO', 'ANY', 'NONE', 'VALIDATED'] as const`.                                                                                                                                                                                                                                         | Yes       | 2026-04-23 |
| TASK-014 | In `src/tools/chat.ts` `toFunctionCallingConfigMode()` add the `VALIDATED` branch returning `FunctionCallingConfigMode.VALIDATED`. Ensure the mapping is exhaustive (TS `satisfies Record<(typeof FUNCTION_CALLING_MODE_OPTIONS)[number], FunctionCallingConfigMode>`).                                                                                       | Yes       | 2026-04-23 |
| TASK-015 | In `src/schemas/fields.ts` rewrite the `FunctionsSpecSchema.mode` description to: "Gemini function-calling mode. `AUTO` (default model choice), `ANY` (must call a declared function), `NONE` (disable calling), `VALIDATED` (stronger default for mixed tool + structured-output flows)."                                                                    | Yes       | 2026-04-23 |
| TASK-016 | In `src/schemas/fields.ts` rewrite the `ServerSideToolInvocationsSchema` description to: "Server-side Gemini tool trace policy. `auto` (default): enabled only when built-in tools AND function declarations are both active. `always`: forces traces regardless of tool mix. `never`: omits traces."                                                         | Yes       | 2026-04-23 |
| TASK-017 | In `src/schemas/fields.ts` rewrite the `thinkingBudget` description to: "Override thinking token budget. Applied only when `thinkingLevel` is omitted; `thinkingLevel` takes precedence when both are set."                                                                                                                                                   | Yes       | 2026-04-23 |
| TASK-018 | In `src/public-contract.ts` update any `thinkingBudget` / `serverSideToolInvocations` prose in discovery entries to mirror TASK-016 and TASK-017 wording.                                                                                                                                                                                                     | Yes       | 2026-04-23 |
| TASK-019 | In `src/tools/research.ts` change `serverSideToolInvocations: 'always'` to omit the field (letting it default to `'auto'`) at lines ~673, ~721, ~870, ~985 (retrieval turns and built-in-only flows). Keep `'always'` ONLY at line ~812 (deep-research synthesis where function-calling + built-in tools are mixed) and add an inline comment explaining why. | Yes       | 2026-04-23 |
| TASK-020 | In `src/tools/analyze.ts` audit the three `serverSideToolInvocations: 'always'` usages (lines ~259, ~348, ~441). Keep `'always'` only where both built-in and function-calling tooling actually coexist; otherwise omit to fall back to `'auto'`. Document the decision inline.                                                                               | Yes       | 2026-04-23 |
| TASK-021 | In `src/tools/review.ts` audit the three `serverSideToolInvocations: 'always'` usages (lines ~307, ~384, ~1106) with the same rule as TASK-020.                                                                                                                                                                                                               | Yes       | 2026-04-23 |

### Implementation Phase 3 — Verification & documentation

- GOAL-003: Lock the new contract with tests, update internal plans, and verify no regressions.

| Task     | Description                                                                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-022 | Update `__tests__/schemas/inputs.test.ts` and `__tests__/schemas/public-contract.test.ts` to assert: (a) `additionalTools` is absent from all public schemas; (b) `VALIDATED` is accepted by `FunctionsSpec.mode`; (c) description strings match the new wording exactly for `serverSideToolInvocations` and `thinkingBudget`.         | Yes       | 2026-04-23 |
| TASK-023 | Add `__tests__/sessions.test.ts` cases: (a) `ContentEntry.rawParts` retains `thought` parts and nameless `functionCall` parts; (b) oversized `inlineData` is still elided in raw parts; (c) `parts` (replay) remains filtered as before (no regression).                                                                               | Yes       | 2026-04-23 |
| TASK-024 | Add `__tests__/resources.test.ts` case: reading `gemini://sessions/{id}/turns/{n}/parts` returns the raw-parts array (including thoughts) when populated, and falls back to `parts` when `rawParts` is absent.                                                                                                                         | Yes       | 2026-04-23 |
| TASK-025 | Update `__tests__/tools/research.test.ts` expectations so retrieval turns no longer assert `toolConfig.includeServerSideToolInvocations === true`; keep the assertion ONLY for the synthesis turn.                                                                                                                                     | Yes       | 2026-04-23 |
| TASK-026 | Update `__tests__/lib/orchestration.test.ts` to cover `serverSideToolInvocations: 'auto'` mapping with and without function declarations and to exercise the `VALIDATED` mode end-to-end through `buildOrchestrationConfig` → `buildGenerateContentConfig`.                                                                            | Yes       | 2026-04-23 |
| TASK-027 | In `docs/plan/refactor-gemini-tool-orchestration-1.md` and `docs/plan/architecture-orchestration-extensibility-1.md` delete or strike through every row referencing `additionalTools` as a public input field. Reference this plan (`refactor-public-contract-integrity-1.md`) as the superseding source for the public input surface. | Yes       | 2026-04-23 |
| TASK-028 | Update `AGENTS.md` "Architecture" bullet about history sanitization to clarify that raw parts are persisted alongside replay parts for the turn-parts resource, and replay parts remain filtered.                                                                                                                                      | Yes       | 2026-04-23 |
| TASK-029 | Run `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`. All must pass.                                                                                                                                                                                                                                             | Yes       | 2026-04-23 |

## 3. Alternatives

- **ALT-001**: Soften the `gemini://sessions/.../parts` wording to describe the replay-filtered variant (no second persistence layer). Rejected: replay-safe multi-turn orchestration explicitly needs SDK-faithful parts including `thoughtSignature`; weakening the resource removes its only unique value.
- **ALT-002**: Keep `additionalTools` but validate against a hand-rolled allow-listed union (`z.discriminatedUnion` over `functionDeclarations`, `googleSearchRetrieval`, etc.). Rejected: overlaps with the typed `functions`, `googleSearch`, `codeExecution`, `fileSearch` fields the server already exposes; the extra surface adds maintenance cost without a known use case.
- **ALT-003**: Add `VALIDATED` but keep the three enum description verbatim. Rejected: violates REQ-004 parity goal; description must signal when to use `VALIDATED`.
- **ALT-004**: Keep `serverSideToolInvocations: 'always'` in research and document the cost trade-off. Rejected: REQ-005 requires defaulting to `auto`; `always` is retained only where mixed tool traces are functionally required.

## 4. Dependencies

- **DEP-001**: `@google/genai` SDK (already installed) — provides `FunctionCallingConfigMode.VALIDATED`.
- **DEP-002**: `zod` v4 (already in use) — `z.strictObject`, `z.enum` with `as const` arrays.
- **DEP-003**: No new runtime dependencies. No new dev dependencies.

## 5. Files

- **FILE-001**: `src/sessions.ts` — add `rawParts` on `ContentEntry`, cloning, and raw-part cap.
- **FILE-002**: `src/tools/chat.ts` — populate `rawParts` at both persistence sites; add `VALIDATED` mapping in `toFunctionCallingConfigMode`; remove `additionalTools` consumption.
- **FILE-003**: `src/tools/research.ts` — drop `additionalTools` plumbing; remove forced `'always'` except on synthesis.
- **FILE-004**: `src/tools/analyze.ts` — narrow `'always'` forcing.
- **FILE-005**: `src/tools/review.ts` — narrow `'always'` forcing.
- **FILE-006**: `src/lib/orchestration.ts` — remove `additionalTools` from `OrchestrationRequest`.
- **FILE-007**: `src/schemas/fields.ts` — add `VALIDATED`; rewrite three description strings.
- **FILE-008**: `src/schemas/inputs.ts` — delete all three `additionalTools` field definitions.
- **FILE-009**: `src/public-contract.ts` — remove `additionalTools?` from `inputs`; update `returns` wording for `chat`; update description for `gemini://sessions/{sessionId}/turns/{turnIndex}/parts`.
- **FILE-010**: `src/resources.ts` — update `session-turn-parts` description and read-handler fallback.
- **FILE-011**: `__tests__/schemas/inputs.test.ts`, `__tests__/schemas/public-contract.test.ts`, `__tests__/sessions.test.ts`, `__tests__/resources.test.ts`, `__tests__/lib/orchestration.test.ts`, `__tests__/tools/research.test.ts`, `__tests__/tools/ask.test.ts` — coverage updates per Phase 3.
- **FILE-012**: `docs/plan/refactor-gemini-tool-orchestration-1.md`, `docs/plan/architecture-orchestration-extensibility-1.md` — supersede `additionalTools` rows.
- **FILE-013**: `AGENTS.md` — clarify raw-parts persistence.

## 6. Testing

- **TEST-001**: Schema regression — `additionalTools` is rejected by `ChatInputSchema`, `ResearchInputSchema`, `AnalyzeInputSchema` with a Zod `unrecognized_keys` error.
- **TEST-002**: Schema positive — `FunctionsSpec.mode` accepts `'VALIDATED'`; `toFunctionCallingConfigMode('VALIDATED')` returns `FunctionCallingConfigMode.VALIDATED`.
- **TEST-003**: Contract wording — deterministic string-equal assertions on the new descriptions for `serverSideToolInvocations`, `thinkingBudget`, `FunctionsSpec.mode`, and the `session-turn-parts` resource.
- **TEST-004**: Raw parts resource — reading the resource returns `thought` parts and `thoughtSignature` values verbatim after a chat turn that produced thinking output.
- **TEST-005**: Replay parity — `buildReplayHistoryParts` behavior remains byte-equal to pre-change for identical inputs (no regression in session rebuild).
- **TEST-006**: Orchestration — `buildOrchestrationConfig` with only built-in tools and no function declarations produces `toolConfig === undefined` when policy is `'auto'`; it produces `includeServerSideToolInvocations: true` when policy is `'always'` or when both built-ins and function declarations are active under `'auto'`.
- **TEST-007**: Research end-to-end — retrieval turns do NOT set `includeServerSideToolInvocations`; synthesis turn DOES.
- **TEST-008**: Contract stability — `PUBLIC_TOOL_NAMES`, `PUBLIC_RESOURCE_URIS`, `PUBLIC_PROMPT_NAMES`, `PUBLIC_WORKFLOW_NAMES` arrays are unchanged (snapshot).

## 7. Risks & Assumptions

- **RISK-001**: Persisting `rawParts` doubles per-turn memory for chat sessions. Mitigation: raw parts reuse the same `inlineData` ceiling; both `parts` and `rawParts` share structure without full duplication of large binary content.
- **RISK-002**: Removing `additionalTools` is a breaking change for any external MCP client that relied on it. Mitigation: the field was typed as `z.unknown()` and undocumented beyond "custom Gemini Tool declarations"; no public workflow depends on it; callers should migrate to typed `functions`, `googleSearch`, `fileSearch`, `codeExecution`.
- **RISK-003**: Defaulting research retrieval to `'auto'` may reduce trace fidelity for consumers who were relying on always-on tool traces. Mitigation: synthesis turn retains `'always'`; explicit per-flow comments document the rationale.
- **RISK-004**: `VALIDATED` mode behavior across Gemini model versions may differ. Mitigation: it is additive and only selected when explicitly requested by the caller; no default behavior changes.
- **ASSUMPTION-001**: The existing `@google/genai` version exported via `node_modules/@google/genai/dist/node/node.d.ts` includes `FunctionCallingConfigMode.VALIDATED` (verified April 2026).
- **ASSUMPTION-002**: Pre-existing sessions without `rawParts` populated can safely fall back to `parts` for the turn-parts resource during an in-memory TTL window; there is no on-disk migration required because sessions are in-memory only.

## 8. Related Specifications / Further Reading

- `.github/report.md` — public contract review driving this plan
- `docs/plan/refactor-gemini-tool-orchestration-1.md` — prior plan that this plan supersedes for `additionalTools` public surface
- `docs/plan/architecture-orchestration-extensibility-1.md` — related architecture plan
- `.github/google-genai-api.md` §7 — `thinkingLevel` vs `thinkingBudget` precedence
- `@google/genai` SDK `FunctionCallingConfigMode` enum
- `src/lib/orchestration.ts` `resolveServerSideToolInvocations` — canonical runtime rule for `auto`
