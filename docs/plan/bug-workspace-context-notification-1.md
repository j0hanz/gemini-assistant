---
goal: Emit resources/updated notification for memory://workspace/context on workspace-cache changes
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [bug, notifications, resources, contract]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

When the workspace cache state changes, the server emits `notifications/resources/updated` for `memory://workspace/cache` and `discover://context`, but not for `memory://workspace/context`. Subscribed clients therefore miss a content-changed signal for the assembled workspace context resource and can serve stale views. This plan addresses the must-fix item from `.github/report.md` with a minimal, regression-tested change.

## 1. Requirements & Constraints

- **REQ-001**: Emit `notifications/resources/updated` for `memory://workspace/context` whenever `handleWorkspaceCacheChange()` fires.
- **REQ-002**: Preserve existing notifications for `memory://workspace/cache` and `discover://context`.
- **REQ-003**: Route the new URI through the existing `sendResourceChanged` / `isKnownResourceUri` filter so it is validated as a known static resource URI.
- **CON-001**: No changes to prompt surface, tool surface, or any public identifier.
- **CON-002**: No new subscribers, emitters, or lifecycle hooks. Reuse `subscribeWorkspaceCacheChange`.
- **CON-003**: Change must be ESM, TypeScript strict, and pass `npm run lint`, `npm run type-check`, `npm run test`.
- **PAT-001**: Follow the existing `handleCacheChange` pattern in `src/server.ts` (list URI + detail URIs via `sendResourceChanged`).
- **GUD-001**: Keep diff minimal — no refactor of unrelated notification logic.

## 2. Implementation Steps

### Implementation Phase 1 — Code fix

- GOAL-001: Add `memory://workspace/context` to the workspace-cache change notification fan-out.

| Task     | Description                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/server.ts`, add `MEMORY_WORKSPACE_CONTEXT_URI` to the import from `./lib/resource-uris.js` (alphabetical order: `DISCOVER_CONTEXT_URI`, `MEMORY_CACHES_URI`, `MEMORY_WORKSPACE_CACHE_URI`, `MEMORY_WORKSPACE_CONTEXT_URI`).                                          | ✅        | 2026-04-22 |
| TASK-002 | In `src/server.ts` `handleWorkspaceCacheChange()`, prepend `sendResourceChanged(undefined, [MEMORY_WORKSPACE_CONTEXT_URI]);` before the existing `MEMORY_WORKSPACE_CACHE_URI` call. Keep `DISCOVER_CONTEXT_URI` call last.                                                   | ✅        | 2026-04-22 |
| TASK-003 | Verify `MEMORY_WORKSPACE_CONTEXT_URI` (`memory://workspace/context`) is recognized by `isKnownResourceUri` via `STATIC_RESOURCE_URIS` — it is already listed in `PUBLIC_RESOURCE_URIS` (`src/public-contract.ts` line 84), so no additional registration change is required. | ✅        | 2026-04-22 |

### Implementation Phase 2 — Regression test

- GOAL-002: Lock in the notification contract so the gap cannot silently reappear.

| Task     | Description                                                                                                                                                                                                                                                                                                         | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-004 | In `__tests__/notifications.e2e.test.ts`, within the test `emits workspace cache resource notifications after workspace-cache creation`, add `assert.ok(updatedUris(notifications).includes('memory://workspace/context'));` immediately after the existing `memory://workspace/cache` assertion (around line 140). | ✅        | 2026-04-22 |
| TASK-005 | Run `npm run test` and confirm the new assertion passes together with all pre-existing suites.                                                                                                                                                                                                                      | ✅        | 2026-04-22 |

### Implementation Phase 3 — Verification

- GOAL-003: Gate merge on repo quality checks.

| Task     | Description               | Completed | Date       |
| -------- | ------------------------- | --------- | ---------- |
| TASK-006 | Run `npm run format`.     | ✅        | 2026-04-22 |
| TASK-007 | Run `npm run lint`.       | ✅        | 2026-04-22 |
| TASK-008 | Run `npm run type-check`. | ✅        | 2026-04-22 |
| TASK-009 | Run `npm run test`.       | ✅        | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Emit the `memory://workspace/context` URI as the `listUri` argument of `sendResourceChanged`. Rejected: the resource is a single fixed URI, not a list; `listUri` semantically triggers `sendResourceListChanged()` which is not appropriate here.
- **ALT-002**: Introduce a dedicated subscriber for workspace-context content changes separate from cache changes. Rejected: workspace-context content is a direct function of workspace-cache state; a second subscriber would duplicate plumbing with no new signal.
- **ALT-003**: Emit the notification from within `assembleWorkspaceContext` / resource handler. Rejected: notifications must be driven by state changes, not by reads.

## 4. Dependencies

- **DEP-001**: Existing export `MEMORY_WORKSPACE_CONTEXT_URI` from `src/lib/resource-uris.ts`.
- **DEP-002**: Existing subscriber `subscribeWorkspaceCacheChange` from `src/lib/workspace-context.ts`.
- **DEP-003**: Existing helper `sendResourceChanged` and `isKnownResourceUri` filter in `src/server.ts`.
- **DEP-004**: Existing test helpers `updatedUris`, `notificationSlice`, `createHarness`, `flushEventLoop` in `__tests__/notifications.e2e.test.ts`.

## 5. Files

- **FILE-001**: `src/server.ts` — add import symbol and one `sendResourceChanged` call in `handleWorkspaceCacheChange`.
- **FILE-002**: `__tests__/notifications.e2e.test.ts` — add one assertion in the workspace-cache notification test.

## 6. Testing

- **TEST-001**: Extend `emits workspace cache resource notifications after workspace-cache creation` in `__tests__/notifications.e2e.test.ts` to assert `memory://workspace/context` appears in `updatedUris(notifications)`.
- **TEST-002**: Full suite `npm run test` passes (all existing session/cache/workspace-cache/progress tests remain green).

## 7. Risks & Assumptions

- **RISK-001**: Duplicate or out-of-order notifications for the workspace resources. Mitigation: reuse single subscription; order is deterministic (context → cache → discover) and all three were already valid emission targets.
- **RISK-002**: `isKnownResourceUri` rejecting the URI if `PUBLIC_RESOURCE_URIS` drift. Mitigation: URI is already in `PUBLIC_RESOURCE_URIS` and is covered by `STATIC_RESOURCE_URIS`.
- **ASSUMPTION-001**: Workspace-cache state transitions are the authoritative signal for workspace-context content changes (confirmed by the current resource handler, which derives content from cache-aware `assembleWorkspaceContext`).
- **ASSUMPTION-002**: No downstream client relies on the _absence_ of this notification.

## 8. Related Specifications / Further Reading

- `.github/report.md` — source review identifying the must-fix gap.
- `src/server.ts` — `handleCacheChange`, `handleWorkspaceCacheChange`, `sendResourceChanged`, `isKnownResourceUri`.
- `src/resources.ts` — `registerWorkspaceResources` registering `memory://workspace/context` with `subscribe: true` capability.
- `src/public-contract.ts` — `PUBLIC_RESOURCE_URIS` declaring `memory://workspace/context` as part of the public contract.
- `__tests__/notifications.e2e.test.ts` — existing notification e2e coverage.
