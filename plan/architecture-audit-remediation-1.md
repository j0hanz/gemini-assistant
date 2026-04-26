---
goal: Remediate all implementation-audit recommendations across grounding, sessions, streaming, transport, prompts, contracts, and verification
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Planned'
tags: [architecture, refactor, security, contract, streaming, audit]
---

<!-- markdownlint-disable MD060 -->

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan converts the full implementation audit into a deterministic remediation program for the `gemini-assistant` MCP server. Scope includes all Critical, High, Medium, and Low recommendations covering public grounding truthfulness, Gemini function-calling and session continuity, streaming safety, HTTP transport and rate limiting, prompt/runtime alignment, cache and portability edge cases, and the required regression and contract tests.

## 1. Requirements & Constraints

- **REQ-001**: `deriveFindingsFromCitations()` in [src/lib/response.ts](src/lib/response.ts) MUST stop labeling citations as verified support unless runtime evidence has actually been computed.
- **REQ-002**: `FindingSchema` in [src/schemas/fields.ts](src/schemas/fields.ts) MUST align with the runtime meaning of `verificationStatus`; if no verifier exists, the schema MUST expose a neutral state such as `cited` or the field MUST be removed.
- **REQ-003**: `buildSessionGenerationContract()` and `sameSessionContractValue()` in [src/tools/chat.ts](src/tools/chat.ts) MUST include the resolved function-calling enforcement semantics, including any injected prompt suffix or a deterministic hash of that suffix.
- **REQ-004**: `handleFunctionCallPart()` in [src/lib/streaming.ts](src/lib/streaming.ts) MUST preserve multiple same-name same-args function calls when Gemini omits `id`.
- **REQ-005**: Plain-text part coalescing in [src/lib/streaming.ts](src/lib/streaming.ts) MUST preserve `thoughtSignature` when the first replay-relevant post-thought part is text.
- **REQ-006**: `buildReplayHistoryParts()` in [src/sessions.ts](src/sessions.ts) MUST drop orphaned `functionResponse` parts whenever the paired `functionCall` is dropped.
- **REQ-007**: `webRateLimitKey()` and `nodeRateLimitKey()` in [src/transport.ts](src/transport.ts) MUST derive a real caller identity under an explicit proxy-trust model instead of collapsing requests into a shared bucket.
- **REQ-008**: `assertHttpBindIsProtected()` in [src/transport.ts](src/transport.ts) MUST require an explicit opt-out for unauthenticated loopback HTTP access.
- **REQ-009**: `auditClaimedToolUsage()` and `computeGroundingSignals()` in [src/lib/response.ts](src/lib/response.ts) MUST not make user-visible status decisions from English-only prose heuristics.
- **REQ-010**: The JSON repair loop in [src/tools/chat.ts](src/tools/chat.ts) MUST repair structured-output failures without re-running a full high-cost turn when a smaller repair turn can be used.
- **REQ-011**: `resolveServerSideToolInvocations()` in [src/lib/orchestration.ts](src/lib/orchestration.ts) MUST surface built-in tool execution tracing even when no declared client functions are present.
- **REQ-012**: `runWithoutSession()` and session event construction in [src/tools/chat.ts](src/tools/chat.ts) MUST keep transcript text and event text consistent across repair retries.
- **REQ-013**: Deep-research turn budgeting in [src/tools/research.ts](src/tools/research.ts) MUST resolve an explicit retrieval budget before running turns and MUST surface that budget to callers.
- **REQ-014**: Diagram extraction in [src/tools/analyze.ts](src/tools/analyze.ts) MUST fail closed on unlabeled fenced output unless the fallback is explicitly marked invalid.
- **REQ-015**: `uploadFile()` in [src/lib/file.ts](src/lib/file.ts) MUST validate uploaded file content against an allow-list or explicit sniffing rule before relying on extension-derived MIME.
- **REQ-016**: `DISCOVERY_ENTRIES`, `ChatOutputSchema`, `ResearchOutputSchema`, and related public resources in [src/public-contract.ts](src/public-contract.ts), [src/schemas/outputs.ts](src/schemas/outputs.ts), [src/prompts.ts](src/prompts.ts), and [src/resources.ts](src/resources.ts) MUST match actual runtime behavior after remediation.
- **REQ-017**: `buildGroundedAnswerPrompt()`, `buildDiffReviewPrompt()`, `buildAgenticResearchPrompt()`, and `appendFunctionCallingInstruction()` in [src/lib/model-prompts.ts](src/lib/model-prompts.ts) MUST not promise behavior the runtime does not enforce.
- **REQ-018**: `buildGenerateContentConfig()` in [src/client.ts](src/client.ts) MUST retain current `mediaResolution` forwarding and gain explicit regression coverage so that future refactors do not regress this behavior.
- **REQ-019**: All new behavior MUST be covered by deterministic tests under [tests](__tests__).
- **SEC-001**: HTTP transport MUST not degrade into a global anonymous rate-limit bucket in stateful or stateless mode.
- **SEC-002**: URL validation in [src/lib/validation.ts](src/lib/validation.ts) MUST remain non-public-host only and any residual DNS rebinding gap MUST be documented as a deployment assumption.
- **CON-001**: Do not add new runtime dependencies.
- **CON-002**: Do not create new source directories or rename public MCP tools.
- **CON-003**: Preserve the default Gemini model `gemini-3-flash-preview`.
- **CON-004**: Follow existing `exactOptionalPropertyTypes` conditional-spread patterns.
- **GUD-001**: Prefer localized helper extraction in existing files over broad rewrites.
- **PAT-001**: Use existing `AppError`, `ProtocolError`, `ProgressReporter`, `resolveOrchestration`, and schema-validation idioms already present in the repo.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Make grounded outputs semantically truthful and align the public contract with actual evidence semantics.

