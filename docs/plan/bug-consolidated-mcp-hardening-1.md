---
goal: Consolidated MCP hardening plan for transport lifecycle, tool contracts, server bootstrap, and memory/workspace/session state
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Planned'
tags: [bug, consolidated, mcp, transport, contract, bootstrap, memory, workspace, sessions]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan supersedes the prior separate transport lifecycle, tool contract, server bootstrap, and memory/workspace/session-state bug-fix plans.

The consolidated implementation fixes transport session lifecycle defects, hardens public tool contracts, aligns server bootstrap capabilities and notification routing, and makes memory/workspace/session state safer under concurrent server instances. Shared files are grouped into single phases to avoid conflicting edits.

## 1. Requirements & Constraints

- **REQ-001**: Stateful `DELETE /mcp` without `mcp-session-id` MUST return `400` without allocating a `ManagedPair`.
- **REQ-002**: Stateful `DELETE /mcp` with an unknown `mcp-session-id` MUST return `404` without allocating a `ManagedPair`.
- **REQ-003**: Stateless `DELETE /mcp` behavior MUST remain unchanged.
- **REQ-004**: `statefulPairs.size` MUST never exceed `maxSessions`, including concurrent first-contact bursts.
- **REQ-005**: Expired stateful pairs MUST be evicted without inbound request traffic.
- **REQ-006**: HTTP transport shutdown MUST complete within the existing 10 second shutdown watchdog under realistic keep-alive clients.
- **REQ-007**: Public tool annotations MUST reflect worst-case tool side effects; `memory` MUST set `destructiveHint: true`.
- **REQ-008**: Public output schema descriptions MUST match runtime semantics.
- **REQ-009**: Internal `structuredContent` schema drift MUST return a safe `CallToolResult` with `isError: true`; raw Zod details MUST be logged server-side only.
- **REQ-010**: Unreachable output schemas MUST be removed from `src/schemas/outputs.ts`.
- **REQ-011**: `MemoryInputSchema` MUST enforce action-specific required fields via `z.discriminatedUnion('action', ...)`.
- **REQ-012**: Cache cleanup MUST NOT delete user-created Gemini caches unless the cache is owned by this server.
- **REQ-013**: `SessionStore.replaceSession` MUST preserve transcript, events, and session identity metadata while replacing only `chat`.
- **REQ-014**: Session append operations MUST NOT emit dead-end detail-only notifications because the server does not declare `resources.subscribe`.
- **REQ-015**: Workspace cache state used by resources, memory, and chat tools MUST be scoped to each `createServerInstance()` result.
- **REQ-016**: `discover://context` `cacheStatus.fresh` MUST reflect real TTL freshness while preserving the existing field name.
- **REQ-017**: Session resource list handlers MUST use one `listSessionEntries()` snapshot per request.
- **REQ-018**: Workspace cache creation cleanup MUST NOT call `caches.delete` with an empty name.
- **REQ-019**: `caches.get` not-found mapping MUST prefer structured SDK status/code fields over substring matching.
- **REQ-020**: Cache-change notifications MUST fan out exactly once per connected server instance.
- **REQ-021**: `createServerInstance()` MUST advertise `completions: {}` because completion handlers already exist.
- **REQ-022**: `SERVER_INSTRUCTIONS` MUST mention every `PUBLIC_TOOL_NAMES` entry and the canonical discovery resources `discover://catalog` and `discover://workflows`.
- **SEC-001**: Do not weaken Host validation, CORS policy, or stateful/stateless transport selection.
- **SEC-002**: DELETE pre-validation MUST run after Host validation and OPTIONS handling.
- **SEC-003**: Destructive cache cleanup MUST only target names with the deterministic ownership prefix `gemini-assistant/`.
- **CON-001**: Do not add new runtime dependencies or new environment variables.
- **CON-002**: Keep MCP SDK v2 split-package imports.
- **CON-003**: Do not change public tool, prompt, resource, workflow, input schema, or output schema identifiers except deleting dead `AskOutputSchema`.
- **CON-004**: Preserve `createServerInstance(): ServerInstance` shape and registration order: tools, task-safe handler, prompts, resources.
- **CON-005**: Preserve `exactOptionalPropertyTypes`, ESLint, Prettier, and TypeScript compliance.
- **CON-006**: Do not add `resources.subscribe` in this plan.
- **CON-007**: Do not run `npm run build` without approval.
- **GUD-001**: Implement shared-file changes in this plan order to avoid edit conflicts.
- **GUD-002**: Prefer existing helpers and patterns: `sendResourceChangedForServer`, `registerTaskTool`, `createMemoryInputSchema`, `buildBaseStructuredOutput`, `closeStatefulPairs`, and `createAsyncLock`.
- **GUD-003**: Add targeted tests for every new invariant.
- **PAT-001**: Use discriminated unions for mode/action-specific public inputs.
- **PAT-002**: Use per-server closure-scoped mutable state for server-instance lifecycle state.
- **PAT-003**: Use safe tool-error results for internal output validation drift.

