---
goal: Address highly recommended MCP TypeScript SDK v2 correctness issues identified in the SDK v2 review
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, architecture, mcp, sdk-v2]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan implements every "highly recommended" remediation surfaced by the MCP TypeScript SDK v2 review of `gemini-assistant`. It targets nine concrete defects spanning capability declaration, server `Implementation` metadata, task input validation transparency, logger broadcast semantics, stateless-transport session safety, root-fetcher fan-out, public-contract URI honesty, elicitation capability gating, and progress message documentation. Each item is verified against the current source before being scheduled.

## 1. Requirements & Constraints

- **REQ-001**: Preserve the existing public surface (`PUBLIC_TOOL_NAMES`, `PUBLIC_PROMPT_NAMES`, `PUBLIC_RESOURCE_URIS`, `discover://*`, `session://*`, `gemini://sessions/...` URIs) — no breaking changes for clients.
- **REQ-002**: All four public tools (`chat`, `research`, `analyze`, `review`) must remain task-aware via `server.experimental.tasks.registerToolTask`.
- **REQ-003**: Tool failures continue to surface as `CallToolResult { isError: true }`. Protocol errors remain reserved for `ProtocolError` paths.
- **REQ-004**: Every change must keep `structuredContent` valid against `outputSchema` (existing `safeValidateStructuredContent` invariant).
- **REQ-005**: `npm run lint`, `npm run type-check`, and `npm run test` must all pass after each phase.
- **SEC-001**: Stdio transport must remain free of any `console.*` output. Logger gating logic must not regress.
- **SEC-002**: Bearer token, host-allow-list, and CORS behavior in [transport.ts](src/transport.ts) must remain unchanged.
- **CON-001**: SDK v2 packages in use are `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`. Do not introduce v1 imports.
- **CON-002**: `node:sqlite`, Zod v4, and the `Standard Schema` shape used for `inputSchema`/`outputSchema` must be preserved.
- **CON-003**: Plan files go under `docs/plan/` (repo convention), not the SDK skill's default `/plan/`.
- **GUD-001**: Prefer threading shared singletons (logger, rootsFetcher) through dependency injection over rebuilding them at registration time.
- **GUD-002**: When a peer capability is required for a request (elicitation, sampling), check `ctx.mcpReq.capabilities` before issuing it.
- **PAT-001**: Use `multi_replace_string_in_file` for batched edits within a single file. Use absolute paths in tool calls.
- **PAT-002**: Each phase finishes with `npm run format && npm run lint && npm run type-check && npm run test`.

## 2. Implementation Steps

### Implementation Phase 1 — Capability and `Implementation` info hygiene

- GOAL-001: Bring `new McpServer(...)` invocation into strict alignment with the SDK v2 `Implementation` shape and remove the misleading `tools.listChanged` declaration.

| Task     | Description                                                                                                                                                                                                                                                    | Completed          | Date         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------ | --- | ---------- |
| TASK-001 | In [src/server.ts](src/server.ts) `createServerInstance()`, remove the non-standard `description` and `websiteUrl` fields from the `Implementation` literal passed to `new McpServer(...)`. Add `title: 'Gemini Assistant'`. Keep `name` and `version`.        | Yes                | 2026-04-26   |
| TASK-002 | In [src/server.ts](src/server.ts), retain `SERVER_DESCRIPTION` only as a string constant for documentation/logs (or delete if unused after TASK-001). Confirm no other module imports it; if unused, remove the export.                                        | Yes                | 2026-04-26   |
| TASK-003 | In [src/server.ts](src/server.ts) capabilities literal, replace `tools: { listChanged: false }` with `tools: {}`. Inventory is static and `sendToolListChanged` is never called.                                                                               | Yes                | 2026-04-26   |
| TASK-004 | Search the workspace for any test that asserts on `serverInfo.description`, `serverInfo.websiteUrl`, or `capabilities.tools.listChanged === false`. Update or remove those assertions to reflect the new shape. Use `grep_search` on `description.\*websiteUrl | listChanged: false | websiteUrl`. | Yes | 2026-04-26 |
| TASK-005 | Run `npm run format && npm run lint && npm run type-check && npm run test`. Resolve any failures introduced by Phase 1.                                                                                                                                        | Yes                | 2026-04-26   |

### Implementation Phase 2 — Single shared `rootsFetcher`

