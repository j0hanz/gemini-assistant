---
goal: Harden MCP task contract — cancellation coverage, TTL assertions, related-task metadata propagation
version: 1.1
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [feature, bug, architecture, testing]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan has been completed. The implemented work covers three outcomes from `.github/report.md`: (1) end-to-end coverage for `tasks/cancel`, (2) explicit TTL default/override assertions on the public task surface, and (3) protocol-level `io.modelcontextprotocol/related-task` metadata propagation on task-associated `resource_link` content emitted by task-aware chat and memory flows.

Implementation result summary: runtime verification confirmed that `@modelcontextprotocol/server@2.0.0-alpha.2` preserves item-level `_meta` on `resource_link` content, so the item-level attachment strategy shipped as planned. The cancellation regression test also confirmed the SDK's current behavior: cancelled tasks report `status = cancelled` via `tasks/get`, and `tasks/result` returns a JSON-RPC error because no terminal result is stored after cancellation.

Out of scope for this completed plan: queued-message regression coverage (no producers currently exist) and HTTP `Last-Event-Id` replay tests (tracked separately).

## 1. Requirements & Constraints

- **REQ-001**: `tasks/cancel` must be exercised end-to-end against a deferred stream; assertions must cover post-cancel `tasks/get` status and `tasks/result` behavior.
- **REQ-002**: TTL behavior must be asserted: default `300_000` ms when `ttl` is omitted; exact forward of `taskTtl(requestedTtl)` when supplied.
- **REQ-003**: Task-associated `resource_link` content items emitted from task-aware tools must carry `_meta["io.modelcontextprotocol/related-task"] = { taskId }` when produced inside a task context.
- **REQ-004**: Metadata propagation must be centralized in a single helper in `src/lib/response.ts` reusable by all tools (not chat-only).
- **SEC-001**: No new user input is accepted; no new external calls are introduced.
- **CON-001**: SDK pin `@modelcontextprotocol/server@2.0.0-alpha.2` must not be upgraded as part of this plan.
- **CON-002**: Implementation must not change terminal-status mapping, TTL defaults, or queue semantics.
- **CON-003**: SDK must preserve `_meta` on individual `CallToolResult.content[*]` items at runtime; if it strips them, the metadata must instead be attached to the top-level `CallToolResult._meta` and tests adjusted.
- **GUD-001**: Follow AGENTS.md safety checklist — run format, lint, type-check, test.
- **PAT-001**: Use conditional spread (`...(taskId ? { _meta: {...} } : {})`) to respect `exactOptionalPropertyTypes`.

## 2. Implementation Steps

### Implementation Phase 1 — SDK capability verification

- GOAL-001: Empirically confirm whether `@modelcontextprotocol/server@2.0.0-alpha.2` preserves `_meta` on `resource_link` content items when serialized through `tools/call` and retrieved via `tasks/result`.

| Task     | Description                                                                                                                                                                           | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Verify item-level `_meta` preservation empirically through the implemented task regression path by asserting round-tripped `resource_link` metadata in `__tests__/tasks.e2e.test.ts`. | ✅        | 2026-04-22 |
| TASK-002 | Record outcome: item-level `_meta` survived at runtime, so Phase 3 shipped the item-level attachment path with no fallback required.                                                  | ✅        | 2026-04-22 |
| TASK-003 | Remove the need for a standalone probe by folding the verification into permanent regression coverage instead of leaving exploratory-only code in the repo.                           | ✅        | 2026-04-22 |

### Implementation Phase 2 — Cancellation and TTL test coverage