### Consolidation Decisions

- **DEC-001**: Keep `cacheStatus.fresh` and compute real TTL freshness. Do not rename it to `active` because that would add avoidable public resource output churn.
- **DEC-002**: Choose the poll-only notification model. Remove dead-end detail-only session append notifications and do not add `resources.subscribe`.
- **DEC-003**: Scope `WorkspaceCacheManagerImpl` per server and inject it into `registerResources`, `registerMemoryTool`, and `registerChatTool`. This extends the source plan because `src/tools/chat.ts` currently imports the module-level `workspaceCacheManager`.
- **DEC-004**: Use `displayName` prefix ownership marker `gemini-assistant/` for cache cleanup. Do not depend on Gemini cache labels in this plan.
- **DEC-005**: Implement `MemoryInputSchema` hardening despite the memory-state source plan's broad "no schema changes" constraint because the tool-contract source plan explicitly requires external-boundary validation.

## 2. Implementation Steps

### Implementation Phase 1 - Public Tool Contract Hardening

- GOAL-001: Correct public tool metadata, remove dead schema surface, safely handle structured-output drift, and enforce memory action inputs.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                         | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In `src/lib/task-utils.ts`, add exported `DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const` next to `MUTABLE_ANNOTATIONS`.                                                                                                                                                                                             |           |      |
| TASK-002 | In `src/tools/memory.ts`, import `DESTRUCTIVE_ANNOTATIONS` and use it in `registerMemoryTool` instead of `MUTABLE_ANNOTATIONS`.                                                                                                                                                                                                                                                                     |           |      |
| TASK-003 | In `src/schemas/outputs.ts`, update `ReviewOutputSchema.shape.empty` description to `Whether the local diff is empty (no changes)`.                                                                                                                                                                                                                                                                 |           |      |
| TASK-004 | In `src/lib/response.ts`, add `safeValidateStructuredContent<TSchema extends z.ZodType>(toolName, outputSchema, structuredContent, result): CallToolResult`. On success, return `result` with parsed `structuredContent`. On failure, log `z.prettifyError(parsed.error)` through `logger.child('response').error(...)` and return a generic `isError: true` tool result.                           |           |      |
| TASK-005 | Replace `validateStructuredContent` result assembly in `src/tools/analyze.ts`, `src/tools/research.ts`, `src/tools/review.ts`, and `src/tools/chat.ts` with `safeValidateStructuredContent`.                                                                                                                                                                                                        |           |      |
| TASK-006 | Keep `validateStructuredContent` only if still used by unit tests; otherwise remove the export and update imports.                                                                                                                                                                                                                                                                                  |           |      |
| TASK-007 | In `src/schemas/outputs.ts`, delete `AskOutputSchema`. Remove `AskOutputSchema` imports and tests from `__tests__/schemas/outputs.test.ts`.                                                                                                                                                                                                                                                         |           |      |
| TASK-008 | In `src/schemas/inputs.ts`, rewrite `createMemoryInputSchema` as `z.discriminatedUnion('action', [...])` with strict action members.                                                                                                                                                                                                                                                                |           |      |
| TASK-009 | Encode required fields in the memory union: `sessions.list` none; `sessions.get`, `sessions.transcript`, `sessions.events` require `sessionId`; `caches.list` none; `caches.get`, `caches.delete` require `cacheName`; `caches.update` requires `cacheName` and `ttl`; `caches.create` requires at least one of `filePaths` or `systemInstruction`; `workspace.context` and `workspace.cache` none. |           |      |
| TASK-010 | In `src/schemas/validators.ts`, remove `validateFlatMemoryInput` if unused after TASK-008, or keep only the meaningful `caches.create` refinement logic.                                                                                                                                                                                                                                            |           |      |
| TASK-011 | In `src/tools/memory.ts`, remove `hasSessionId`, `hasCacheName`, `hasTtl`, and the trailing unhandled-action throw from `memoryWork`; rely on `args.action` narrowing.                                                                                                                                                                                                                              |           |      |
| TASK-012 | Update contract and schema tests in `__tests__/schemas/public-contract.test.ts`, `__tests__/schemas/inputs.test.ts`, `__tests__/contract-surface.test.ts`, `__tests__/tools/registration.test.ts`, `__tests__/tools/memory.test.ts`, and `__tests__/mcp-tools.e2e.test.ts`.                                                                                                                         |           |      |

