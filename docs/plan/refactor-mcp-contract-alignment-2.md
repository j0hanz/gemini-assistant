---
goal: Align MCP public contract with Gemini runtime capabilities and documentation
version: 1.0
date_created: 2026-04-25
last_updated: 2026-04-25
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['refactor', 'mcp', 'contract', 'gemini', 'documentation', 'testing']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

This plan addresses the highest-value verified findings from the current codebase review and `.github/report.md`. The server architecture is already strong: it uses MCP SDK v2 split packages, `McpServer`, Zod v4 Standard Schema contracts, task-aware tools, streamable transports, Gemini 3 model configuration, built-in Gemini tools, structured output validation, and replay-safe session resources. The remaining valuable work is contract alignment: make public `chat` expose the grounding capabilities already implemented internally, fix `thinkingBudget` semantics so the knob actually works, and update documentation/tests so MCP clients receive accurate guidance.

## 1. Requirements & Constraints

- **REQ-001**: Public `chat` MUST expose `googleSearch?: boolean` and `urls?: string[]` because `src/tools/chat.ts` already supports `args.googleSearch`, URL Context, URL validation, and `toolProfile` session events through `AskArgs`.
- **REQ-002**: `chatWork()` MUST forward `ChatInput.googleSearch` and `ChatInput.urls` into `askWork()` so public MCP callers can use Gemini Google Search and URL Context in direct chat sessions.
- **REQ-003**: Public `thinkingBudget` MUST be effective when supplied without an explicit `thinkingLevel`. Current schema defaulting of `thinkingLevel` to `LOW` prevents `buildGenerateContentConfig()` from sending `thinkingBudget`.
- **REQ-004**: Public `thinkingLevel` documentation MUST state that omitting the field uses the job-specific cost profile in `DEFAULT_TOOL_COST_PROFILES`, not a schema-level Zod default.
- **REQ-005**: README capability notes MUST match current schemas and runtime behavior: `research.mode` defaults to `quick`, `analyze.outputKind` defaults to `summary`, `thinkingBudget` only applies when `thinkingLevel` is omitted, research does not return a `grounded` boolean, and `searchEntryPoint` is not part of `ResearchOutputSchema`.
- **REQ-006**: README replay defaults MUST match `src/config.ts`: `SESSION_REPLAY_MAX_BYTES` default `50000`; `SESSION_REPLAY_INLINE_DATA_MAX_BYTES` default `16384`.
- **REQ-007**: `.github/report.md` claims that are already fixed or stale MUST NOT be reimplemented. Verified stale items: `VALIDATED` is already mapped in `toFunctionCallingConfigMode()`, rich research/analyze/review output fields already exist in `src/schemas/outputs.ts`, token auth and rate limiting are already wired in `src/transport.ts`, and README no longer advertises `memory` or `discover` as tools.
- **SEC-001**: URL validation MUST keep rejecting non-public URLs through existing `validateUrls()` and `PublicHttpUrlSchema` behavior. Adding `chat.urls` MUST NOT permit localhost, private-network, non-http, or malformed URLs.
- **SEC-002**: HTTP transport security behavior MUST remain unchanged. `MCP_HTTP_TOKEN`, rate limiting, CORS, host validation, and non-loopback bind checks are already enforced and covered by tests.
- **CON-001**: Public tool names MUST remain exactly `chat`, `research`, `analyze`, `review` in `src/public-contract.ts`.
- **CON-002**: Do not add legacy environment variable aliases in this plan. Current README intentionally documents that old names such as `GEMINI_MODEL`, `MCP_TRANSPORT`, and `ALLOWED_FILE_ROOTS` are unsupported.
- **CON-003**: Do not add new runtime or development dependencies.
- **PAT-001**: Follow existing schema helper patterns in `src/schemas/fields.ts`, `src/schemas/fragments.ts`, and `src/schemas/inputs.ts`; use `createUrlContextFields()` for public URL arrays.
- **PAT-002**: Preserve `buildGenerateContentConfig()` semantics: `thinkingLevel` takes precedence over `thinkingBudget`, and cost profiles supply default thinking levels for tool executions when callers omit both.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Make public chat grounding match internal chat orchestration.

