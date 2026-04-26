---
goal: Address all recommendations from `.github/report.md` for Gemini function-calling `VALIDATED` defaults, prompt accuracy, and orchestration forwarding
version: 1.1
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, bug, prompt, orchestration]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan implements all five recommendations from [.github/report.md](.github/report.md) covering: (1) centralized `VALIDATED` defaulting in orchestration; (2) propagating `responseSchemaRequested` from chat; (3) forwarding the resolved `functionCallingMode` through the shared executor; (4) clarifying the custom-function vs. server-side invocation prompt wording; (5) fixing the deep-research synthesis capability prompt to reflect actual active retrieval tools.

## 1. Requirements & Constraints

- **REQ-001**: `buildOrchestrationConfig()` MUST default `functionCallingMode` to `FunctionCallingConfigMode.VALIDATED` only when function declarations are present AND (a built-in tool is active OR `responseSchemaRequested === true`).
- **REQ-002**: Explicit caller-supplied `functionCallingMode` MUST take precedence over the new default in REQ-001.
- **REQ-003**: `OrchestrationRequest` and `CommonToolInputs` MUST expose an optional `responseSchemaRequested?: boolean | undefined` field.
- **REQ-004**: `buildChatOrchestrationRequest()` in [src/tools/chat.ts](src/tools/chat.ts) MUST pass `responseSchemaRequested: args.responseSchema !== undefined`.
- **REQ-005**: `appendFunctionCallingInstruction()` in chat MUST receive the resolved `functionCallingMode` (not the raw input mode) so prompt guidance reflects implicit `VALIDATED`.
- **REQ-006**: `ToolExecutor.runGeminiStream()` in [src/lib/tool-executor.ts](src/lib/tool-executor.ts) MUST forward `resolved.config.functionCallingMode` into `buildGenerateContentConfig`.
- **REQ-007**: `appendFunctionCallingInstruction()` in [src/lib/model-prompts.ts](src/lib/model-prompts.ts) MUST emit wording that distinguishes server-side built-in tool invocation traces from client-executed declared functions.
- **REQ-008**: Deep-research synthesis call in [src/tools/research.ts](src/tools/research.ts) MUST compute `multiTurnRetrieval` from synthesis-turn active capabilities (`googleSearch` || `urlContext` || `fileSearch`).
- **CON-001**: No public MCP tool input schema may change shape; `responseSchemaRequested` is internal only.
- **CON-002**: Session contract equality (`sameSessionContractValue`) MUST continue to compare `functionCallingMode` correctly, including the new implicit default.
- **GUD-001**: Follow `exactOptionalPropertyTypes` conditional-spread pattern when adding optional fields.
- **PAT-001**: Use the existing `pickDefined`/conditional-spread idiom already used in orchestration and chat.

## 2. Implementation Steps

### Implementation Phase 1: Orchestration core defaulting

- GOAL-001: Centralize `VALIDATED` defaulting in `buildOrchestrationConfig` and surface a `responseSchemaRequested` plumbing field.

| Task     | Description                                                                                                                                                                                                 | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Convert `import type { FunctionCallingConfigMode, ... }` to a runtime import for `FunctionCallingConfigMode` (plus type-only imports for the rest) in [src/lib/orchestration.ts](src/lib/orchestration.ts). | Yes       | 2026-04-26 |
| TASK-002 | Add `responseSchemaRequested?: boolean \| undefined` to both `OrchestrationRequest` and `CommonToolInputs` in [src/lib/orchestration.ts](src/lib/orchestration.ts).                                         | Yes       | 2026-04-26 |
| TASK-003 | In `buildOrchestrationRequestFromInputs`, conditionally spread `responseSchemaRequested` when defined.                                                                                                      | Yes       | 2026-04-26 |
| TASK-004 | Add private helper `resolveFunctionCallingMode(explicitMode, activeCapabilities, responseSchemaRequested)` returning `FunctionCallingConfigMode \| undefined` per REQ-001/REQ-002.                          | Yes       | 2026-04-26 |
| TASK-005 | Replace direct usage of `request.functionCallingMode` in `buildOrchestrationConfig` with the resolved value for both `toolProfileDetails.functionCallingMode` and `config.functionCallingMode`.             | Yes       | 2026-04-26 |

### Implementation Phase 2: Chat tool wiring

- GOAL-002: Pass `responseSchemaRequested` and use the resolved mode for prompt instruction generation.

| Task     | Description                                                                                                                                                                                                                            | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | In [src/tools/chat.ts](src/tools/chat.ts) `buildChatOrchestrationRequest`, add `responseSchemaRequested: args.responseSchema !== undefined` to the inputs passed into `buildOrchestrationRequestFromInputs`.                           | Yes       | 2026-04-26 |
| TASK-007 | In `buildAskGenerationOptions` ([src/tools/chat.ts](src/tools/chat.ts) ~L580), use the resolved `functionCallingMode` parameter (already passed in) when calling `appendFunctionCallingInstruction`, replacing `args.functions?.mode`. | Yes       | 2026-04-26 |
| TASK-008 | Verify `buildSessionGenerationContract` continues to receive the resolved mode (already wired via `resolved.config.functionCallingMode`) so session equality remains correct (CON-002).                                                | Yes       | 2026-04-26 |