### Implementation Phase 2 - Memory, Session, Workspace, and Resource State

- GOAL-002: Prevent destructive cache cleanup, preserve session history, scope workspace cache state per server, and stabilize resource reads.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                    | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-013 | In `src/tools/memory.ts`, change `cleanupOldCaches` to delete only caches whose `displayName` starts with `gemini-assistant/`, matches the target display name after prefix normalization, and is not `keepName`.                                                                                                                                                              |           |      |
| TASK-014 | In `src/tools/memory.ts`, change cache creation config so cleanup-enabled cache display names use the deterministic prefix `gemini-assistant/`; preserve the user-visible display name in returned structured content where currently exposed.                                                                                                                                 |           |      |
| TASK-015 | In `src/sessions.ts`, update `replaceSession(id, chat)` to preserve existing transcript, events, and access metadata while replacing only `chat`; do not route through `storeSession`.                                                                                                                                                                                         |           |      |
| TASK-016 | In `src/sessions.ts`, remove `this.notifyChange([id], false)` from append-history paths used by `appendSessionTranscript` and `appendSessionEvent`.                                                                                                                                                                                                                            |           |      |
| TASK-017 | In `src/sessions.ts`, change `setSession` collision failure from bare `Error` to `AppError('sessions', ...)`.                                                                                                                                                                                                                                                                  |           |      |
| TASK-018 | In `src/lib/workspace-context.ts`, export `WorkspaceCacheManagerImpl`, add `createWorkspaceCacheManager(): WorkspaceCacheManagerImpl`, and keep the module-level `workspaceCacheManager` export as a compatibility fallback.                                                                                                                                                   |           |      |
| TASK-019 | In `src/lib/workspace-context.ts`, add `WorkspaceCacheManagerImpl.close(): Promise<void>` that waits best-effort for `inflightCreation`, then calls `invalidate()`.                                                                                                                                                                                                            |           |      |
| TASK-020 | In `src/lib/workspace-context.ts` `createCacheFromContext`, guard mid-flight discard with `if (cache.name) await this.deleteCacheBestEffort(cache.name, signal)`.                                                                                                                                                                                                              |           |      |
| TASK-021 | In `src/lib/workspace-context.ts` `normalizeRootsKey`, log a warning when all roots are filtered and the resulting key is empty.                                                                                                                                                                                                                                               |           |      |
| TASK-022 | In `src/server.ts`, instantiate `const workspaceCacheManager = createWorkspaceCacheManager()` inside `createServerInstance()`. Add `workspaceCacheManager` to `ServerServices`, pass it to tool/resource registrars, and close it during server shutdown through an async close step (`await workspaceCacheManager.close()` inside the existing close error aggregation flow). |           |      |
| TASK-023 | In `src/tools/chat.ts`, update `registerChatTool` and internal work helpers to accept an optional `WorkspaceCacheManagerImpl` parameter and use that instance instead of the module-level `workspaceCacheManager`.                                                                                                                                                             |           |      |
| TASK-024 | In `src/tools/memory.ts`, update `registerMemoryTool` and workspace/cache handlers to accept an optional `WorkspaceCacheManagerImpl` parameter and use that instance instead of the module-level `workspaceCacheManager`.                                                                                                                                                      |           |      |
| TASK-025 | In `src/resources.ts`, update `registerResources` and resource builders to accept an optional `WorkspaceCacheManagerImpl` parameter and use that instance instead of the module-level `workspaceCacheManager`.                                                                                                                                                                 |           |      |
| TASK-026 | In `src/resources.ts`, use one `const entries = sessionStore.listSessionEntries()` snapshot per session-resource list callback and pass it through `sessionDetailResources`, `sessionTranscriptResources`, and `sessionEventResources`.                                                                                                                                        |           |      |
| TASK-027 | In `src/resources.ts`, keep `cacheStatus.fresh` but compute it from the manager's `createdAt` and TTL; `fresh` MUST be `false` when the cache is expired or missing.                                                                                                                                                                                                           |           |      |
| TASK-028 | In `src/tools/memory.ts` `handleCachesGet`, prefer structured SDK `status` or `code` values for 404/NOT_FOUND mapping; keep substring matching only as a fallback.                                                                                                                                                                                                             |           |      |
| TASK-029 | In `src/tools/memory.ts` `handleSessionsGet`, replace index-based resource label/URI wiring with one tagged tuple containing detail, transcript, and events metadata.                                                                                                                                                                                                          |           |      |