| Task     | Description                                                                                                                                                                                                                                                         | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In [src/lib/response.ts](src/lib/response.ts), replace the unconditional `verificationStatus: 'supported'` assignment in `deriveFindingsFromCitations()` with a neutral state such as `cited`, or remove the field from the derived object when no verifier exists. |           |      |
| TASK-002 | In [src/schemas/fields.ts](src/schemas/fields.ts), update `FindingSchema.verificationStatus` to match TASK-001 exactly, including enum values and descriptions.                                                                                                     |           |      |
| TASK-003 | In [src/schemas/outputs.ts](src/schemas/outputs.ts), update `ResearchOutputSchema.findings` and `citations` descriptions so they describe attribution rather than proof when no verifier is present.                                                                |           |      |
| TASK-004 | In [src/lib/response.ts](src/lib/response.ts), remove user-visible status dependence on `auditClaimedToolUsage()` from `computeGroundingSignals()` and `deriveOverallStatus()`, or demote the audit result to a warning-only field.                                 |           |      |
| TASK-005 | In [src/public-contract.ts](src/public-contract.ts), update `DISCOVERY_ENTRIES.research.returns` and any limitations text so the contract does not overstate claim verification.                                                                                    |           |      |

### Implementation Phase 2

- GOAL-002: Stabilize Gemini function-calling continuity across sessions, replay, and streaming.

| Task     | Description                                                                                                                                                                                                             | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-006 | In [src/tools/chat.ts](src/tools/chat.ts) `buildSessionGenerationContract()`, append a deterministic field representing the resolved function-calling instruction text or a hash of that text.                          |           |      |
| TASK-007 | In [src/tools/chat.ts](src/tools/chat.ts) `sameSessionContractValue()` and `isCompatibleSessionContract()`, compare the new function-calling instruction contract field so incompatible resumes fail deterministically. |           |      |
| TASK-008 | In [src/lib/streaming.ts](src/lib/streaming.ts) `handleFunctionCallPart()`, replace the `id ?? name:JSON(args)` dedupe key with ordinal-aware tracking so repeated identical calls without `id` are all preserved.      |           |      |
| TASK-009 | In [src/lib/streaming.ts](src/lib/streaming.ts), attach `thoughtSignature` to coalesced text parts when `isCoalescablePlainTextPart()` merges the replay-relevant text boundary.                                        |           |      |
| TASK-010 | In [src/sessions.ts](src/sessions.ts) `buildReplayHistoryParts()`, drop `functionResponse` parts whose paired `functionCall` was dropped because of missing name, oversize inline data, or other replay filtering.      |           |      |
| TASK-011 | In [src/tools/chat.ts](src/tools/chat.ts) `runWithoutSession()` and session-event assembly, make `message`, `sentMessage`, transcript parts, and event request fields deterministic across repair retries.              |           |      |