- GOAL-002: Build the `rootsFetcher` exactly once per server instance and thread it through `ServerServices` to all tool registrars instead of rebuilding it inside individual tools.

| Task     | Description                                                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | In [src/server.ts](src/server.ts), extend the `ServerServices` interface with `rootsFetcher: RootsFetcher`. Import `type { RootsFetcher } from './lib/validation.js'`.                                                                                                      | Yes       | 2026-04-26 |
| TASK-007 | In `createServerInstance()` ([src/server.ts](src/server.ts)), build `const rootsFetcher = buildServerRootsFetcher(server);` once and pass it inside the `services` object handed to `registerServerTools` and to `registerResources`.                                       | Yes       | 2026-04-26 |
| TASK-008 | Update each entry of `SERVER_TOOL_REGISTRARS` ([src/server.ts](src/server.ts)) to forward `services.rootsFetcher` to `registerAnalyzeTool` and `registerReviewTool`. Chat and research do not currently take a fetcher; leave them unchanged unless they begin to need one. | Yes       | 2026-04-26 |
| TASK-009 | In [src/tools/analyze.ts](src/tools/analyze.ts) `registerAnalyzeTool`, accept `rootsFetcher: RootsFetcher` as a new parameter and remove the local `const rootsFetcher = buildServerRootsFetcher(server);`. Update its single call site in [src/server.ts](src/server.ts).  | Yes       | 2026-04-26 |
| TASK-010 | In [src/tools/review.ts](src/tools/review.ts) `registerReviewTool`, accept `rootsFetcher: RootsFetcher` as a new parameter and remove the local `const rootsFetcher = buildServerRootsFetcher(server);`. Update its single call site in [src/server.ts](src/server.ts).     | Yes       | 2026-04-26 |
| TASK-011 | Update `__tests__/tools/registration.test.ts` (and any other test that calls the analyze/review registrars directly) to pass a `RootsFetcher` test double. Reuse existing fixtures where possible.                                                                          | Yes       | 2026-04-26 |
| TASK-012 | Run `npm run format && npm run lint && npm run type-check && npm run test`. Resolve any failures.                                                                                                                                                                           | Yes       | 2026-04-26 |

### Implementation Phase 3 — Public-contract URI honesty