### Implementation Phase 3 - Server Bootstrap and Notification Contract

- GOAL-003: Align server capabilities, per-instance notifications, imports, and instructions with the public contract.

| Task     | Description                                                                                                                                                                                                            | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-030 | In `src/server.ts`, merge the duplicate `./tools/memory.js` imports into one import containing `type CacheChangeEvent`, `registerMemoryTool`, and `subscribeCacheChange`.                                              |           |      |
| TASK-031 | In `src/server.ts`, remove module-level `sendResourceChanged`, module-level `handleCacheChange`, and `activeServers` if no references remain after TASK-032.                                                           |           |      |
| TASK-032 | In `createServerInstance()`, replace `subscribeCacheChange(handleCacheChange)` with `subscribeCacheChange(({ detailUris }: CacheChangeEvent) => sendResourceChangedForServer(server, MEMORY_CACHES_URI, detailUris))`. |           |      |
| TASK-033 | In `createServerInstance()` capabilities, add `completions: {}` between `logging: {}` and `prompts: {}`. Do not add `resources.subscribe`.                                                                             |           |      |
| TASK-034 | Export `SERVER_INSTRUCTIONS` as a named export from `src/server.ts`.                                                                                                                                                   |           |      |
| TASK-035 | In `__tests__/contract-surface.test.ts`, add a test asserting every `PUBLIC_TOOL_NAMES` entry plus `discover://catalog` and `discover://workflows` appears in `SERVER_INSTRUCTIONS`.                                   |           |      |
| TASK-036 | Add or update notification tests so one cache change produces exactly one `notifications/resources/list_changed` for `memory://caches` per connected server instance.                                                  |           |      |
| TASK-037 | Add or update a capability test asserting `createServerInstance()` advertises `completions`.                                                                                                                           |           |      |

### Implementation Phase 4 - Transport Session Lifecycle

- GOAL-004: Harden HTTP and Web-Standard stateful session lifecycle under malformed DELETE, concurrency, idle expiry, and shutdown.

| Task     | Description                                                                                                                                                                                                                                            | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-038 | In `src/transport.ts`, add helper `rejectDeleteWithoutSession(method, sessionId, isStateless): boolean` returning `true` only for stateful `DELETE` requests without a session id.                                                                     |           |      |
| TASK-039 | In Node `app.all('/mcp', ...)`, call the helper after Host validation and `getNodeSessionId(req)`; return `nodeErrorResponse(res, 400, 'mcp-session-id header required for DELETE')` before `handleManagedRequest`.                                    |           |      |
| TASK-040 | In the Web-Standard handler, call the helper after Host validation, OPTIONS handling, and `getRequestSessionId(req)`; return `withCors(responseError(400, 'mcp-session-id header required for DELETE'), corsOrigin)` before `handleManagedRequest`.    |           |      |
| TASK-041 | Add closure-scoped `reservedStatefulSlots` state for each transport invocation and include reservations in capacity checks as `statefulPairs.size + reservedStatefulSlots >= maxSessions`.                                                             |           |      |
| TASK-042 | Pass reservation accessors/mutators through `ManagedRequestOptions` so `handleManagedRequest`, capacity checks, and finalization remain transport-agnostic.                                                                                            |           |      |
| TASK-043 | Ensure reservation decrement occurs when a created pair is registered, when creation fails, and in the `handleManagedRequest` `finally` path.                                                                                                          |           |      |
| TASK-044 | Add `startStatefulIdleSweep(statefulPairs, sessionTtlMs): () => void` using an unref'ed `setInterval` at `Math.max(sessionTtlMs / 4, 60_000)` with an overlap guard.                                                                                   |           |      |
| TASK-045 | Start the idle sweep in `startHttpTransport` and `startWebStandardTransport`; call its disposer before `closeStatefulPairs(statefulPairs)`.                                                                                                            |           |      |
| TASK-046 | In `startHttpTransport.close`, after stateful pairs close and before awaiting server close completion, call `httpServer.closeIdleConnections()` and then force remaining sockets with `httpServer.closeAllConnections()` in a logged best-effort path. |           |      |