- GOAL-002: Add regression tests that lock in current cancellation and TTL behavior without changing production code.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-004 | In `__tests__/tasks.e2e.test.ts`, add test `cancels an in-flight task and leaves no terminal task result stored`: use `createDeferredStream` with a deferred `research` task, call `client.request('tasks/cancel', { taskId })`, assert `tasks/get` status is `cancelled`, then assert `tasks/result` fails with `has no result stored` after releasing the deferred stream. | ✅        | 2026-04-22 |
| TASK-005 | In `__tests__/tasks.e2e.test.ts`, add test `defaults task ttl to 300000 when omitted`: create task without `ttl`, fetch via `tasks/get`, and assert returned ttl equals `300_000`.                                                                                                                                                                                           | ✅        | 2026-04-22 |
| TASK-006 | In `__tests__/tasks.e2e.test.ts`, add test `forwards explicit ttl unchanged`: create task with `ttl: 60_000`, fetch via `tasks/get`, and assert returned ttl equals `60_000`.                                                                                                                                                                                                | ✅        | 2026-04-22 |
| TASK-007 | Prefer the public surface first. This fallback was not needed because the SDK exposes `ttl` on `tasks/get`, and the shipped tests assert it directly.                                                                                                                                                                                                                        | ✅        | 2026-04-22 |

### Implementation Phase 3 — Related-task metadata helper and integration

- GOAL-003: Introduce `withRelatedTaskMeta` helper in `src/lib/response.ts` and apply it at every existing `createResourceLink` call site that runs inside a task-aware tool context.

| Task     | Description                                                                                                                                                                                                             | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-008 | In `src/lib/response.ts`, export `RELATED_TASK_META_KEY` via the SDK constant and add `withRelatedTaskMeta(...)` using the `exactOptionalPropertyTypes`-safe conditional spread pattern.                                | ✅        | 2026-04-22 |
| TASK-009 | In `src/tools/chat.ts`, change `appendSessionResource(result, sessionId)` to accept `taskId?: string` and wrap both session resource links in `withRelatedTaskMeta(..., taskId)`. Pass `ctx.task?.id` at the call site. | ✅        | 2026-04-22 |
| TASK-010 | In `src/tools/memory.ts`, add a shared `taskResourceLink(...)` helper, thread `ctx.task?.id` through task-capable handlers, and wrap each task-reachable `createResourceLink(...)` result with related-task metadata.   | ✅        | 2026-04-22 |
| TASK-011 | Audit the remaining `createResourceLink(` call sites in task-capable tools. No additional task-reachable call sites required changes outside chat and memory.                                                           | ✅        | 2026-04-22 |
| TASK-012 | The fallback was not needed because Phase 1 confirmed item-level `_meta` is preserved at runtime.                                                                                                                       | ✅        | 2026-04-22 |

### Implementation Phase 4 — Metadata propagation regression test

- GOAL-004: Lock in the metadata contract with a dedicated e2e test.

| Task     | Description                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-013 | In `__tests__/tasks.e2e.test.ts`, add helper `getRelatedTaskId(result)` that scans `content[*]` for `resource_link` entries and returns `_meta["io.modelcontextprotocol/related-task"].taskId`.                                              | ✅        | 2026-04-22 |
| TASK-014 | Add test `preserves related-task metadata on task-associated session resource links`: queue a chat stream via `env.queueGenerator`, create chat task, release stream, call `tasks/result`, and assert `getRelatedTaskId(result) === taskId`. | ✅        | 2026-04-22 |
| TASK-015 | Add analogous test for the `memory` tool to prove the propagation generalizes beyond chat.                                                                                                                                                   | ✅        | 2026-04-22 |

### Implementation Phase 5 — Validation gate

- GOAL-005: Ensure repo-wide safety checks pass.