### Implementation Phase 3

- GOAL-003: Hard-fix transport identity, authentication defaults, and rate-limiter correctness.

| Task     | Description                                                                                                                                                                                                                                                  | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-012 | In [src/transport.ts](src/transport.ts), add an explicit transport config flag such as `MCP_TRUST_PROXY` and implement shared identity extraction for `nodeRateLimitKey()` and `webRateLimitKey()` using `X-Forwarded-For` only when proxy trust is enabled. |           |      |
| TASK-013 | In [src/transport.ts](src/transport.ts), replace the `'anonymous'` fallback in `webRateLimitKey()` with a non-colliding identity strategy or an explicit rejection path when no identity can be derived.                                                     |           |      |
| TASK-014 | In [src/transport.ts](src/transport.ts) `assertHttpBindIsProtected()`, require `MCP_HTTP_TOKEN` by default even on loopback unless a separate explicit opt-out variable is set.                                                                              |           |      |
| TASK-015 | In [src/config.ts](src/config.ts), strengthen `parseOptionalTokenEnv()` to reject trivially weak repeated-pattern tokens in addition to length-only validation.                                                                                              |           |      |
| TASK-016 | In [src/public-contract.ts](src/public-contract.ts) and [src/resources.ts](src/resources.ts), document the new proxy-trust and unauthenticated-loopback rules so the runtime contract matches the transport behavior.                                        |           |      |

### Implementation Phase 4

- GOAL-004: Make orchestration, prompting, and structured-output repair behavior match runtime reality.

| Task     | Description                                                                                                                                                                                                                       | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-017 | In [src/lib/orchestration.ts](src/lib/orchestration.ts) `resolveServerSideToolInvocations()`, include built-in-only execution paths so server-side traces are surfaced even when no declared client functions exist.              |           |      |
| TASK-018 | In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) `appendFunctionCallingInstruction()`, add wording for built-in-only tool execution so the prompt reflects actual server-side invocation behavior.                         |           |      |
| TASK-019 | In [src/tools/chat.ts](src/tools/chat.ts), replace the current full-turn JSON repair rerun with a reduced repair turn that sends the invalid JSON output plus schema error details and marks the event stream as repaired.        |           |      |
| TASK-020 | In [src/lib/model-prompts.ts](src/lib/model-prompts.ts), revise `buildGroundedAnswerPrompt()` so any exact-string promises are either enforced in code or removed from the prompt.                                                |           |      |
| TASK-021 | In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) `buildDiffReviewPrompt()`, either enforce `documentationDrift` extraction from unfenced JSON or change the prompt to require only the format the parser actually accepts. |           |      |
| TASK-022 | In [src/lib/model-prompts.ts](src/lib/model-prompts.ts) `buildAgenticResearchPrompt()`, sanitize interpolated planning content so control-like tokens from the research topic cannot change instruction meaning.                  |           |      |

### Implementation Phase 5

- GOAL-005: Tighten research, analyze, file-upload, and validation edge cases.

| Task     | Description                                                                                                                                                                                                                                                           | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-023 | In [src/tools/research.ts](src/tools/research.ts) `runDeepResearchPlan()`, compute a resolved retrieval budget before executing retrieval turns and include that budget in warnings or structured output.                                                             |           |      |
| TASK-024 | In [src/tools/analyze.ts](src/tools/analyze.ts) `extractDiagram()`, remove the silent unlabeled-fence success path or mark the result `syntaxValid=false` with explicit `syntaxErrors`.                                                                               |           |      |
| TASK-025 | In [src/lib/file.ts](src/lib/file.ts) `uploadFile()`, add file-content sniffing or an explicit MIME allow-list validation step before upload succeeds.                                                                                                                |           |      |
| TASK-026 | In [src/lib/validation.ts](src/lib/validation.ts) and [src/resources.ts](src/resources.ts), document the DNS-rebinding residual risk for URL Context / public URL fetching and keep runtime validation logic unchanged unless a network-layer control is added later. |           |      |
| TASK-027 | In [src/client.ts](src/client.ts) `buildGenerateContentConfig()`, keep the existing `mediaResolution` forwarding and add a no-regression assertion in tests rather than changing runtime code unless a bug is discovered.                                             |           |      |

### Implementation Phase 6

- GOAL-006: Remove remaining contract, cache, portability, and metadata drift.