### Implementation Phase 5 - Verification

- GOAL-005: Prove the consolidated changes with targeted tests and required project checks.

| Task     | Description                                                                                                                                                                                                                                                                      | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-047 | Add or update unit tests for memory annotations, `ReviewOutputSchema.empty` description, `safeValidateStructuredContent`, `AskOutputSchema` removal, and `MemoryInputSchema` discriminated-union validation.                                                                     |           |      |
| TASK-048 | Add or update tests for cache cleanup ownership prefix, `replaceSession` history preservation, append notification removal, `WorkspaceCacheManagerImpl` instance isolation, `close()` drain, empty-name delete guard, structured not-found mapping, and `setSession` `AppError`. |           |      |
| TASK-049 | Add or update resource tests for single-snapshot session listing and accurate `cacheStatus.fresh` semantics.                                                                                                                                                                     |           |      |
| TASK-050 | Add or update server tests for `SERVER_INSTRUCTIONS`, per-instance cache notification fanout, and completions capability.                                                                                                                                                        |           |      |
| TASK-051 | Add or update transport tests for DELETE pre-validation, unknown-session DELETE, stateless DELETE parity, concurrent capacity cap, idle TTL sweep, HTTP close with keep-alive socket, Host-validation ordering, and stdio non-regression.                                        |           |      |
| TASK-052 | Run `npm run format`.                                                                                                                                                                                                                                                            |           |      |
| TASK-053 | Run `npm run lint`.                                                                                                                                                                                                                                                              |           |      |
| TASK-054 | Run `npm run type-check`.                                                                                                                                                                                                                                                        |           |      |
| TASK-055 | Run `npm run test`.                                                                                                                                                                                                                                                              |           |      |

## 3. Alternatives

- **ALT-001**: Add `resources.subscribe` and emit `notifications/resources/updated` for detail URIs. Rejected for this plan because the server currently has no subscription registry; poll-only detail reads with list-changed notifications are lower risk.
- **ALT-002**: Rename `cacheStatus.fresh` to `cacheStatus.active`. Rejected because keeping `fresh` and correcting its semantics avoids public resource output churn.
- **ALT-003**: Keep the module-level `workspaceCacheManager` and partition by roots key internally. Rejected because lifecycle cleanup would still leak across `createServerInstance()` boundaries.
- **ALT-004**: Split `memory` into multiple tools to get action-specific annotations. Rejected because it changes the public tool surface.
- **ALT-005**: Keep throwing `validateStructuredContent` and rely on outer tool-call error handling. Rejected because raw schema detail can leak to clients and tool context is lost.
- **ALT-006**: Use a flat `MemoryInputSchema` with `.superRefine` only. Rejected because discriminated unions better represent the public JSON Schema contract.
- **ALT-007**: Reject stateful capacity overflow with `503`. Rejected because the existing behavior is LRU eviction up to `maxSessions`.
- **ALT-008**: Declare additional capabilities beyond `completions`. Rejected because only `completions` is known to be implemented already.

## 4. Dependencies

