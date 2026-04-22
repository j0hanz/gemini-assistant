---
goal: Stop progress and task-status notifications from leaking after a task is cancelled
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [bug, mcp, tasks, cancellation, progress, notifications]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan remediates a task-cancellation defect identified by the MCP task architecture review in `.github/report.md`. When a client cancels an in-flight task via `tasks/cancel`, the cancelled work may continue to emit `notifications/progress` and attempt `updateTaskStatus('working', ...)` calls until the underlying tool work finishes. Terminal result storage is already suppressed by `runToolAsTask()`, so no state is corrupted, but the side-channel updates make cancelled tasks look live to clients. The fix adds a task-cancellation guard inside `sendProgress()` that mirrors the existing `isTaskCancelled()` pattern in `src/lib/task-utils.ts`, and backs it with a regression test in `__tests__/tasks.e2e.test.ts`.

## 1. Requirements & Constraints

- **REQ-001**: After `tasks/cancel` moves a task to `cancelled`, no further `notifications/progress` MUST be emitted for that task's `progressToken`.
- **REQ-002**: After cancellation, no further `updateTaskStatus(taskId, 'working', ...)` calls MUST be issued through `bridgeProgressToTask`.
- **REQ-003**: Non-task progress (no `ctx.task`) MUST continue to emit normally — the guard only applies when `ctx.task?.id` is defined.
- **REQ-004**: Terminal progress for non-cancelled tasks MUST continue to force a terminal status message through `bridgeProgressToTask`.
- **CON-001**: The guard MUST NOT introduce a task-store read when no task context is attached (zero overhead for non-task tool calls).
- **CON-002**: No public wire-format or schema change. Backward compatible with current MCP clients.
- **CON-003**: All changes must pass `npm run lint`, `npm run type-check`, `npm run build`, and `npm run test` with zero regressions.
- **GUD-001**: Reuse the existing `getTask().status === 'cancelled'` check pattern from `src/lib/task-utils.ts` (`isTaskCancelled`) rather than introducing a new cancellation signal.
- **GUD-002**: Swallow task-store read errors defensively — a missing or expired task must not convert into a thrown progress error.
- **PAT-001**: Keep the guard inside `src/lib/progress.ts` so every call site (`sendProgress`, `reportCompletion`, `reportFailure`) is covered without per-tool changes.

## 2. Implementation Steps

### Implementation Phase 1 — Cancellation-aware progress guard

- GOAL-001: Suppress progress and bridged task-status updates for cancelled tasks in `src/lib/progress.ts`.