### Implementation Phase 3: Executor mode forwarding

- GOAL-003: Forward `functionCallingMode` through the shared streaming pipeline.

| Task     | Description                                                                                                                                                                                   | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-009 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts) `runGeminiStream`, add `functionCallingMode: resolved.config.functionCallingMode` to the `buildGenerateContentConfig` options object. | Yes       | 2026-04-26 |

### Implementation Phase 4: Model-prompt wording

- GOAL-004: Disambiguate server-side built-in invocations from client-executed function declarations.

| Task     | Description                                                                                                                                                                                                                                                     | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-010 | In [src/lib/model-prompts.ts](src/lib/model-prompts.ts), widen `mode` typing in `FunctionCallingInstructionOptions` to accept `FunctionCallingConfigMode \| 'AUTO' \| 'ANY' \| 'NONE' \| 'VALIDATED'` and add the `FunctionCallingConfigMode` type-only import. | Yes       | 2026-04-26 |
| TASK-011 | Replace the `serverSideToolInvocations === true` branch text with: `Gemini may return server-side built-in tool invocation traces. Declared custom functions are still executed by the MCP client/application. Do not fabricate function results.`.             | Yes       | 2026-04-26 |

### Implementation Phase 5: Deep-research synthesis prompt

- GOAL-005: Make synthesis-turn `multiTurnRetrieval` flag reflect the synthesis turn's actual capability set.

| Task     | Description                                                                                                                                                                                                                                                                | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-012 | In [src/tools/research.ts](src/tools/research.ts) (~L668), compute `synthesisCanRetrieve = activeCapabilities.has('googleSearch') \|\| activeCapabilities.has('urlContext') \|\| activeCapabilities.has('fileSearch')` from `resolvedSynthesis.config.activeCapabilities`. | Yes       | 2026-04-26 |
| TASK-013 | Pass `synthesisCanRetrieve` (instead of `true`) as the second argument to `buildPromptCapabilities()` for the synthesis prompt.                                                                                                                                            | Yes       | 2026-04-26 |

### Implementation Phase 6: Tests

- GOAL-006: Add coverage for new defaulting and forwarding behavior.

| Task     | Description                                                                                                                                                                                                                                                                       | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-014 | In [\_\_tests\_\_/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts), add cases asserting `functionCallingMode === VALIDATED` for: functions+googleSearch, functions+urlContext, functions+codeExecution, functions+fileSearch, functions+`responseSchemaRequested`. | Yes       | 2026-04-26 |
| TASK-015 | Add cases asserting explicit modes (`AUTO`, `ANY`, `NONE`, `VALIDATED`) override the default.                                                                                                                                                                                     | Yes       | 2026-04-26 |
| TASK-016 | Add a case asserting NO default mode is set when only function declarations are present (no built-ins, no `responseSchemaRequested`).                                                                                                                                             | Yes       | 2026-04-26 |
| TASK-017 | Add a case verifying `serverSideToolInvocations` auto-policy is unchanged by the new defaulting.                                                                                                                                                                                  | Yes       | 2026-04-26 |
| TASK-018 | Add a `tool-executor` test (or extend [\_\_tests\_\_/lib/tool-executor.test.ts](__tests__/lib/tool-executor.test.ts)) asserting `runGeminiStream` propagates `functionCallingMode` into the config passed to `generateContentStream`.                                             | Yes       | 2026-04-26 |
| TASK-019 | Extend research tests (or add a small unit test) asserting deep-research synthesis prompt does NOT advertise `multiTurnRetrieval` when synthesis turn has only `codeExecution`/`fileSearch` without grounded retrieval.                                                           | Yes       | 2026-04-26 |
| TASK-020 | Extend [\_\_tests\_\_/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) with a case asserting the new server-side invocation wording is emitted when `serverSideToolInvocations === true`.                                                                          | Yes       | 2026-04-26 |

### Implementation Phase 7: Verification

- GOAL-007: Validate the change with the standard quality gates.

| Task     | Description                                                                      | Completed | Date       |
| -------- | -------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-021 | Run `npm run format`.                                                            | Yes       | 2026-04-26 |
| TASK-022 | Run `npm run lint` and resolve any new findings.                                 | Yes       | 2026-04-26 |
| TASK-023 | Run `npm run type-check`.                                                        | Yes       | 2026-04-26 |
| TASK-024 | Run `npm run test` and confirm all suites pass, including new and updated cases. | Yes       | 2026-04-26 |

## 3. Alternatives

- **ALT-001**: Default `VALIDATED` at the call site in each tool rather than centrally in orchestration. Rejected: duplicates logic and risks drift between tools.
- **ALT-002**: Always force `VALIDATED` whenever functions are declared. Rejected: contradicts Gemini docs which scope the recommendation to functions-with-built-ins or functions-with-structured-output, and breaks pure function-only `AUTO` use cases.
- **ALT-003**: Skip recommendation #1 entirely and apply only #3/#4/#5 (the previously identified high-confidence fixes). Rejected here because the user requested implementing all recommendations; this remains a fallback if review surfaces concerns.
- **ALT-004**: Inject `responseSchemaRequested` as a string flag on `toolProfileDetails`. Rejected: not needed for runtime behavior, only adds telemetry noise.