| Task     | Description                                                                                                                                                                                                  | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-028 | In [src/tools/chat.ts](src/tools/chat.ts), surface an explicit warning when automatic workspace cache is skipped because `systemInstruction`, custom `temperature`, or `seed` disables cache eligibility.    |           |      |
| TASK-029 | In [src/public-contract.ts](src/public-contract.ts), add the cache-disabling conditions to `DISCOVERY_ENTRIES.chat.limitations`.                                                                             |           |      |
| TASK-030 | In [src/server.ts](src/server.ts), replace the unconditional module-load `package.json` read with a build-safe fallback sequence that still preserves the current version string when available.             |           |      |
| TASK-031 | In [src/lib/response.ts](src/lib/response.ts) `extractUsage()`, align the emitted usage metadata fields with the installed `@google/genai` `UsageMetadata` shape and add a guard against silent field drift. |           |      |
| TASK-032 | In [src/lib/response.ts](src/lib/response.ts), move grounding confidence thresholds to named constants in [src/config.ts](src/config.ts) or local exported constants so they become testable and explicit.   |           |      |
| TASK-033 | In [src/lib/orchestration.ts](src/lib/orchestration.ts), surface the current logger-only URL/file-search orchestration warnings into tool output warnings where applicable.                                  |           |      |

### Implementation Phase 7

- GOAL-007: Add deterministic regression coverage for all remediations.

| Task     | Description                                                                                                                                                                                                                  | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-034 | In [response tests](__tests__/lib/response.test.ts), add cases proving `deriveFindingsFromCitations()` does not emit `supported` without a verifier and that `computeGroundingSignals()` no longer depends on English prose. |           |      |
| TASK-035 | In [session tests](__tests__/sessions.test.ts), add session-contract mismatch tests for function-calling instruction drift and replay-history tests for orphaned `functionResponse` removal.                                 |           |      |
| TASK-036 | In [streaming tests](__tests__/lib/streaming.test.ts), add fixtures for duplicate same-args function calls without `id` and for coalesced text preserving `thoughtSignature`.                                                |           |      |
| TASK-037 | In [transport tests](__tests__/transport.test.ts) and [transport host tests](__tests__/transport-host-validation.test.ts), add proxy-trust and per-identity rate-limit coverage for Node and Web Standard transports.        |           |      |
| TASK-038 | In [config tests](__tests__/config.test.ts), add coverage for new auth opt-out and weak-token rejection rules.                                                                                                               |           |      |
| TASK-039 | In [orchestration tests](__tests__/lib/orchestration.test.ts), assert built-in-only flows can still surface `serverSideToolInvocations`.                                                                                     |           |      |
| TASK-040 | In [research tests](__tests__/tools/research.test.ts), add explicit deep-research turn-budget tests and warning assertions.                                                                                                  |           |      |
| TASK-041 | In [analyze diagram tests](__tests__/tools/analyze-diagram-validation.test.ts) and related analyze tests, assert unlabeled fences fail closed or return explicit syntax invalidation.                                        |           |      |
| TASK-042 | In [file tests](__tests__/lib/file.test.ts), add upload MIME/content validation coverage.                                                                                                                                    |           |      |
| TASK-043 | In [client tests](__tests__/client.test.ts), add a no-regression test asserting `mediaResolution` is forwarded through `buildGenerateContentConfig()`.                                                                       |           |      |
| TASK-044 | In [documentation tests](__tests__/documentation.test.ts), add assertions that public contract text and prompt/resource descriptions match new runtime behaviors for grounding, cache eligibility, and transport rules.      |           |      |

### Implementation Phase 8

- GOAL-008: Validate the full remediation set with repository quality gates.

| Task     | Description                                                                                      | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-045 | Run `npm run format` after all code and test edits land.                                         |           |      |
| TASK-046 | Run `npm run lint` and resolve any new findings without suppressing existing rules.              |           |      |
| TASK-047 | Run `npm run type-check` and resolve any type drift created by the schema and transport changes. |           |      |
| TASK-048 | Run `npm run test` and confirm all existing and new suites pass.                                 |           |      |

## 3. Alternatives