- **DEP-001**: Node.js `>=24` for `http.Server.closeIdleConnections()` and `http.Server.closeAllConnections()`.
- **DEP-002**: `@modelcontextprotocol/server` `2.0.0-alpha.2` for `McpServer`, `CallToolResult`, task queues, and capability declarations.
- **DEP-003**: `@modelcontextprotocol/node` `2.0.0-alpha.2` for `NodeStreamableHTTPServerTransport`.
- **DEP-004**: `@modelcontextprotocol/express` `2.0.0-alpha.2` for Express MCP app integration.
- **DEP-005**: `@google/genai` `^1.50.1` for Gemini cache operations and structured SDK error fields.
- **DEP-006**: `zod` `^4` for `z.discriminatedUnion`, `z.literal`, `z.strictObject`, and `z.prettifyError`.
- **DEP-007**: Existing local helpers: `logger`, `AppError`, `sendResourceChangedForServer`, `buildServerRootsFetcher`, `createAsyncLock`, `buildBaseStructuredOutput`, and `registerTaskTool`.

## 5. Files

- **FILE-001**: `src/transport.ts` - DELETE pre-validation, reservation capacity guard, idle TTL sweep, and HTTP close draining.
- **FILE-002**: `src/lib/task-utils.ts` - destructive annotation constant.
- **FILE-003**: `src/lib/response.ts` - safe structured-content validation.
- **FILE-004**: `src/schemas/outputs.ts` - output description correction and `AskOutputSchema` removal.
- **FILE-005**: `src/schemas/inputs.ts` - `MemoryInputSchema` discriminated union.
- **FILE-006**: `src/schemas/validators.ts` - remove or narrow flat memory validation.
- **FILE-007**: `src/tools/memory.ts` - destructive annotations, discriminated-union handling, cache ownership cleanup, injected workspace manager, error mapping, and session-resource tuple refactor.
- **FILE-008**: `src/tools/chat.ts` - safe structured-content validation and injected workspace manager.
- **FILE-009**: `src/tools/analyze.ts` - safe structured-content validation.
- **FILE-010**: `src/tools/research.ts` - safe structured-content validation.
- **FILE-011**: `src/tools/review.ts` - safe structured-content validation.
- **FILE-012**: `src/sessions.ts` - `replaceSession` preservation, append notification removal, and `AppError` collision.
- **FILE-013**: `src/lib/workspace-context.ts` - manager factory, close lifecycle, empty-name delete guard, and empty roots-key warning.
- **FILE-014**: `src/resources.ts` - injected workspace manager, single-snapshot session resources, and accurate `cacheStatus.fresh`.
- **FILE-015**: `src/server.ts` - per-server workspace manager, per-instance cache notifications, completions capability, import cleanup, and exported `SERVER_INSTRUCTIONS`.
- **FILE-016**: `__tests__/transport.test.ts`, `__tests__/transport-stdio.test.ts`, `__tests__/transport-host-validation.test.ts` - transport regression coverage.
- **FILE-017**: `__tests__/schemas/public-contract.test.ts`, `__tests__/schemas/inputs.test.ts`, `__tests__/schemas/outputs.test.ts`, `__tests__/contract-surface.test.ts` - schema and contract coverage.
- **FILE-018**: `__tests__/lib/response.test.ts`, `__tests__/lib/workspace-context.test.ts`, `__tests__/sessions.test.ts`, `__tests__/resources.test.ts`, `__tests__/tools/memory.test.ts`, `__tests__/tools/registration.test.ts`, `__tests__/mcp-tools.e2e.test.ts` - state, resource, and tool coverage.
- **FILE-019**: `__tests__/server-notifications.test.ts` and `__tests__/server-capabilities.test.ts` - new or extended server behavior coverage.

## 6. Testing