| Task     | Description                                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-001 | In `src/schemas/inputs.ts`, import and use `createUrlContextFields()` inside `createChatInputSchema()` to add optional `urls` with `min: 1`, `max: 20`, description `Public URLs to analyze with URL Context during chat.`, and item description `Public URL to analyze with URL Context during chat`. | Yes       | 2026-04-25 |
| TASK-002 | In `src/schemas/inputs.ts`, add a `googleSearch` optional boolean field to `createChatInputSchema()` next to `codeExecution` and `fileSearch`. Use the description: Enable Google Search grounding for chat. Optional; additive. Combine with urls for URL Context.                                    | Yes       | 2026-04-25 |
| TASK-003 | In `src/tools/chat.ts`, update `chatWork()` to pass `googleSearch: args.googleSearch` and `urls: args.urls` into the `askWork()` argument object.                                                                                                                                                      | Yes       | 2026-04-25 |
| TASK-004 | In `src/public-contract.ts`, add `googleSearch?` and `urls?` to the `DISCOVERY_ENTRIES` input list for the `chat` tool, and update the `chat.bestFor` or `chat.returns` text to mention optional Search/URL grounding only when requested.                                                             | Yes       | 2026-04-25 |
| TASK-005 | In `README.md`, keep the tool capability matrix row for `chat` showing Search and URL Context support, but update the prose to state that public `chat.googleSearch` and `chat.urls` enable those capabilities.                                                                                        | Yes       | 2026-04-25 |

### Implementation Phase 2

- GOAL-002: Make `thinkingBudget` operational and accurately documented.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                              | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-006 | In `src/schemas/fields.ts`, remove `.default(DEFAULT_THINKING_LEVEL)` from `thinkingLevel()` and remove the now-unused `DEFAULT_THINKING_LEVEL` import if no other code path uses it. The schema must remain `z.enum(THINKING_LEVELS).optional()` with the description `Reasoning depth: MINIMAL, LOW, MEDIUM, HIGH. Omit to use the job-specific default cost profile.` | Yes       | 2026-04-25 |
| TASK-007 | In `src/client.ts`, keep `DEFAULT_THINKING_LEVEL` only if another module still needs it; otherwise delete the export. Do not change `DEFAULT_TOOL_COST_PROFILES`.                                                                                                                                                                                                        | Yes       | 2026-04-25 |
| TASK-008 | In `src/client.ts`, keep `buildThinkingConfig()` precedence unchanged: include `thinkingLevel` when present; include `thinkingBudget` only when `thinkingLevel === undefined`; keep budget clamping with `GEMINI_THINKING_BUDGET_CAP`.                                                                                                                                   | Yes       | 2026-04-25 |
| TASK-009 | In `src/schemas/fields.ts`, keep the `thinkingBudget()` description as: Override thinking token budget. Applied only when thinkingLevel is omitted; thinkingLevel takes precedence when both are set.                                                                                                                                                                    | Yes       | 2026-04-25 |
| TASK-010 | In `src/public-contract.ts` and `README.md`, replace wording that implies a fixed public default `LOW` with wording that omission uses each tool's cost profile. Mention that common profiles currently use `LOW`, while diagram/deep synthesis may use `MEDIUM`.                                                                                                        | Yes       | 2026-04-25 |

### Implementation Phase 3

- GOAL-003: Correct documentation drift from the verified reviews and prevent stale report fixes from being reintroduced.

| Task     | Description                                                                                                                                                                                                                                                                                                         | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-011 | In `README.md`, update `Capability Notes`: change `research.mode is required` to `research.mode defaults to quick`; change `outputKind is required` to `analyze.outputKind defaults to summary`.                                                                                                                    | Yes       | 2026-04-25 |
| TASK-012 | In `README.md`, replace the research grounding bullets with the actual output contract: `status`, `groundingSignals`, `sourceDetails`, `urlContextSources`, `urlMetadata`, `findings`, `citations`, and optional `computations`. Remove the claim that `grounded` is returned.                                      | Yes       | 2026-04-25 |
| TASK-013 | In `README.md`, remove the claim that Google Search Suggestions are returned in `structuredContent.searchEntryPoint`. Keep wording that suggestions may be appended to `content[]` when Gemini provides `groundingMetadata.searchEntryPoint.renderedContent`.                                                       | Yes       | 2026-04-25 |
| TASK-014 | In `README.md`, update replay default values to `SESSION_REPLAY_MAX_BYTES` default `50000` and `SESSION_REPLAY_INLINE_DATA_MAX_BYTES` default `16384`.                                                                                                                                                              | Yes       | 2026-04-25 |
| TASK-015 | In `.github/report.md` or a new short note under `.github/`, add an implementation-triage note listing report items not selected because current code already satisfies them: `VALIDATED` mapping, output schema richness, transport token/rate limit enforcement, and absence of public `memory`/`discover` tools. | Yes       | 2026-04-25 |

### Implementation Phase 4

- GOAL-004: Add regression tests for the corrected MCP contract.