- **ALT-001**: Implement only Critical and High findings and defer Medium and Low findings. Rejected because the user requested a plan for all recommendations and several Medium items affect contract clarity and operator ergonomics.
- **ALT-002**: Remove `verificationStatus` entirely from grounded findings and skip schema changes. Rejected because a neutral status can preserve compatibility with fewer downstream changes if consumers already rely on the field.
- **ALT-003**: Keep loopback unauthenticated by default and document the risk. Rejected because the audit identified multi-tenant local environments as a realistic exposure and the existing transport already values explicit hardening.
- **ALT-004**: Leave `_fnSeen` behavior unchanged and require Gemini to always emit function-call IDs. Rejected because the stream consumer must be robust to valid SDK outputs, not vice versa.
- **ALT-005**: Add a new verifier service for citation truthfulness in this same plan. Rejected because it would introduce new infrastructure and dependencies; this plan only removes false guarantees and aligns the contract with current evidence semantics.

## 4. Dependencies

- **DEP-001**: Existing `@google/genai` streaming and `UsageMetadata` surface used by [src/client.ts](src/client.ts), [src/lib/tool-executor.ts](src/lib/tool-executor.ts), and [src/lib/streaming.ts](src/lib/streaming.ts).
- **DEP-002**: Existing MCP SDK v2 server, transport, prompt, and resource registration in [src/server.ts](src/server.ts), [src/transport.ts](src/transport.ts), [src/prompts.ts](src/prompts.ts), and [src/resources.ts](src/resources.ts).
- **DEP-003**: Existing session persistence and replay helpers in [src/sessions.ts](src/sessions.ts) and [src/tools/chat.ts](src/tools/chat.ts).
- **DEP-004**: Existing transport configuration parsing in [src/config.ts](src/config.ts).
- **DEP-005**: Existing documentation and contract tests under [tests](__tests__).

## 5. Files

- **FILE-001**: [src/lib/response.ts](src/lib/response.ts) — grounded finding semantics, grounding signals, usage metadata alignment.
- **FILE-002**: [src/schemas/fields.ts](src/schemas/fields.ts) — `FindingSchema.verificationStatus` contract update.
- **FILE-003**: [src/schemas/outputs.ts](src/schemas/outputs.ts) — public output description updates.
- **FILE-004**: [src/tools/chat.ts](src/tools/chat.ts) — session contract, JSON repair, transcript/event consistency, cache warnings.
- **FILE-005**: [src/sessions.ts](src/sessions.ts) — replay filtering for paired function responses.
- **FILE-006**: [src/lib/streaming.ts](src/lib/streaming.ts) — duplicate function-call preservation and `thoughtSignature` text handling.
- **FILE-007**: [src/transport.ts](src/transport.ts) — proxy trust, rate-limit keys, loopback auth default.
- **FILE-008**: [src/config.ts](src/config.ts) — transport auth opt-out, weak token detection, explicit thresholds if adopted.
- **FILE-009**: [src/lib/orchestration.ts](src/lib/orchestration.ts) — server-side invocation exposure and warning surfacing.
- **FILE-010**: [src/lib/model-prompts.ts](src/lib/model-prompts.ts) — prompt/runtime alignment fixes.
- **FILE-011**: [src/tools/research.ts](src/tools/research.ts) — deep-research budget resolution and warnings.
- **FILE-012**: [src/tools/analyze.ts](src/tools/analyze.ts) — diagram extraction failure-closed behavior.
- **FILE-013**: [src/lib/file.ts](src/lib/file.ts) — upload content validation.
- **FILE-014**: [src/lib/validation.ts](src/lib/validation.ts) — deployment-risk documentation hooks only unless runtime change is explicitly approved later.
- **FILE-015**: [src/public-contract.ts](src/public-contract.ts) — discovery entry and limitation text updates.
- **FILE-016**: [src/resources.ts](src/resources.ts) — operator-facing runtime-resource documentation updates.
- **FILE-017**: [src/server.ts](src/server.ts) — package version fallback hardening.
- **FILE-018**: [response tests](__tests__/lib/response.test.ts) — grounding semantics tests.
- **FILE-019**: [session tests](__tests__/sessions.test.ts) — session contract and replay tests.
- **FILE-020**: [streaming tests](__tests__/lib/streaming.test.ts) — duplicate call and `thoughtSignature` tests.
- **FILE-021**: [transport tests](__tests__/transport.test.ts) — rate-limit identity and auth tests.
- **FILE-022**: [transport host tests](__tests__/transport-host-validation.test.ts) — transport-host and proxy coverage.
- **FILE-023**: [config tests](__tests__/config.test.ts) — token and config validation tests.
- **FILE-024**: [orchestration tests](__tests__/lib/orchestration.test.ts) — server-side invocation exposure tests.
- **FILE-025**: [research tests](__tests__/tools/research.test.ts) — retrieval-budget tests.
- **FILE-026**: [analyze diagram tests](__tests__/tools/analyze-diagram-validation.test.ts) — diagram strictness tests.
- **FILE-027**: [file tests](__tests__/lib/file.test.ts) — upload validation tests.
- **FILE-028**: [client tests](__tests__/client.test.ts) — `mediaResolution` forwarding regression test.
- **FILE-029**: [documentation tests](__tests__/documentation.test.ts) — contract and docs drift tests.

