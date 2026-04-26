---
goal: P0 MCP and Gemini Risk Hardening
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, security, mcp, gemini, streaming, sessions]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan defines the P0 implementation work required to harden the MCP server against the highest-priority risks identified in the architecture review: cached Gemini calls dropping per-tool system instructions, task cancellation not consistently stopping stream consumption, and session resources exposing sensitive replay artifacts without an explicit exposure gate.

## 1. Requirements & Constraints

- **REQ-001**: Preserve the existing public tool names `chat`, `research`, `analyze`, and `review`.
- **REQ-002**: Preserve existing MCP SDK v2 package usage from `package.json`: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/express` version `2.0.0-alpha.2`.
- **REQ-003**: Preserve existing Gemini SDK package usage from `package.json`: `@google/genai` version `^1.50.1`.
- **REQ-004**: Preserve successful `content` and `structuredContent` result shapes for all public tools unless a P0 security requirement requires denial.
- **REQ-005**: Keep task behavior compatible with the current stateful/stateless split in `src/server.ts:createServerInstance` and `src/lib/task-utils.ts:registerWorkTool`.
- **SEC-001**: Do not serve `session://{sessionId}/transcript`, `session://{sessionId}/events`, or `gemini://sessions/{sessionId}/turns/{turnIndex}/parts` unless session resource exposure is explicitly enabled by server configuration.
- **SEC-002**: Do not expose Gemini `thought`, `thoughtSignature`, function arguments, tool arguments, tool responses, or executable code through session resources unless the same explicit exposure gate is enabled.
- **SEC-003**: Preserve replay correctness for in-memory chat sessions when session resources are disabled.
- **GEM-001**: Gemini calls that use `cachedContent` must still preserve active tool-specific behavioral, grounding, format, and safety instructions.
- **GEM-002**: Cached workspace context must remain context-only. It must not become the only carrier of per-turn behavior instructions.
- **MCP-001**: Task cancellation must stop active Gemini stream consumption for task-aware tool calls.
- **MCP-002**: Plain non-task tool calls must continue to abort on `ctx.mcpReq.signal`.
- **CON-001**: Do not add third-party dependencies.
- **CON-002**: Do not implement durable external session or task storage in this P0 plan.
- **CON-003**: Do not add backward-compatibility layers for disabled session resources; return explicit MCP resource errors instead.
- **PAT-001**: Use existing helpers in `src/lib/response.ts`, `src/lib/errors.ts`, `src/lib/progress.ts`, and `src/config.ts` where possible.
- **PAT-002**: Add tests under `__tests__/` using the existing Node test runner and `tsx/esm`.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Preserve per-tool Gemini instructions when workspace cache is applied.

| Task     | Description                                                                                                                                                                                                                                                                                               | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Update `src/client.ts:buildResponseConfig` so `systemInstruction` is included even when `cacheName` is set. Keep `cachedContent: cacheName` unchanged. Remove the branch that omits `systemInstruction` for cached calls at `src/client.ts:155-156`.                                                      | ✅        | 2026-04-26 |
| TASK-002 | Update `src/lib/model-prompts.ts:resolveTextPrompt` and `src/lib/model-prompts.ts:resolvePartPrompt` so `cacheText` is only prepended to user contents when it contains task-specific reusable instructions that must be in contents. Do not use `cacheName` as a reason to suppress `systemInstruction`. | ✅        | 2026-04-26 |
| TASK-003 | Update `src/tools/chat.ts:buildConfigFromSessionContract` so rebuilt session configs preserve `contract.systemInstruction` when an active `cacheName` is supplied. Keep `cachedContent` and contract tool fields unchanged.                                                                               | ✅        | 2026-04-26 |
| TASK-004 | Add unit tests in `__tests__/client.test.ts` or the existing closest client/config test file verifying `buildGenerateContentConfig({ cacheName: 'cachedContents/abc', systemInstruction: 'S' })` returns both `cachedContent` and `systemInstruction`.                                                    | ✅        | 2026-04-26 |
| TASK-005 | Add a session rebuild test in the existing chat/session test file verifying a stored `SessionGenerationContract.systemInstruction` survives rebuild when the cache name is still active.                                                                                                                  | ✅        | 2026-04-26 |

### Implementation Phase 2

- GOAL-002: Make task cancellation stop Gemini stream consumption.