- GOAL-003: Stop advertising templated URIs as if they were resolvable static URIs and soften the chat tool's `turnParts` promise to match its actual conditional availability.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-013 | In [src/public-contract.ts](src/public-contract.ts), introduce two new exported tuples: `PUBLIC_STATIC_RESOURCE_URIS` (containing only `discover://catalog`, `discover://context`, `discover://workflows`, `session://`, `workspace://context`, `workspace://cache`) and `PUBLIC_RESOURCE_TEMPLATES` (containing `session://{sessionId}`, `session://{sessionId}/transcript`, `session://{sessionId}/events`, `gemini://sessions/{sessionId}/turns/{turnIndex}/parts`). Keep `PUBLIC_RESOURCE_URIS` as the union for backward compatibility, derived from the two tuples. | Yes       | 2026-04-26 |
| TASK-014 | In [src/public-contract.ts](src/public-contract.ts) `DISCOVERY_ENTRIES`, locate the `chat` tool entry. Update its `returns` text to clarify that `gemini://sessions/{sessionId}/turns/{turnIndex}/parts` is "available only when sessions persist `Part[]`". Add an explicit limitation entry: "Sessions started before raw `Part[]` capture cannot serve `gemini://sessions/.../parts`."                                                                                                                                                                                 | Yes       | 2026-04-26 |
| TASK-015 | In [src/public-contract.ts](src/public-contract.ts) `DISCOVERY_ENTRIES`, ensure the `session://{sessionId}` family is annotated as templated (e.g., add a `template: true` boolean to the `DiscoveryEntry` interface or rely on the new tuples in TASK-013). Pick one approach; do not duplicate.                                                                                                                                                                                                                                                                         | Yes       | 2026-04-26 |
| TASK-016 | In [src/server.ts](src/server.ts), update `STATIC_RESOURCE_URIS` to derive from `PUBLIC_STATIC_RESOURCE_URIS` instead of filtering for the `'{'` substring.                                                                                                                                                                                                                                                                                                                                                                                                               | Yes       | 2026-04-26 |
| TASK-017 | Update tests in `__tests__/contract-surface.test.ts`, `__tests__/schemas/public-contract.test.ts`, and `__tests__/catalog.test.ts` to assert on the new tuples and the softened chat description.                                                                                                                                                                                                                                                                                                                                                                         | Yes       | 2026-04-26 |
| TASK-018 | Run `npm run format && npm run lint && npm run type-check && npm run test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Yes       | 2026-04-26 |

### Implementation Phase 4 — Stateless-transport session safety in chat

- GOAL-004: Make the `chat` tool refuse or warn when a `sessionId` is supplied under stateless HTTP/web-standard transport, so that clients are not surprised by silent session loss between requests.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-019 | In [src/config.ts](src/config.ts), add `export function getStatelessTransportFlag(): boolean` that returns `getTransportConfig().isStateless` when transport is `http` or `web-standard`, and `false` for `stdio`.                                                                                                                                                                                           | Yes       | 2026-04-26 |
| TASK-020 | In [src/tools/chat.ts](src/tools/chat.ts) `validateAskRequest` (or, if absent, in `chatWork` before delegating to `askWork`), add an early return that produces `new AppError('chat', 'sessionId is unsupported under stateless transport. Omit sessionId or run with TRANSPORT=stdio or STATELESS=false.').toToolResult()` whenever `args.sessionId !== undefined && getStatelessTransportFlag() === true`. | Yes       | 2026-04-26 |
| TASK-021 | In [src/public-contract.ts](src/public-contract.ts) `chat` discovery entry, tighten the existing limitation `"Sessions require a stateful server connection path; stateless transport mode does not preserve chat continuity across requests."` to: `"Sessions require a stateful server connection path. Stateless transport rejects chat calls that include sessionId."`.                                  | Yes       | 2026-04-26 |
| TASK-022 | Add a new test in `__tests__/tools/ask.test.ts` (or the appropriate chat test file) that stubs `getStatelessTransportFlag` to `true` and asserts the chat tool returns `isError: true` with the new message when `sessionId` is provided.                                                                                                                                                                    | Yes       | 2026-04-26 |
| TASK-023 | Run `npm run format && npm run lint && npm run type-check && npm run test`.                                                                                                                                                                                                                                                                                                                                  | Yes       | 2026-04-26 |

### Implementation Phase 5 — Logger and progress documentation, elicitation capability gating

- GOAL-005: Make non-obvious behaviors of the logger broadcast and `reportFailure` truncation explicit in code, and gate `elicitTaskInput` on peer elicitation capability so unsupported clients see a typed `CallToolResult` failure rather than an unhandled rejection.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-024 | In [src/lib/logger.ts](src/lib/logger.ts) `broadcastToServers`, add a code comment above `if (entry.traceId) return;` explaining that traced lines stay local because they belong to ALS-scoped internals and would leak request IDs to peers. If this rationale is wrong, remove the gate instead.                                                                                                                                                                                                   | Yes       | 2026-04-26 |
| TASK-025 | In [src/lib/progress.ts](src/lib/progress.ts) `reportFailure`, document inline that the 80-character truncation only affects the progress message and that the full error message is preserved in the failed task result via `runToolAsTask` (`storeFailedResult`).                                                                                                                                                                                                                                   | Yes       | 2026-04-26 |
| TASK-026 | In [src/lib/task-utils.ts](src/lib/task-utils.ts) `elicitTaskInput`, before calling `ctx.mcpReq.elicitInput(...)`, check `ctx.mcpReq.capabilities?.elicitation`. If absent, restore task status to `'working'` and `throw new AppError('chat', 'Elicitation is not supported by the connected client.')`. Catch this in the existing `try/catch` so the task records a clean `failed` result via `materializeTaskFailure`.                                                                            | Yes       | 2026-04-26 |
| TASK-027 | Add a code comment above `createSdkPassthroughInputSchema` ([src/lib/task-utils.ts](src/lib/task-utils.ts)) explaining: (a) the SDK validates `inputSchema` before reaching the handler when `validate` runs normally, (b) we deliberately bypass validation here so schema-invalid arguments still create a task and surface as a `failed` task result via `materializeTaskFailure` rather than as a `tools/call` protocol error, (c) `parseTaskInput` performs the real validation inside the task. | Yes       | 2026-04-26 |
| TASK-028 | If a unit test for `elicitTaskInput` exists in `__tests__/`, add a case where `capabilities.elicitation` is undefined and verify a `failed` task result is stored. Otherwise, skip.                                                                                                                                                                                                                                                                                                                   | Yes       | 2026-04-26 |
| TASK-029 | Run `npm run format && npm run lint && npm run type-check && npm run test`.                                                                                                                                                                                                                                                                                                                                                                                                                           | Yes       | 2026-04-26 |

### Implementation Phase 6 — Verification and changelog

- GOAL-006: Confirm the full test suite, lint, and type-check pass on a clean tree and capture a one-line changelog entry per fixed item.

| Task     | Description                                                                                                                                                                                                                                                | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-030 | From the repo root, run `npm run format` then `npm run lint` then `npm run type-check` then `npm run test`. All four must exit 0.                                                                                                                          | Yes       | 2026-04-26 |
| TASK-031 | Update [README.md](README.md) "Server capabilities" section (if present) to reflect the new `Implementation` info shape (`title`) and the `tools: {}` declaration. Skip if no such section.                                                                | Yes       | 2026-04-26 |
| TASK-032 | Append entries to [docs/specs/2026-04-26-refactor-design.md](docs/specs/2026-04-26-refactor-design.md) summarizing each fix with a short rationale, or create a new note `docs/specs/2026-04-26-mcp-sdk-v2-correctness.md` if the existing spec is closed. | Yes       | 2026-04-26 |

## 3. Alternatives

- **ALT-001**: Make task input validation strict by removing `createSdkPassthroughInputSchema` so schema-invalid args become `tools/call` protocol errors. Rejected because it breaks the task-first contract clients rely on; instead we document the intentional bypass (TASK-027).
- **ALT-002**: Subscribe to `notifications/resources/updated` for `discover://context` and `workspace://cache`. Rejected for this plan: the resources change opportunistically and adding `subscribe: true` capability requires a non-trivial subscription registry. Tracked separately.
- **ALT-003**: Move `sessionStore` ownership above `createServer` so HTTP-stateless clients can keep sessions. Rejected: it leaks per-process state across unauthenticated clients in stateless mode. Phase 4 takes the safer path and rejects `sessionId` instead.
- **ALT-004**: Drop the entire `description`/`websiteUrl` literal silently. Rejected in favor of `title` (TASK-001), which is the SDK v2-supported field.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` SDK v2 (`McpServer`, `Implementation`, `ResourceTemplate`, `RELATED_TASK_META_KEY`).
- **DEP-002**: `@modelcontextprotocol/node` (`NodeStreamableHTTPServerTransport`).
- **DEP-003**: `@modelcontextprotocol/express` (`createMcpExpressApp`).
- **DEP-004**: `zod/v4`, `@cfworker/json-schema`, `@google/genai`. No version bumps required.
- **DEP-005**: Existing `RootsFetcher` helper in [src/lib/validation.ts](src/lib/validation.ts).

## 5. Files

- **FILE-001**: [src/server.ts](src/server.ts) — capability literal, `Implementation` shape, `STATIC_RESOURCE_URIS`, `ServerServices`, `rootsFetcher` plumbing.
- **FILE-002**: [src/index.ts](src/index.ts) — no functional change expected; verify boot path still passes correct deps.
- **FILE-003**: [src/lib/task-utils.ts](src/lib/task-utils.ts) — comment on `createSdkPassthroughInputSchema`, elicitation capability check.
- **FILE-004**: [src/lib/logger.ts](src/lib/logger.ts) — comment on `traceId` gate.
- **FILE-005**: [src/lib/progress.ts](src/lib/progress.ts) — comment on `reportFailure` truncation.
- **FILE-006**: [src/tools/analyze.ts](src/tools/analyze.ts) — accept injected `rootsFetcher`.
- **FILE-007**: [src/tools/review.ts](src/tools/review.ts) — accept injected `rootsFetcher`.
- **FILE-008**: [src/tools/chat.ts](src/tools/chat.ts) — stateless-mode `sessionId` rejection.
- **FILE-009**: [src/public-contract.ts](src/public-contract.ts) — split static vs templated URI tuples, soften chat `turnParts` promise.
- **FILE-010**: [src/config.ts](src/config.ts) — `getStatelessTransportFlag` helper.
- **FILE-011**: `__tests__/contract-surface.test.ts`, `__tests__/schemas/public-contract.test.ts`, `__tests__/catalog.test.ts`, `__tests__/tools/registration.test.ts`, `__tests__/tools/ask.test.ts` — assertion updates.
- **FILE-012**: [docs/specs/2026-04-26-refactor-design.md](docs/specs/2026-04-26-refactor-design.md) or a new sibling note — changelog entries.

## 6. Testing

- **TEST-001**: `__tests__/server-capabilities.test.ts` (or `__tests__/index.test.ts`) — assert the `Implementation` literal contains `name`, `version`, `title` and does **not** contain `description` or `websiteUrl`. Assert capabilities `tools` is an empty object.
- **TEST-002**: `__tests__/tools/registration.test.ts` — assert `registerAnalyzeTool` and `registerReviewTool` accept and use the injected `rootsFetcher`. Add a stub fetcher and verify it is invoked instead of one built locally.
- **TEST-003**: `__tests__/contract-surface.test.ts` — assert `PUBLIC_STATIC_RESOURCE_URIS` and `PUBLIC_RESOURCE_TEMPLATES` cover, exactly, the existing `PUBLIC_RESOURCE_URIS` set (no missing entries, no overlap).
- **TEST-004**: `__tests__/catalog.test.ts` — assert the chat discovery entry mentions conditional `turnParts` availability.
- **TEST-005**: `__tests__/tools/ask.test.ts` — new case: `sessionId` provided + stateless flag stubbed `true` ⇒ `CallToolResult { isError: true }` with the documented message. Existing stdio/non-stateless case still succeeds.
- **TEST-006**: `__tests__/lib/task-utils.test.ts` (create or extend) — case where `ctx.mcpReq.capabilities.elicitation` is `undefined` ⇒ `elicitTaskInput` rejects with the new `AppError`, task status returns to `'working'`.
- **TEST-007**: Existing `__tests__/transport.test.ts`, `__tests__/transport-stdio.test.ts`, `__tests__/transport-host-validation.test.ts` — must continue to pass without modification.
- **TEST-008**: `__tests__/server-notifications.test.ts` — must continue to pass; capability change to `tools: {}` should not break it.

## 7. Risks & Assumptions

- **RISK-001**: Removing `description`/`websiteUrl` may break a downstream client that parsed those fields from `serverInfo`. Mitigation: they are non-standard, and `instructions` already conveys the same information.
- **RISK-002**: The stateless-mode rejection in chat (Phase 4) changes observable behavior for clients that today silently get a single-request session. Mitigation: documented in the discovery entry and surfaced as `isError: true` with an actionable message.
- **RISK-003**: Test fixtures that build `RootsFetcher` indirectly may need parallel updates after Phase 2. Mitigation: Phase 2 ends with the full test suite green.
- **RISK-004**: Splitting `PUBLIC_RESOURCE_URIS` could regress an external consumer iterating the union. Mitigation: keep the union exported and derive it from the new tuples.
- **ASSUMPTION-001**: `getTransportConfig().isStateless` is the authoritative source of truth for stateless mode at runtime; `stdio` is always considered stateful for chat purposes.
- **ASSUMPTION-002**: `ctx.mcpReq.capabilities` reflects the negotiated peer capabilities at request time; no deeper SDK internals need to be inspected.
- **ASSUMPTION-003**: No production deployment relies on `serverInfo.description` or `serverInfo.websiteUrl`.
- **ASSUMPTION-004**: The intentional bypass in `createSdkPassthroughInputSchema` is the desired behavior; documenting it is sufficient (no behavioral change).

## 8. Related Specifications / Further Reading

- [.agents/skills/mcp-typescript-sdk-v2/SKILL.md](.agents/skills/mcp-typescript-sdk-v2/SKILL.md) — repo-bundled SDK v2 skill used as the review baseline.
- [docs/specs/2026-04-26-refactor-design.md](docs/specs/2026-04-26-refactor-design.md) — current refactor design notes.
- [docs/plan/refactor-tool-orchestration-consistency-1.md](docs/plan/refactor-tool-orchestration-consistency-1.md) — adjacent in-flight refactor plan.
- [AGENTS.md](AGENTS.md) — workspace conventions, commands, and safety boundaries.
- MCP TypeScript SDK v2 release notes (consult `package.json` for installed version, then the matching CHANGELOG in `node_modules/@modelcontextprotocol/server`).
