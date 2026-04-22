---
goal: Harden notifications, progress, and task-correlation semantics in the gemini-assistant MCP server
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [bug, architecture, mcp, notifications, progress, tasks, transport]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan remediates five must-fix defects uncovered by a notifications/progress audit of the MCP server. The defects span channel overloading (`notifications/message` used to carry streamed tool output), incorrect `list_changed` emission on in-place updates, unsafe `resources/updated` fan-out without subscription tracking, missing `related-task` correlation on progress notifications, and cross-session leakage of a per-session `discover://context` resource. Each fix is localized, independently verifiable, and covered by contract-level tests.

## 1. Requirements & Constraints

- **REQ-001**: Progress notifications MUST be emitted only when `ctx.mcpReq._meta?.progressToken` is defined.
- **REQ-002**: `notifications/message` MUST carry log/diagnostic content only, never streaming tool output or task data.
- **REQ-003**: `notifications/resources/list_changed` MUST be emitted only when the resource collection membership actually changes.
- **REQ-004**: `notifications/resources/updated` MUST NOT be broadcast to servers/clients whose session did not trigger the mutation unless the resource is process-global AND session-independent.
- **REQ-005**: Declared capabilities MUST match implemented handlers. If `resources.subscribe === true` is advertised, the server MUST implement `resources/subscribe` and `resources/unsubscribe`; otherwise it MUST NOT advertise `subscribe`.
- **REQ-006**: `notifications/progress` emitted while a task context is active MUST carry `_meta["io.modelcontextprotocol/related-task"] = { taskId }`.
- **SEC-001**: No diagnostics may be written to `stdout` under stdio transport (already enforced; regression tests required).
- **CON-001**: Public wire-format changes must remain backward compatible with existing MCP clients — only ADD `_meta.related-task`, do not rename or remove fields.
- **CON-002**: All changes must pass `npm run lint`, `npm run type-check`, and `npm run test` with zero regressions.
- **GUD-001**: Follow the existing progress throttle + terminal-force semantics; do not change throttle intervals.
- **PAT-001**: Use `withRelatedTaskMeta` / `RELATED_TASK_META_KEY` from `src/lib/response.ts` for all related-task metadata wiring.

## 2. Implementation Steps

### Implementation Phase 1 — Channel separation (M1)

- GOAL-001: Remove `notifications/message` overloading for streamed tool text. The MCP logging channel must not carry model output.

| Task     | Description                                                                                                                                                                                                                                                                                                | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/lib/streaming.ts`, delete the body of `enqueueStreamText` (lines ~470–498). Make it a no-op that returns immediately. Remove the now-unused `QueuedMessage` import if no other reference exists in the file.                                                                                       | Yes       | 2026-04-22 |
| TASK-002 | Remove the call site `await enqueueStreamText(ctx, getTaskQueueContext(ctx), partText);` inside `handleTextPart` if the no-op stub is also removed; otherwise keep the call so the call graph is preserved. Prefer keeping the stub to minimize diff risk.                                                 | Yes       | 2026-04-22 |
| TASK-003 | Update `__tests__/lib/streaming.test.ts` test "queues streaming text to task queue" to assert `queued.length === 0` and that no notification with `method === 'notifications/message'` is produced for a streaming tool call. Rename the test to "does not enqueue streaming text on the logging channel". | Yes       | 2026-04-22 |
| TASK-004 | Add a new assertion in the same file: for the failure-path test ("logs queue enqueue failures without failing the stream"), assert the log-calls array remains empty (no dropped-chunk warning is needed because no enqueue is attempted).                                                                 | Yes       | 2026-04-22 |

### Implementation Phase 2 — `list_changed` precision (M2)

- GOAL-002: Fire `resources/list_changed` only on true collection-membership change.

| Task     | Description                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-005 | In `src/sessions.ts`, change `replaceSession` (≈line 244) to call `this.notifyChange([id], false)` instead of `true`. Update the inline JSDoc/comment to record that replacement keeps membership constant.                                                                             | Yes       | 2026-04-22 |
| TASK-006 | In `__tests__/sessions.test.ts`, add a test: subscribe to change events, call `store.setSession('a', chatA)`, then `store.replaceSession('a', chatB)`. Assert exactly one event with `listChanged === true` (setSession) and exactly one with `listChanged === false` (replaceSession). | Yes       | 2026-04-22 |

### Implementation Phase 3 — Subscription semantics (M3)

- GOAL-003: Resolve the capability/handler mismatch for `resources.subscribe`.

| Task     | Description                                                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-007 | In `src/server.ts` change the capability declaration to `resources: { listChanged: true }` (remove `subscribe: true`).                                                                                                                                                                                                  | Yes       | 2026-04-22 |
| TASK-008 | In `src/server.ts` `sendResourceChangedForServer`, keep the `listUri` branch (collection `list_changed` + single `resources/updated` on the collection) and REMOVE the per-detail `sendResourceUpdated` loop. Add a short comment: "Per-URI updates require subscribe/unsubscribe tracking; not currently implemented." | Yes       | 2026-04-22 |
| TASK-009 | Add contract test in `__tests__/contract-surface.test.ts`: read the server's declared capabilities from `initialize`, and if `capabilities.resources?.subscribe === true`, assert the server implements `resources/subscribe` (send request, expect no `MethodNotFound`).                                               | Yes       | 2026-04-22 |
| TASK-010 | Adjust `__tests__/notifications.e2e.test.ts` assertions that currently require per-session-detail `resources/updated` URIs (transcript/events/detail). The collection-level `memory://sessions` update plus `list_changed` remains asserted; per-detail updates are removed from the expected set.                      | Yes       | 2026-04-22 |