| Task     | Description                                                                                                                                                                                                                                                                                                                   | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | Export and use a single work-signal helper from `src/lib/task-utils.ts:getWorkSignal`. Remove the local duplicate `workSignal` from `src/lib/tool-executor.ts` and update imports to avoid an import cycle. If an import cycle appears, move `getWorkSignal` to a new `src/lib/work-signal.ts` and import it from both files. | ✅        | 2026-04-26 |
| TASK-007 | Change `src/lib/streaming.ts:executeToolStream` to accept an optional `AbortSignal` parameter named `signal`. Use `signal ?? ctx.mcpReq.signal` for `withRetry`.                                                                                                                                                              | ✅        | 2026-04-26 |
| TASK-008 | Change `src/lib/streaming.ts:consumeStreamWithProgress` to accept an optional `AbortSignal` parameter named `signal`. Inside the stream loop, check `signal.aborted` instead of only `ctx.mcpReq.signal.aborted`. Set `state.aborted = true` and break when aborted.                                                          | ✅        | 2026-04-26 |
| TASK-009 | Update `src/lib/tool-executor.ts:runStream` to call `executeToolStream(ctx, toolName, toolLabel, streamGenerator, getWorkSignal(ctx))`.                                                                                                                                                                                       | ✅        | 2026-04-26 |
| TASK-010 | Update direct callers of `executeToolStream`, including `src/tools/research.ts:runDeepResearchTurn`, to pass `getWorkSignal(ctx)`.                                                                                                                                                                                            | ✅        | 2026-04-26 |
| TASK-011 | Add tests in the existing streaming/task test file or a new `__tests__/streaming-cancellation.test.ts` that create a fake async generator, abort a task cancellation signal, and assert `validateStreamResult` returns an error result with cancelled semantics.                                                              | ✅        | 2026-04-26 |

### Implementation Phase 3

- GOAL-003: Gate sensitive session resources behind explicit configuration.

| Task     | Description                                                                                                                                                                                                                                                                                                                                       | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-012 | Add a config accessor in `src/config.ts` named `getExposeSessionResources(): boolean`. It must read environment variable `MCP_EXPOSE_SESSION_RESOURCES`. It must return `true` only when the value is exactly `true` or `1`; otherwise return `false`.                                                                                            | ✅        | 2026-04-26 |
| TASK-013 | Update `src/resources.ts` to import `getExposeSessionResources`. Before serving data from `getSessionTranscriptResourceData`, `getSessionEventsResourceData`, and `getSessionTurnPartsResourceData`, throw `new ProtocolError(ProtocolErrorCode.ResourceNotFound, 'Session resources are disabled')` when `getExposeSessionResources()` is false. | ✅        | 2026-04-26 |
| TASK-014 | Update `src/resources.ts:registerSessionResources` so dynamic `list` callbacks for transcript, events, and turn-parts return `{ resources: [] }` when `getExposeSessionResources()` is false. Keep `session://` and `session://{sessionId}` metadata resources available.                                                                         | ✅        | 2026-04-26 |
| TASK-015 | Update `src/tools/chat.ts:sessionResources` and `src/tools/chat.ts:appendSessionResource` so result content and structured session links include `transcript`, `events`, and `turnParts` only when `getExposeSessionResources()` is true. Always keep the session detail link when a session exists.                                              | ✅        | 2026-04-26 |
| TASK-016 | Update `src/public-contract.ts` discovery limitations for chat and session resources to state that transcript, events, and turn-parts resources require `MCP_EXPOSE_SESSION_RESOURCES=true`.                                                                                                                                                      | ✅        | 2026-04-26 |
| TASK-017 | Add tests in the existing resources/session test file or a new `__tests__/session-resources-security.test.ts` verifying disabled-by-default behavior: transcript/events/turn-parts read calls throw `ResourceNotFound`, dynamic lists are empty, and chat structured session metadata omits sensitive resource links.                             | ✅        | 2026-04-26 |
| TASK-018 | Add tests verifying enabled behavior with `MCP_EXPOSE_SESSION_RESOURCES=true`: transcript/events/turn-parts read calls return the current data and chat structured session metadata includes sensitive resource links.                                                                                                                            | ✅        | 2026-04-26 |

## 3. Alternatives