| Task     | Description                                                                                                                                                                                                                                                                                                                        | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/lib/progress.ts`, add a private `async function isCancelledTaskContext(ctx: ServerContext): Promise<boolean>` that returns `false` when `ctx.task?.id` is undefined, otherwise calls `ctx.task.store.getTask(ctx.task.id)` inside a try/catch and returns `current.status === 'cancelled'`. Catch-all must return `false`. | Yes       | 2026-04-22 |
| TASK-002 | In `sendProgress` (src/lib/progress.ts), immediately after the existing `if (ctx.mcpReq.signal.aborted) return;` line, add `if (await isCancelledTaskContext(ctx)) return;` so both the wire notification and the downstream `bridgeProgressMessage(...)` call are skipped for cancelled tasks.                                    | Yes       | 2026-04-22 |
| TASK-003 | Verify `reportCompletion` and `reportFailure` (same file) delegate to `sendProgress` — if so, no additional changes are needed. If either bypasses `sendProgress`, add the same guard at the top of those helpers.                                                                                                                 | Yes       | 2026-04-22 |
| TASK-004 | Confirm that `bridgeProgressToTask` still performs its own `updateTaskStatus` call; because `sendProgress` gates the only entry to `bridgeProgressMessage`, no further change is required inside `bridgeProgressToTask`.                                                                                                           | Yes       | 2026-04-22 |

### Implementation Phase 2 — Regression test coverage

- GOAL-002: Prove that a cancelled task emits zero post-cancel `notifications/progress` carrying its `related-task` metadata.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-005 | In `__tests__/tasks.e2e.test.ts`, add a new `it('does not emit further progress notifications after task cancellation', ...)` block immediately after the existing `cancels an in-flight task and leaves no terminal task result stored` test. Reuse `createHarness`, `createDeferredStream`, `makeChunk`, `FinishReason`, `flushEventLoop`, and `env.queueGenerator`. | Yes       | 2026-04-22 |
| TASK-006 | In the new test, send a `tools/call` request for `research` with `_meta.progressToken = 'cancel-progress-token'` and `task: { ttl: 60_000 }`, extract `taskId` from `response.result.task.taskId`, then call `tasks/cancel`. Snapshot `harness.client.getNotifications().length` as `offsetAfterCancel`.                                                               | Yes       | 2026-04-22 |
| TASK-007 | Release the deferred stream, `await flushEventLoop(4)`, then filter `harness.client.getNotifications().slice(offsetAfterCancel)` for `method === 'notifications/progress'` whose `params._meta['io.modelcontextprotocol/related-task'].taskId === taskId`. Assert the filtered array is empty with a message explaining the leak the test guards against.              | Yes       | 2026-04-22 |
| TASK-008 | Confirm the new test passes locally with `npm run test -- __tests__/tasks.e2e.test.ts`, then run the full `npm run lint`, `npm run type-check`, `npm run build`, and `npm run test` gates.                                                                                                                                                                             | Yes       | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Wire a per-task `AbortController` into `ServerContext.task` and race tool work against it. Rejected — broader surface change, requires SDK-internal coordination, and does not meaningfully improve the observable outcome versus the localized progress guard.
- **ALT-002**: Swallow post-cancel progress at the SDK transport layer. Rejected — the MCP SDK v2 alpha does not expose a supported hook for this; altering SDK internals violates `installTaskSafeToolCallHandler`'s minimal-surface principle.
- **ALT-003**: Cache cancellation state in-memory keyed by `taskId` with an event subscription on the task store. Rejected — the task store already exposes `getTask`, the extra `getTask` round-trip per emission is acceptable because `sendProgress` is already throttled (250 ms for progress, 5 s for bridged status updates).

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server@2.0.0-alpha.2` — `ServerContext.task.store.getTask()` contract must continue returning the latest task status.
- **DEP-002**: Existing `runToolAsTask`/`isTaskCancelled` pattern in `src/lib/task-utils.ts` — new guard uses the same semantics.

## 5. Files

- **FILE-001**: `src/lib/progress.ts` — add `isCancelledTaskContext` helper and insert guard in `sendProgress`.
- **FILE-002**: `__tests__/tasks.e2e.test.ts` — add post-cancel progress regression test.
- **FILE-003**: `.github/report.md` — source report documenting the defect (reference only, no edit required).

## 6. Testing

- **TEST-001**: New e2e test `does not emit further progress notifications after task cancellation` asserts zero post-cancel progress notifications carrying the cancelled task's `related-task` metadata.
- **TEST-002**: Existing `cancels an in-flight task and leaves no terminal task result stored` continues to pass, proving terminal-result behavior is unchanged.
- **TEST-003**: Full `npm run test` suite passes, including `__tests__/lib/streaming.test.ts` and `__tests__/notifications.e2e.test.ts`, confirming no regression in non-cancelled progress paths.
- **TEST-004**: `npm run lint` and `npm run type-check` pass with no new violations.

## 7. Risks & Assumptions

- **RISK-001**: One extra `task.store.getTask` read per `sendProgress` call adds latency. Mitigation: existing progress throttle (250 ms per `progressToken+message` key) bounds call frequency; `InMemoryTaskStore.getTask` is O(1).
- **RISK-002**: A race between `tasks/cancel` updating the store and an in-flight `sendProgress` could still emit one stray notification. Acceptable — the guard is best-effort and fully eliminates post-cancel emissions once the cancellation has landed in the store.
- **RISK-003**: Alternative task stores introduced later (durable/remote) could make `getTask` slow. Mitigation: documented as a known constraint; if adopted, gate behind an in-memory cache.
- **ASSUMPTION-001**: `ctx.task.store.getTask(taskId)` resolves with the current status after `tasks/cancel` completes, as exercised by the existing `latestTask` assertion in the cancellation test.
- **ASSUMPTION-002**: `createDeferredStream`, `flushEventLoop`, `makeChunk`, and `FinishReason` remain exported from the mock Gemini environment and test utils used by `tasks.e2e.test.ts`.

## 8. Related Specifications / Further Reading

- `.github/report.md` — MCP task architecture review (source for this plan).
- `docs/plan/feature-task-contract-hardening-1.md` — prior task-contract hardening plan.
- `docs/plan/bug-notifications-progress-hardening-1.md` — prior progress/notification audit.
- `src/lib/task-utils.ts` — `isTaskCancelled` and `runToolAsTask` reference implementation.