### Implementation Phase 4 — Related-task correlation on progress (M4)

- GOAL-004: Tag all task-bound `notifications/progress` with `_meta["io.modelcontextprotocol/related-task"]`.

| Task     | Description                                                                                                                                                                                                                                                                          | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-011 | In `src/lib/progress.ts`, import `RELATED_TASK_META_KEY` from `./response.js`. Extend `buildProgressNotification` with an optional `taskId?: string` parameter that, when present, adds `_meta: { [RELATED_TASK_META_KEY]: { taskId } }` to `params`.                                | Yes       | 2026-04-22 |
| TASK-012 | In `src/lib/progress.ts`, in `sendProgress`, pass `ctx.task?.id` to `buildProgressNotification`.                                                                                                                                                                                     | Yes       | 2026-04-22 |
| TASK-013 | Extend `__tests__/lib/errors.test.ts` (or its shared `makeMockContext`) to support `task: { id }`. Add a test "progress carries related-task metadata when ctx.task.id is set".                                                                                                      | Yes       | 2026-04-22 |
| TASK-014 | Add an e2e test in `__tests__/tasks.e2e.test.ts`: invoke a task-augmented tool with `_meta.progressToken`, capture notifications, assert every `notifications/progress` for that call carries `_meta["io.modelcontextprotocol/related-task"].taskId` equal to the created task's id. | Yes       | 2026-04-22 |

### Implementation Phase 5 — Cross-session leakage of `discover://context` (M5)

- GOAL-005: Stop fanning out `discover://context` and session-scoped workspace/cache state to non-originating servers.

| Task     | Description                                                                                                                                                                                                                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-015 | In `src/server.ts`, rewrite `handleCacheChange` to emit ONLY `sendResourceChanged(MEMORY_CACHES_URI, detailUris)`. Remove the `DISCOVER_CONTEXT_URI` broadcast.                                                                                                                                                                            | Yes       | 2026-04-22 |
| TASK-016 | In `src/server.ts`, rewrite `handleWorkspaceCacheChange` to emit a single `sendResourceChanged(undefined, [MEMORY_WORKSPACE_CONTEXT_URI, MEMORY_WORKSPACE_CACHE_URI])`. Remove the `DISCOVER_CONTEXT_URI` broadcast.                                                                                                                       | Yes       | 2026-04-22 |
| TASK-017 | Inside `createServerInstance`, in the session-change subscriber (already bound to the originating `server`), continue to call `sendResourceChangedForServer(server, undefined, [DISCOVER_CONTEXT_URI])` only when `listChanged` is true. Keep this as the sole path that updates `discover://context`, so the update is scoped per-server. | Yes       | 2026-04-22 |
| TASK-018 | Add a test in `__tests__/notifications.e2e.test.ts`: create two concurrent harnesses against the same process. Trigger a session mutation in harness A. Flush notifications. Assert harness B observed NO `notifications/resources/updated` for `discover://context`, and NO update for harness-A-specific session URIs.                   | Yes       | 2026-04-22 |

### Implementation Phase 6 — Documentation and verification

- GOAL-006: Lock the new invariants into documentation and run full gates.