- **ALT-001**: Remove workspace caching entirely. Rejected because the P0 bug is instruction loss under cache, not cache existence.
- **ALT-002**: Keep session resources enabled and redact fields. Rejected because raw replay resources intentionally preserve `thoughtSignature`; partial redaction would break their purpose and still expose sensitive metadata.
- **ALT-003**: Add per-session authorization tokens. Rejected for P0 because the current MCP resource API has no existing per-session auth model in this codebase, and an explicit disabled-by-default gate is a clean replacement design.
- **ALT-004**: Depend only on request abort and ignore task cancellation. Rejected because stateful task cancellation is a public MCP behavior and must stop paid upstream Gemini work.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` task context cancellation signal remains available through `ctx.task.cancellationSignal` as currently used in `src/lib/task-utils.ts`.
- **DEP-002**: `@google/genai` continues accepting `abortSignal` in `GenerateContentConfig`, as currently passed by `src/client.ts:buildGenerateContentConfig`.
- **DEP-003**: Existing config module `src/config.ts` supports adding a boolean environment accessor without changing deployment manifests.
- **DEP-004**: Existing test runner command is `npm run test`.

## 5. Files

- **FILE-001**: `src/client.ts` - preserve `systemInstruction` when `cachedContent` is set.
- **FILE-002**: `src/lib/model-prompts.ts` - stop using cache presence to suppress system instructions.
- **FILE-003**: `src/tools/chat.ts` - preserve session rebuild instructions and gate sensitive session resource links.
- **FILE-004**: `src/lib/tool-executor.ts` - pass task-aware work signal to streaming.
- **FILE-005**: `src/lib/streaming.ts` - consume streams with the provided abort signal.
- **FILE-006**: `src/lib/task-utils.ts` or `src/lib/work-signal.ts` - provide one shared work-signal helper.
- **FILE-007**: `src/tools/research.ts` - pass task-aware work signal to direct deep-research stream execution.
- **FILE-008**: `src/config.ts` - add `getExposeSessionResources`.
- **FILE-009**: `src/resources.ts` - deny and delist sensitive session resources by default.
- **FILE-010**: `src/public-contract.ts` - document the explicit session-resource exposure requirement.
- **FILE-011**: `__tests__/client.test.ts` or existing equivalent - test cache plus system-instruction behavior.
- **FILE-012**: `__tests__/streaming-cancellation.test.ts` or existing equivalent - test task cancellation stream handling.
- **FILE-013**: `__tests__/session-resources-security.test.ts` or existing equivalent - test session resource exposure gate.

## 6. Testing

- **TEST-001**: Run `npm run format`.
- **TEST-002**: Run `npm run lint`.
- **TEST-003**: Run `npm run type-check`.
- **TEST-004**: Run `npm run test`.
- **TEST-005**: Verify `buildGenerateContentConfig` returns both `cachedContent` and `systemInstruction` when both inputs are provided.
- **TEST-006**: Verify task cancellation aborts stream consumption when only `ctx.task.cancellationSignal` is aborted.
- **TEST-007**: Verify session transcript/events/turn-parts resources are disabled by default.
- **TEST-008**: Verify session transcript/events/turn-parts resources are available only when `MCP_EXPOSE_SESSION_RESOURCES=true`.
- **TEST-009**: Verify chat result session metadata does not advertise disabled sensitive resource links.

## 7. Risks & Assumptions

- **RISK-001**: Preserving `systemInstruction` with `cachedContent` may slightly increase prompt tokens compared with current cached calls.
- **RISK-002**: Moving `getWorkSignal` may reveal an import cycle in existing task and executor modules.
- **RISK-003**: Disabling session resources by default may break clients that currently inspect transcripts, events, or raw Gemini parts without prior configuration.
- **RISK-004**: Tests that mutate environment variables must restore previous values to avoid cross-test contamination.
- **ASSUMPTION-001**: Existing in-memory chat session replay does not require MCP resource exposure to function.
- **ASSUMPTION-002**: `MCP_EXPOSE_SESSION_RESOURCES=false` is an acceptable secure default for deployments.
- **ASSUMPTION-003**: Existing clients can use `session://{sessionId}` metadata without transcript/events/raw-parts access.

## 8. Related Specifications / Further Reading

- `src/server.ts:createServerInstance`
- `src/client.ts:buildGenerateContentConfig`
- `src/lib/tool-executor.ts:ToolExecutor.runStream`
- `src/lib/streaming.ts:executeToolStream`
- `src/lib/task-utils.ts:getWorkSignal`
- `src/resources.ts:registerSessionResources`
- `src/tools/chat.ts:appendSessionResource`
- `src/sessions.ts:buildReplayHistoryParts`
- `src/sessions.ts:capRawParts`
- `package.json`