| Task     | Description                                                                                                 | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-016 | Run `npm run format`.                                                                                       | ✅        | 2026-04-22 |
| TASK-017 | Run `npm run lint`.                                                                                         | ✅        | 2026-04-22 |
| TASK-018 | Run `npm run type-check`.                                                                                   | ✅        | 2026-04-22 |
| TASK-019 | Run `npm run test`; confirm all suites pass including the new task lifecycle and metadata regression tests. | ✅        | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Attach related-task metadata only to top-level `CallToolResult._meta` from the outset. Rejected as default because report recommends per-content-item correlation; kept as Phase 1 fallback.
- **ALT-002**: Skip helper, inline `_meta` object at each call site. Rejected: duplicates a string constant across ~12 sites and guarantees future drift.
- **ALT-003**: Emit metadata unconditionally (even outside task context). Rejected: semantically incorrect — the MCP spec key implies an associated task exists.
- **ALT-004**: Ship cancellation and TTL tests only, defer metadata work. Rejected: metadata gap is the one must-fix identified in the report; deferring leaves a spec-level correlation signal missing.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server@2.0.0-alpha.2` — runtime preservation of content-item `_meta` was verified in Phase 1 and matched the shipped item-level metadata strategy.
- **DEP-002**: Existing test utilities `JsonRpcTestClient`, `createDeferredStream`, `makeChunk`, `env.queueGenerator` in the harness under `__tests__/`.
- **DEP-003**: `src/lib/task-utils.ts` late-terminal suppression guard (unchanged, but required for cancellation test correctness).

## 5. Files

- **FILE-001**: `src/lib/response.ts` — add `RELATED_TASK_META_KEY`, `withRelatedTaskMeta`.
- **FILE-002**: `src/tools/chat.ts` — wrap `appendSessionResource` emissions, thread `ctx.task?.id`.
- **FILE-003**: `src/tools/memory.ts` — wrap all `createResourceLink` emissions inside task-capable handlers.
- **FILE-004**: `src/tools/research.ts`, `src/tools/analyze.ts`, `src/tools/review.ts` — audit and wrap if emitting resource links (verify existence during TASK-011).
- **FILE-005**: `__tests__/tasks.e2e.test.ts` — add cancel, TTL default, TTL forward, metadata propagation (chat + memory) tests; add `getRelatedTaskId` helper.
- **FILE-006**: `.github/report.md` — no changes; source document only.

## 6. Testing

- **TEST-001**: `tasks/cancel` end-to-end on a deferred stream; asserts `cancelled` status via `tasks/get`, confirms suppression of late terminal write, and confirms `tasks/result` returns `has no result stored` for the cancelled task.
- **TEST-002**: Default TTL equals `300_000` ms when omitted.
- **TEST-003**: Explicit TTL forwarded unchanged.
- **TEST-004**: Chat session `resource_link` carries `_meta["io.modelcontextprotocol/related-task"].taskId === taskId` via `tasks/result`.
- **TEST-005**: `memory` tool resource link carries identical correlation metadata inside a task context.
- **TEST-006**: Full `npm run test` suite green.

## 7. Risks & Assumptions

- **RISK-001**: SDK alpha strips unknown `_meta` on content items. Mitigation completed: runtime verification plus permanent regression coverage confirmed that item-level `_meta` survives in this pinned SDK version.
- **RISK-002**: `tasks/get` response in this SDK version does not expose ttl publicly, forcing indirect assertion via store spy (TASK-007). This did not materialize; the public surface exposes `ttl` and the tests assert it directly.
- **RISK-003**: Memory tool resource-link sites outside task-capable handlers could be wrapped accidentally, producing spurious metadata. Mitigation: audit call chain per site in TASK-010 before wrapping.
- **ASSUMPTION-001**: `ctx.task?.id` is the authoritative task identifier reachable from tool handlers (confirmed in `src/lib/task-utils.ts`).
- **ASSUMPTION-002**: Existing `runToolAsTask` cancelled-status guard is correct; no production code changes needed for cancel semantics.
- **ASSUMPTION-003**: No tool currently produces queued messages via `ctx.task.queue`; confirmed by repo grep. If this changes, a new plan must cover queued-vs-terminal separation.

## 8. Related Specifications / Further Reading

- `.github/report.md` — source review document.
- `src/lib/task-utils.ts` — task lifecycle, TTL default, cancellation guard.
- `src/server.ts` — server instance wiring, task capability declaration.
- `__tests__/tasks.e2e.test.ts` — existing task end-to-end coverage.
- MCP spec key: `io.modelcontextprotocol/related-task`.