| Task     | Description                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-016 | In `__tests__/schemas/inputs.test.ts`, add a `ChatInputSchema` positive test that accepts `{ goal: 'x', googleSearch: true, urls: ['https://example.com/docs'] }`.                                                                                                           | Yes       | 2026-04-25 |
| TASK-017 | In `__tests__/schemas/inputs.test.ts`, add `ChatInputSchema` negative tests that reject `urls: []`, `urls: ['not-a-url']`, `urls: ['http://localhost:3000']`, and 21 public URLs.                                                                                            | Yes       | 2026-04-25 |
| TASK-018 | In `__tests__/tools/ask.test.ts`, add a test for `chatWork()` or `createAskWork()` proving public `googleSearch` and `urls` reach `buildChatOrchestrationRequest()` and produce Gemini tools `[{ googleSearch: {} }, { urlContext: {} }]` in the generated config.           | Yes       | 2026-04-25 |
| TASK-019 | In `__tests__/schemas/inputs.test.ts`, update shared thinking tests so omitting `thinkingLevel` leaves `result.data.thinkingLevel === undefined` and supplying `thinkingBudget` remains accepted.                                                                            | Yes       | 2026-04-25 |
| TASK-020 | In `__tests__/client.test.ts`, keep existing tests that prove `thinkingBudget` is sent only when `thinkingLevel` is absent and add a public-schema regression test that exercises that path through parsed tool input.                                                       | Yes       | 2026-04-25 |
| TASK-021 | In `__tests__/mcp-tools.e2e.test.ts`, update schema assertions so public tools advertise `thinkingLevel` without a `default` property and with the new description.                                                                                                          | Yes       | 2026-04-25 |
| TASK-022 | In `__tests__/documentation.test.ts`, add README assertions for the corrected defaults: `research.mode defaults to quick`, `analyze.outputKind defaults to summary`, `SESSION_REPLAY_MAX_BYTES` default `50000`, and `SESSION_REPLAY_INLINE_DATA_MAX_BYTES` default `16384`. | Yes       | 2026-04-25 |
| TASK-023 | In `__tests__/contract-surface.test.ts` or `__tests__/catalog.test.ts`, assert that `DISCOVERY_ENTRIES` for `chat` includes `googleSearch?` and `urls?`, and that public tool names remain exactly `chat`, `research`, `analyze`, `review`.                                  | Yes       | 2026-04-25 |
| TASK-024 | Run `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test`. All commands must pass before the plan is marked completed.                                                                                                                                  | Yes       | 2026-04-25 |

## 3. Alternatives

- **ALT-001**: Document that `chat` does not support public Search/URL Context instead of adding fields. Rejected because internal `AskArgs`, orchestration, URL validation, session event recording, and README intent already support these capabilities; exposing them increases value for local LLM chat sessions with minimal implementation risk.
- **ALT-002**: Keep schema-level `thinkingLevel.default('LOW')` and make `thinkingBudget` override it. Rejected because Zod parsing loses whether `LOW` was explicit or injected as a default; removing the schema default preserves caller intent and lets existing cost profiles supply runtime defaults.
- **ALT-003**: Add aliases for old environment variables such as `GEMINI_MODEL`, `MCP_TRANSPORT`, and `ALLOWED_FILE_ROOTS`. Rejected for this plan because current README explicitly says old names are unsupported and tests already verify old names are ignored; adding aliases would expand the compatibility surface without solving a current runtime bug.
- **ALT-004**: Reimplement `.github/report.md` recommendations for `VALIDATED`, rich output schemas, and transport auth/rate limiting. Rejected because current code already implements those items in `src/tools/chat.ts`, `src/schemas/outputs.ts`, and `src/transport.ts`.
- **ALT-005**: Add a durable session/task store. Rejected as out of scope. The current contract intentionally documents process-local sessions/tasks/caches; durable persistence is a separate architecture plan.

## 4. Dependencies

- **DEP-001**: `@google/genai` `^1.50.1`, already installed. No version change required.
- **DEP-002**: `@modelcontextprotocol/server` `2.0.0-alpha.2`, already installed. No version change required.
- **DEP-003**: `zod` `^4`, already installed. Use existing helper functions only.
- **DEP-004**: Existing test runner command `npm run test` using Node test runner and `tsx/esm`.

## 5. Files