| Task     | Description                                                                                                                                                                                                                                                                          | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-019 | Add a short "Notification surface" subsection to `README.md` listing the four notification methods used (`notifications/progress`, `notifications/resources/list_changed`, `notifications/resources/updated`, `notifications/message`) and the emission rules enforced by this plan. | Yes       | 2026-04-22 |
| TASK-020 | Run `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`. All must pass with zero regressions.                                                                                                                                                                     | Yes       | 2026-04-22 |
| TASK-021 | Update `docs/plan/bug-notifications-progress-hardening-1.md` status badge to `Completed` once all tasks above are ticked.                                                                                                                                                            | Yes       | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Implement a full `resources/subscribe` + `resources/unsubscribe` handler with per-client subscription tracking instead of removing the capability (Phase 3). Rejected for v1 scope: larger surface, additional state, and no consumer of the feature yet. Revisit when a client requires it.
- **ALT-002**: Move streamed tool text into a proprietary `notifications/tasks/stream` method instead of dropping it (Phase 1). Rejected: `tasks/result` already returns the terminal `CallToolResult`; partial streaming was not part of the public contract.
- **ALT-003**: Bridge `notifications/progress` through the task-message queue so the SDK injects `related-task` meta automatically (Phase 4). Rejected: progress is rate-limited and transport-near; direct `ctx.mcpReq.notify` with explicit meta keeps semantics clear and avoids queue-ordering coupling.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` alpha — `RELATED_TASK_META_KEY` must remain exported and the SDK must accept arbitrary `_meta` entries on `notifications/progress.params`. Verify the exported symbol is still available before TASK-011.
- **DEP-002**: `@modelcontextprotocol/node` and `@modelcontextprotocol/express` — no version change required.
- **DEP-003**: Existing `InMemoryEventStore` per-session isolation (already verified). No dependency change.

## 5. Files

- **FILE-001**: `src/lib/streaming.ts` — neutralize `enqueueStreamText`.
- **FILE-002**: `src/sessions.ts` — correct `replaceSession` notification flag.
- **FILE-003**: `src/server.ts` — remove `subscribe: true`, drop per-detail `sendResourceUpdated`, scope `discover://context` updates to originating server.
- **FILE-004**: `src/lib/progress.ts` — attach `related-task` meta to progress notifications.
- **FILE-005**: `__tests__/lib/streaming.test.ts` — updated streaming queue assertions.
- **FILE-006**: `__tests__/sessions.test.ts` — `replaceSession` notification test.
- **FILE-007**: `__tests__/notifications.e2e.test.ts` — cross-session leakage + trimmed per-detail expectations.
- **FILE-008**: `__tests__/contract-surface.test.ts` — capability/handler parity check.
- **FILE-009**: `__tests__/lib/errors.test.ts` — related-task meta unit test.
- **FILE-010**: `__tests__/tasks.e2e.test.ts` — related-task meta e2e test.
- **FILE-011**: `README.md` — documented notification surface.

## 6. Testing

- **TEST-001**: Streaming does not enqueue `notifications/message` for model output (unit, `streaming.test.ts`).
- **TEST-002**: `replaceSession` emits `listChanged=false` with populated detail URIs (unit, `sessions.test.ts`).
- **TEST-003**: `resources.subscribe` capability is declared iff `resources/subscribe` handler exists (contract, `contract-surface.test.ts`).
- **TEST-004**: Session mutations no longer produce per-detail `resources/updated` URIs (e2e, `notifications.e2e.test.ts` — adjust existing expectations).
- **TEST-005**: Progress notifications emitted inside a task context carry `_meta["io.modelcontextprotocol/related-task"]` (unit, `errors.test.ts`).
- **TEST-006**: Task-augmented tool call progress correlates to the correct `taskId` (e2e, `tasks.e2e.test.ts`).
- **TEST-007**: `discover://context` update from harness A is not observed by harness B (e2e, `notifications.e2e.test.ts`).
- **TEST-008**: Existing `stdio` cleanliness test still passes (regression, `transport-stdio.test.ts`).
- **TEST-009**: Existing `never emits notifications/progress when the request omits _meta.progressToken` still passes (regression, `notifications.e2e.test.ts`).

## 7. Risks & Assumptions

- **RISK-001**: Removing per-detail `resources/updated` may regress clients that relied on per-resource updates. Mitigation: collection-level `list_changed` remains; clients can re-read the collection. Document explicitly in README.
- **RISK-002**: Dropping streamed `notifications/message` may regress clients that tailed model output over the log channel. Mitigation: not part of the MCP contract; final content is available via `tasks/result` and non-task `CallToolResult`.
- **RISK-003**: SDK alpha may not accept arbitrary `_meta` on `notifications/progress.params`. Mitigation: guard behind a single helper and a unit test; if the SDK rejects, fall back to omitting `_meta` (Phase 4 becomes a no-op without breaking other phases).
- **ASSUMPTION-001**: `ctx.task?.id` is populated for all task-augmented invocations before `sendProgress` fires (verified in `task-utils.ts createToolTaskHandlers`).
- **ASSUMPTION-002**: `InMemoryEventStore` is per-`ManagedPair` and therefore per-session; Last-Event-Id replay cannot cross sessions. Verified in `src/transport.ts createManagedPair`.
- **ASSUMPTION-003**: No external tooling depends on `replaceSession` firing `list_changed`.

## 8. Related Specifications / Further Reading

- [Model Context Protocol — Notifications](https://modelcontextprotocol.io/specification/notifications)
- [MCP TypeScript SDK v2 — Tasks & Related-Task metadata](https://github.com/modelcontextprotocol/typescript-sdk)
- Internal: `docs/plan/refactor-progress-task-status-1.md`
- Internal: `docs/plan/bug-observability-contract-1.md`
- Internal: `docs/plan/feature-task-contract-hardening-1.md`