## 6. Testing

- **TEST-001**: Grounded findings never emit `supported` without a verifier and research status no longer depends on English-only prose heuristics.
- **TEST-002**: Sessions reject resumes when resolved function-calling instruction semantics changed between turns.
- **TEST-003**: Replay history drops orphaned `functionResponse` parts after filtering paired `functionCall` parts.
- **TEST-004**: Streaming preserves duplicate same-args function calls without `id` and preserves `thoughtSignature` across coalesced text boundaries.
- **TEST-005**: Node and Web Standard transports derive distinct rate-limit identities under trusted proxy configuration and reject unsafe anonymous collapse.
- **TEST-006**: Loopback HTTP requires auth by default unless the explicit opt-out flag is set.
- **TEST-007**: Weak repeated-pattern bearer tokens are rejected by config parsing.
- **TEST-008**: Built-in-only tool flows still surface `serverSideToolInvocations` where expected.
- **TEST-009**: JSON repair uses a reduced repair turn and records repair state deterministically.
- **TEST-010**: Deep research emits an explicit retrieval-budget warning when requested depth exceeds executable retrieval turns.
- **TEST-011**: Unlabeled diagrams fail closed or return `syntaxValid=false` with explicit errors.
- **TEST-012**: File uploads reject disallowed or mismatched MIME/content combinations.
- **TEST-013**: `mediaResolution` remains forwarded through `buildGenerateContentConfig()`.
- **TEST-014**: Public contract and prompt descriptions stay synchronized with runtime behavior for grounding, cache eligibility, and transport rules.
- **TEST-015**: Full repository gates pass: `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`.

## 7. Risks & Assumptions

- **RISK-001**: Changing `verificationStatus` semantics may affect downstream clients that already treat the field as proof. Mitigation: keep a neutral state instead of deleting the field when possible.
- **RISK-002**: Tightening loopback auth and proxy handling may change local developer workflows. Mitigation: provide a single explicit opt-out and document it in public resources.
- **RISK-003**: Removing duplicate-call dedupe may expose previously hidden model behavior and increase downstream function execution volume. Mitigation: pair the change with deterministic tests and explicit event tracing.
- **RISK-004**: Reduced JSON repair turns may surface latent schema/prompt weaknesses sooner because the system stops masking them with full reruns. Mitigation: add targeted repair-path tests.
- **RISK-005**: MIME/content validation may reject files that previously uploaded successfully based only on extension. Mitigation: keep the allow-list explicit and test common text/code cases.
- **ASSUMPTION-001**: The installed `@google/genai` version continues to support the current `generateContentStream` request shape and `UsageMetadata` surface.
- **ASSUMPTION-002**: No external system depends on the exact current wording of `DISCOVERY_ENTRIES` and prompt/resource descriptions beyond semantic equivalence.
- **ASSUMPTION-003**: The repository will continue to use in-memory sessions and not introduce external session storage during this remediation plan.

## 8. Related Specifications / Further Reading

- [plan/refactor-function-calling-defaults-1.md](plan/refactor-function-calling-defaults-1.md)
- [plan/security-transport-hardening-1.md](plan/security-transport-hardening-1.md)
- [AGENTS.md](AGENTS.md)
- [src/lib/response.ts](src/lib/response.ts)
- [src/lib/streaming.ts](src/lib/streaming.ts)
- [src/tools/chat.ts](src/tools/chat.ts)
- [src/transport.ts](src/transport.ts)
- [src/lib/model-prompts.ts](src/lib/model-prompts.ts)