- **FILE-001**: `src/schemas/inputs.ts` — add public chat `googleSearch` and `urls` fields.
- **FILE-002**: `src/schemas/fields.ts` — remove schema-level default from `thinkingLevel()` and update description.
- **FILE-003**: `src/client.ts` — remove unused `DEFAULT_THINKING_LEVEL` export only if TypeScript reports it unused after FILE-002.
- **FILE-004**: `src/tools/chat.ts` — forward `googleSearch` and `urls` from `ChatInput` to `AskArgs`.
- **FILE-005**: `src/public-contract.ts` — update discovery metadata for `chat` and thinking semantics.
- **FILE-006**: `README.md` — update capability, grounding, thinking, and replay-default documentation.
- **FILE-007**: `.github/report.md` or `.github/report-triage.md` — record verified stale report items so they are not reintroduced.
- **FILE-008**: `__tests__/schemas/inputs.test.ts` — schema coverage for chat grounding and thinking default removal.
- **FILE-009**: `__tests__/tools/ask.test.ts` — runtime forwarding coverage for public chat grounding.
- **FILE-010**: `__tests__/client.test.ts` — keep/extend thinking budget precedence coverage.
- **FILE-011**: `__tests__/mcp-tools.e2e.test.ts` — advertised MCP schema coverage for thinking metadata.
- **FILE-012**: `__tests__/documentation.test.ts` — README contract coverage.
- **FILE-013**: `__tests__/contract-surface.test.ts` or `__tests__/catalog.test.ts` — discovery catalog coverage.

## 6. Testing

- **TEST-001**: `ChatInputSchema.safeParse({ goal: 'x', googleSearch: true, urls: ['https://example.com/docs'] })` succeeds.
- **TEST-002**: `ChatInputSchema` rejects empty, malformed, private, and over-limit `urls` arrays.
- **TEST-003**: A public `chat` call with `googleSearch: true` and `urls: ['https://example.com/docs']` sends Gemini tools containing both `{ googleSearch: {} }` and `{ urlContext: {} }`.
- **TEST-004**: Public schema parsing leaves `thinkingLevel` undefined when omitted and `thinkingBudget` is present.
- **TEST-005**: `buildGenerateContentConfig({ thinkingBudget: 64 })` emits `thinkingConfig.thinkingBudget === 64` and no `thinkingLevel`; `buildGenerateContentConfig({ thinkingLevel: 'LOW', thinkingBudget: 64 })` emits `thinkingLevel` and no `thinkingBudget`.
- **TEST-006**: MCP `tools/list` schema for each public tool has no `thinkingLevel.default` and has the exact new thinking-level description.
- **TEST-007**: README tests assert corrected defaults and replay byte values.
- **TEST-008**: Existing transport tests continue proving `MCP_HTTP_TOKEN`, non-loopback bind protection, host validation, and rate limiting are enforced.
- **TEST-009**: Full validation commands pass: `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`.

## 7. Risks & Assumptions

- **RISK-001**: Removing the schema-level `thinkingLevel` default changes `tools/list` JSON Schema metadata and may affect clients that expected to see `default: LOW`. Mitigation: runtime cost profiles still supply default thinking levels; update discovery docs and e2e tests to make this explicit.
- **RISK-002**: Adding `chat.urls` enables URL Context during sessions, increasing prompt/tool cost when callers use it. Mitigation: the field is opt-in, limited to 20 public URLs, and validated through existing URL helpers.
- **RISK-003**: Public `chat.googleSearch` may produce grounding metadata that current `ChatOutputSchema` only exposes through shared fields such as `citationMetadata`, `toolEvents`, and `usage`, not research-specific source details. Mitigation: keep detailed source UX in `research`; document `chat` grounding as direct conversation support, not a research report substitute.
- **RISK-004**: Updating `.github/report.md` directly could alter an external review artifact. Mitigation: prefer creating `.github/report-triage.md` if preserving the original report verbatim is desired.
- **ASSUMPTION-001**: The local LLM benefits from being able to keep one `chat` session while selectively enabling Search/URL Context, especially for function-calling and workspace-cache conversations.
- **ASSUMPTION-002**: Existing old-environment-name tests reflect an intentional compatibility decision, so this plan does not add aliases.
- **ASSUMPTION-003**: The current rich output schemas in `src/schemas/outputs.ts` are correct and should not be replaced by the stale simplified patch in `.github/report.md`.

## 8. Related Specifications / Further Reading

- [docs/plan/refactor-public-contract-integrity-1.md](docs/plan/refactor-public-contract-integrity-1.md)
- [docs/plan/refactor-gemini-tool-orchestration-1.md](docs/plan/refactor-gemini-tool-orchestration-1.md)
- [docs/plan/architecture-orchestration-extensibility-1.md](docs/plan/architecture-orchestration-extensibility-1.md)
- [.github/report.md](.github/report.md)
- [.github/google-genai-api.md](.github/google-genai-api.md)
- [.github/mcp-v2-api.md](.github/mcp-v2-api.md)
- [src/client.ts](src/client.ts)
- [src/tools/chat.ts](src/tools/chat.ts)
- [src/schemas/inputs.ts](src/schemas/inputs.ts)
- [src/schemas/outputs.ts](src/schemas/outputs.ts)