## 4. Dependencies

- **DEP-001**: `@google/genai` `FunctionCallingConfigMode` runtime enum (already used elsewhere in the repo).
- **DEP-002**: Existing `resolveServerSideToolInvocations` semantics in [src/lib/orchestration.ts](src/lib/orchestration.ts) (unchanged).
- **DEP-003**: Existing session contract equality in [src/tools/chat.ts](src/tools/chat.ts) (`sameSessionContractValue`) — must continue to handle the now-implicit mode value.

## 5. Files

- **FILE-001**: [src/lib/orchestration.ts](src/lib/orchestration.ts) — add `responseSchemaRequested`, runtime import, `resolveFunctionCallingMode`, and rewire `buildOrchestrationConfig`.
- **FILE-002**: [src/tools/chat.ts](src/tools/chat.ts) — pass `responseSchemaRequested`, use resolved mode in prompt suffix.
- **FILE-003**: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — forward `functionCallingMode` in `runGeminiStream`.
- **FILE-004**: [src/lib/model-prompts.ts](src/lib/model-prompts.ts) — clarify server-side vs. client-side invocation wording, widen `mode` type.
- **FILE-005**: [src/tools/research.ts](src/tools/research.ts) — derive synthesis `multiTurnRetrieval` from real capabilities.
- **FILE-006**: [\_\_tests\_\_/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts) — new `VALIDATED` defaulting cases.
- **FILE-007**: [\_\_tests\_\_/lib/tool-executor.test.ts](__tests__/lib/tool-executor.test.ts) — new mode-forwarding case.
- **FILE-008**: [\_\_tests\_\_/lib/model-prompts.test.ts](__tests__/lib/model-prompts.test.ts) — new server-side wording case.
- **FILE-009**: [\_\_tests\_\_/tools/research.test.ts](__tests__/tools/research.test.ts) — synthesis capability assertion (or new colocated unit test if scope differs).

## 6. Testing

- **TEST-001**: `buildOrchestrationConfig` defaults `functionCallingMode` to `VALIDATED` for each `{functions + builtIn}` permutation and for `{functions + responseSchemaRequested}`.
- **TEST-002**: Explicit `functionCallingMode` (each of `AUTO`/`ANY`/`NONE`/`VALIDATED`) overrides the new default.
- **TEST-003**: No mode is emitted when only `functionDeclarations` are present and no built-ins and no `responseSchemaRequested`.
- **TEST-004**: `serverSideToolInvocations: 'auto'` continues to enable server-side invocation only when both built-ins and functions are active.
- **TEST-005**: `ToolExecutor.runGeminiStream` forwards `functionCallingMode` into `buildGenerateContentConfig` (verified via spy on `generateContentStream`).
- **TEST-006**: Deep-research synthesis prompt does not claim `multiTurnRetrieval` when synthesis turn lacks `googleSearch`/`urlContext`/`fileSearch`.
- **TEST-007**: `appendFunctionCallingInstruction` emits the new server-side wording when `serverSideToolInvocations === true`.

## 7. Risks & Assumptions

- **RISK-001**: Defaulting to `VALIDATED` may change observable behavior for callers that previously relied on the SDK's implicit `AUTO` for `functions + built-ins`. Mitigated by REQ-002 (explicit modes always win) and by limiting the default to documented Gemini-recommended permutations.
- **RISK-002**: Session contract equality may diverge when an old persisted session stored an undefined mode that now resolves to `VALIDATED`. Mitigation: `sameSessionContractValue` already treats undefined as a wildcard via `pickDefined` semantics; verify with TASK-008/TEST-002.
- **RISK-003**: Widening the `mode` type in `model-prompts.ts` could cascade type churn. Mitigation: keep the union backwards-compatible (string literals retained).
- **ASSUMPTION-001**: All current callers of `runGeminiStream` either declare no functions or do not depend on a specific `functionCallingMode`; the forwarding fix is therefore latent and safe.
- **ASSUMPTION-002**: `buildPromptCapabilities` accepts `multiTurnRetrieval` as a derived flag and does not require additional parameters to honor a `false` value.
- **ASSUMPTION-003**: `FunctionCallingConfigMode.VALIDATED` is supported by the installed `@google/genai` version (already referenced in [src/tools/chat.ts](src/tools/chat.ts)).

## 8. Related Specifications / Further Reading

- [.github/report.md](.github/report.md) — source recommendations and rationale
- [src/lib/orchestration.ts](src/lib/orchestration.ts)
- [src/tools/chat.ts](src/tools/chat.ts)
- [src/lib/tool-executor.ts](src/lib/tool-executor.ts)
- [src/lib/model-prompts.ts](src/lib/model-prompts.ts)
- [src/tools/research.ts](src/tools/research.ts)
- Google GenAI Function Calling docs: `FunctionCallingConfigMode.VALIDATED` semantics