- **TEST-001**: Stateful `DELETE /mcp` without `mcp-session-id` returns `400` and does not allocate a stateful pair in Node and Web-Standard transports.
- **TEST-002**: Stateful `DELETE /mcp` with an unknown `mcp-session-id` returns `404` and does not allocate a stateful pair.
- **TEST-003**: Stateless `DELETE /mcp` behavior remains unchanged.
- **TEST-004**: Concurrent first-contact requests never make `statefulPairs.size` exceed `maxSessions`.
- **TEST-005**: Idle sweep evicts expired stateful pairs without request traffic.
- **TEST-006**: `HttpTransportResult.close()` resolves within 1 second with a held keep-alive socket.
- **TEST-007**: Disallowed Host on DELETE without session id returns `403`, not `400`.
- **TEST-008**: `memory` registration exposes destructive annotations.
- **TEST-009**: `ReviewOutputSchema.empty` has the corrected description.
- **TEST-010**: `safeValidateStructuredContent` returns a generic tool error and logs Zod detail server-side.
- **TEST-011**: `AskOutputSchema` is not exported from `src/schemas/outputs.ts`.
- **TEST-012**: `MemoryInputSchema` accepts all valid action shapes and rejects missing action-required fields.
- **TEST-013**: Cache cleanup skips unowned display names, deletes only `gemini-assistant/` owned matching caches, and excludes `keepName`.
- **TEST-014**: `replaceSession` preserves transcript and events and emits only a detail-scoped change event.
- **TEST-015**: Transcript and event append paths no longer invoke subscribers with dead-end detail-only notifications.
- **TEST-016**: Two `WorkspaceCacheManagerImpl` instances do not invalidate each other.
- **TEST-017**: `WorkspaceCacheManagerImpl.close()` drains in-flight creation and invalidates local state.
- **TEST-018**: `createCacheFromContext` never calls `caches.delete` with an empty name.
- **TEST-019**: Session resource list callbacks call `listSessionEntries()` exactly once per request.
- **TEST-020**: `discover://context` exposes `cacheStatus.fresh` as `true` only within TTL.
- **TEST-021**: `handleCachesGet` maps structured SDK 404/NOT_FOUND errors to the expected tool error.
- **TEST-022**: `setSession` collision throws `AppError`.
- **TEST-023**: `SERVER_INSTRUCTIONS` includes every `PUBLIC_TOOL_NAMES` entry and both discovery resource URIs.
- **TEST-024**: One cache change fans out exactly once per connected server instance.
- **TEST-025**: `createServerInstance()` advertises `completions`.
- **TEST-026**: `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test` all pass.

## 7. Risks & Assumptions

- **RISK-001**: Tightening `MemoryInputSchema` may reject clients that relied on loose flat payloads. Mitigation: preserve all valid tested payloads and document new invalid cases through contract tests.
- **RISK-002**: Marking `memory` as destructive may trigger confirmation UX for read-only memory actions. Accepted because MCP annotations are per tool and worst-case side effects include deletion.
- **RISK-003**: Prefixing cleanup-owned display names may affect users who inspect raw Gemini cache display names. Mitigation: only cleanup-owned cache names use `gemini-assistant/`; structured tool output preserves current user-facing values where possible.
- **RISK-004**: Per-server workspace managers may create more Gemini caches under many concurrent server instances. Mitigation: this is required for lifecycle isolation; shared keyed managers can be considered later.
- **RISK-005**: Removing append detail notifications may affect clients that accidentally relied on them. Mitigation: the server never advertised `resources.subscribe`; clients should re-read after list changes or poll detail resources.
- **RISK-006**: `closeAllConnections()` can truncate stale SSE/keep-alive sockets. Mitigation: it runs after managed pairs and servers are closed.
- **RISK-007**: Reservation accounting in transport capacity control can leak if a future path bypasses finalization. Mitigation: decrement in `finally` with tests covering failed creation.
- **ASSUMPTION-001**: Node runtime is `>=24` as declared in `package.json`.
- **ASSUMPTION-002**: Existing MCP SDK v2 alpha supports the `completions` capability field.
- **ASSUMPTION-003**: `WorkspaceCacheManagerImpl` has exactly one in-flight cache creation side effect to drain on close.
- **ASSUMPTION-004**: Gemini cache list results include `displayName`, as current cleanup logic already assumes.
- **ASSUMPTION-005**: Current tests can inspect capabilities through the installed SDK surface or through a lightweight exported helper if direct introspection is unavailable.

## 8. Related Specifications / Further Reading

- [docs/plan/bug-transport-host-cors-hardening-1.md](bug-transport-host-cors-hardening-1.md)
- [docs/plan/bug-transport-webstandard-cors-1.md](bug-transport-webstandard-cors-1.md)
- [docs/plan/bug-tool-contract-review-2.md](bug-tool-contract-review-2.md)
- [docs/plan/bug-resource-prompt-provisioning-1.md](bug-resource-prompt-provisioning-1.md)
- [AGENTS.md](../../AGENTS.md)
- MCP TypeScript SDK v2 capability, tool, resource, and transport references.
