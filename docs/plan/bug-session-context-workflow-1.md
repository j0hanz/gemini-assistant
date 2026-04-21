---
goal: Fix session, workspace-cache, and event-replay correctness issues in Gemini Assistant
version: 1.0
date_created: 2026-04-21
last_updated: 2026-04-21
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['bug', 'refactor', 'session', 'workspace', 'transport']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan addresses correctness and observability defects identified during review of `src/sessions.ts`, `src/lib/workspace-context.ts`, `src/lib/chat-context.ts`, `src/lib/context-assembler.ts`, and `src/lib/event-store.ts`. The primary goal is to eliminate a cross-workspace cache leak, stop premature TTL eviction of actively-written sessions, make transport event replay deterministic, and reduce unnecessary resource-change notification churn. Secondary goals are to wire the orphan `context-assembler` ranking helper into workspace scanning, remove the upward dependency from `chat-context` to `workspace-context`, and harden `setSession` against accidental history loss.

## 1. Requirements & Constraints

- **REQ-001**: `workspaceCacheManager.getOrCreateCache(roots)` MUST NOT return a cache produced by a different `roots` set, regardless of the 30-second hash-check throttle.
- **REQ-002**: Writing to a session (`appendSessionTranscript`, `appendSessionEvent`) MUST refresh `lastAccess` so the TTL sweep cannot evict an actively-written session.
- **REQ-003**: `SessionStore.getSession(id)` MUST NOT emit a `notifyChange` event on plain reads. Notifications MUST only fire on state-changing operations and the periodic eviction sweep.
- **REQ-004**: `InMemoryEventStore.replayEventsAfter` MUST iterate a stable snapshot of events captured at replay start, so concurrent `storeEvent` calls cannot shift indices during replay.
- **REQ-005**: `SessionStore.setSession(id, chat)` MUST NOT silently discard an existing session's `transcript` and `events`. An overwrite attempt MUST be explicit via a separate API or rejected.
- **REQ-006**: Public tool-surface behavior, MCP contract shape, and existing test assertions MUST remain unchanged except where tests explicitly verify the buggy behavior being fixed.
- **SEC-001**: Cross-workspace cache isolation MUST hold under concurrent stateful transport sessions addressing different roots.
- **CON-001**: No new runtime dependencies. Use only stdlib plus existing project deps.
- **CON-002**: Node.js `>=24` runtime; ESM modules; `exactOptionalPropertyTypes: true` remains enabled.
- **GUD-001**: Follow existing patterns in `SessionStore` for private helpers; do not expand the public API surface unnecessarily.
- **GUD-002**: Keep token-estimation and context-ranking utilities small and framework-free.
- **PAT-001**: Conditional object spreads (`...(x ? { k: x } : {})`) for optional fields under `exactOptionalPropertyTypes`.

## 2. Implementation Steps

### Implementation Phase 1: Session store correctness

- GOAL-001: Stop TTL-eviction of actively-written sessions, stop notification churn on reads, and prevent silent history loss on overwrite.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/sessions.ts`, add private helper `touchSessionEntry(id: string, entry: SessionEntry): void` that sets `entry.lastAccess = this.now()` and calls `this.setSessionEntry(id, entry)`. Call it at the end of both `appendSessionTranscript` and `appendSessionEvent` before `notifyChange`.                                                                                         | ✅        | 2026-04-21 |
| TASK-002 | In `src/sessions.ts` `getSession`, remove the `this.notifyChange([id])` call. Still call `updateSessionAccess` to refresh TTL. Verify no resource invalidation depends on read-time notification (check `src/server.ts` subscription handlers).                                                                                                                                         | ✅        | 2026-04-21 |
| TASK-003 | In `src/sessions.ts` `storeSession`, detect `this.sessions.get(id)` returning an existing entry and throw `new Error('Session already exists: ' + id)` instead of silently overwriting. Add a new public method `replaceSession(id, chat)` that performs the destructive reset for intentional callers. Update `setSession` to delegate to a new `createSession` path for new IDs only. | ✅        | 2026-04-21 |
| TASK-004 | Audit `src/tools/chat.ts` (the only `setSession` call site) to confirm it is always called on a fresh ID. If any code path can reach it with a pre-existing ID, route that path through `replaceSession` explicitly.                                                                                                                                                                    | ✅        | 2026-04-21 |

### Implementation Phase 2: Workspace cache roots scoping

- GOAL-002: Prevent the process-global `workspaceCacheManager` from returning a cache built from a different `roots` set.

| Task     | Description                                                                                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-005 | In `src/lib/workspace-context.ts`, add module-private helper `normalizeRootsKey(roots: readonly string[]): string` that filters to absolute paths, lowercases, de-duplicates, sorts, and joins with `\n`.                                                                                                                                               | ✅        | 2026-04-21 |
| TASK-006 | Add field `private activeRootsKey: string \| undefined` to `WorkspaceCacheManagerImpl`. Populate it in `createCacheFromContext` on successful cache creation alongside `this.cacheName`. Clear it in `invalidate()`.                                                                                                                                    | ✅        | 2026-04-21 |
| TASK-007 | At the top of `getOrCreateCache(roots, signal)`, compute `rootsKey = normalizeRootsKey(roots)`. If `this.cacheName` is set and `this.activeRootsKey !== rootsKey`, capture `previousCacheName = this.cacheName`, call `this.invalidate()`, and then `await this.deleteCacheBestEffort(previousCacheName, signal)` before proceeding to the create path. | ✅        | 2026-04-21 |
| TASK-008 | Thread `rootsKey` through to `refreshCache` and `createCacheFromContext` so the key is set atomically with `cacheName`. Adjust signatures accordingly. Keep `createCache(roots, rootsKey, signal)` as the single call site that invokes `assembleWorkspaceContext(roots)`.                                                                              | ✅        | 2026-04-21 |

### Implementation Phase 3: Event-store replay determinism

- GOAL-003: Make `replayEventsAfter` deterministic under concurrent `storeEvent` activity.

| Task     | Description                                                                                                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-009 | In `src/lib/event-store.ts` `replayEventsAfter`, replace the indexed `for` loop with `const replayBatch = state.events.slice(arrayIndex + 1); for (const event of replayBatch) { await send(event.eventId, event.message); }`. Update `state.lastActivity = Date.now()` and bump `state.lastActivityOrder` before the loop. | ✅        | 2026-04-21 |

### Implementation Phase 4: Decouple chat-context and wire context-assembler

- GOAL-004: Remove the upward dependency from `chat-context.ts` to `workspace-context.ts` and put the orphan `context-assembler.ts` into the scanning pipeline.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                     | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-010 | Move `estimateTokens(text: string): number` and the `TOKENS_PER_CHAR` constant from `src/lib/workspace-context.ts` into a new file `src/lib/tokens.ts`. Re-export from `workspace-context.ts` (named re-export) to preserve existing imports. Update `src/lib/chat-context.ts` to import from `./tokens.js` instead.                                                            | ✅        | 2026-04-21 |
| TASK-011 | In `src/lib/workspace-context.ts` `assembleWorkspaceContext`, add an optional parameter `focusText?: string`. When present, call `extractKeywords(focusText)` from `context-assembler.ts` and sort each root's scanned `files` entries descending by `scoreFile(basename(path), content, keywords)` before applying the total-size cap. When absent, preserve current ordering. | ✅        | 2026-04-21 |
| TASK-012 | Audit call sites of `assembleWorkspaceContext` in `src/tools/*.ts` and `src/lib/workspace-context.ts` (internal `createCache`/`refreshCache`). Keep `focusText` optional and unpassed in current production call sites because the workspace-cache path must remain prompt-agnostic; no safe natural caller exists today outside direct tests.                                  | ✅        | 2026-04-21 |

## 3. Alternatives

- **ALT-001**: Replace the global `workspaceCacheManager` singleton with a `Map<rootsKey, WorkspaceCacheManagerImpl>`. Rejected for v1: larger blast radius, more upstream cache lifecycle to manage; the single-active-scope approach in TASK-007 is sufficient and reversible.
- **ALT-002**: Keep `setSession` destructive and rely on documentation. Rejected: silent history loss is a latent footgun; an explicit `replaceSession` API removes ambiguity with negligible code cost.
- **ALT-003**: Add a per-session async mutex at the tool layer. Deferred to a separate plan; no confirmed reproducer of interleaved-write corruption yet, and the fix is orthogonal to the correctness issues covered here.
- **ALT-004**: Fully split `workspace-context.ts` into scanner/formatter/cache-manager modules. Deferred: larger refactor, not required for correctness.

## 4. Dependencies

- **DEP-001**: `@google/genai` — `caches.create` / `caches.delete` lifecycle already used by `WorkspaceCacheManagerImpl`.
- **DEP-002**: `@modelcontextprotocol/server` — `EventStore` / `EventId` / `StreamId` types for `InMemoryEventStore`.
- **DEP-003**: Node.js stdlib `node:fs/promises`, `node:path`, `node:crypto` (already in use).

## 5. Files

- **FILE-001**: `src/sessions.ts` — add `touchSessionEntry`, remove read-time notifications, split `setSession`/`replaceSession`, guard against accidental overwrite.
- **FILE-002**: `src/lib/workspace-context.ts` — add `normalizeRootsKey`, `activeRootsKey`, invalidate-on-mismatch path; thread `rootsKey` through cache creation/refresh; add optional `focusText` to `assembleWorkspaceContext`.
- **FILE-003**: `src/lib/event-store.ts` — snapshot replay batch via `slice`.
- **FILE-004**: `src/lib/chat-context.ts` — import `estimateTokens` from new `./tokens.js` module.
- **FILE-005**: `src/lib/tokens.ts` — NEW. Houses `estimateTokens` and `TOKENS_PER_CHAR`.
- **FILE-006**: `src/lib/context-assembler.ts` — no source changes; becomes a live dependency of `workspace-context.ts`.
- **FILE-007**: `src/tools/chat.ts` — audit-only for TASK-004 and TASK-012; may pass `focusText` to `assembleWorkspaceContext` via the cache manager path.
- **FILE-008**: `__tests__/sessions.test.ts` — update / extend for new `setSession` semantics and TTL-touch behavior.
- **FILE-009**: `__tests__/lib/event-store.test.ts` — add concurrent-append replay test.
- **FILE-010**: `__tests__/lib/workspace-context.test.ts` (or equivalent existing location) — add roots-mismatch invalidation test.
- **FILE-011**: `__tests__/lib/context-assembler.test.ts` — extend to cover integration via `assembleWorkspaceContext(roots, focusText)`.

## 6. Testing

- **TEST-001**: `SessionStore.appendSessionTranscript` and `appendSessionEvent` refresh `lastAccess`; subsequent TTL sweep after writes-only does NOT evict the session.
- **TEST-002**: `SessionStore.getSession` does NOT invoke `notifyChange`; subscribe a spy, read N times, assert zero calls.
- **TEST-003**: Calling `setSession(existingId, newChat)` throws; `replaceSession(existingId, newChat)` resets transcript/events and notifies.
- **TEST-004**: `workspaceCacheManager.getOrCreateCache(rootsA)` then `getOrCreateCache(rootsB)` with `rootsA !== rootsB` invalidates and deletes the previous cache; mock `caches.delete` asserts one call with the old cache name.
- **TEST-005**: Within the 30-second hash-check throttle, switching `roots` still forces a rebuild (regression for the core bug).
- **TEST-006**: `InMemoryEventStore.replayEventsAfter` yields a stable sequence even when `storeEvent` is invoked concurrently and triggers `MAX_EVENTS_PER_STREAM` shifting during replay. Assert all pre-snapshot events are delivered exactly once and no post-snapshot events leak in.
- **TEST-007**: `assembleWorkspaceContext(roots, focusText)` orders scanned files by relevance when `focusText` contains matching keywords; default ordering is preserved without `focusText`.
- **TEST-008**: `chat-context` unit tests continue to pass without `workspace-context` import.
- **TEST-009**: Full suite: `npm run lint`, `npm run type-check`, `npm run test` all green.

## 7. Risks & Assumptions

- **RISK-001**: Throwing from `setSession` on an existing ID could break undocumented call paths. Mitigation: TASK-004 audit; if any legitimate caller needs overwrite, route to `replaceSession` explicitly.
- **RISK-002**: Invalidating the workspace cache on every `roots` switch may increase upstream `caches.create` cost if clients genuinely toggle roots often. Acceptable: correctness supersedes cache-hit rate here; single-active-scope matches today's deployment model.
- **RISK-003**: Adding `focusText` to `assembleWorkspaceContext` may reorder cached content and produce different `contentHash` values for the same roots, forcing cache recreation. Mitigation: pass `focusText` only from non-cached entry points, or exclude `focusText`-driven ordering from the hash input by ranking after hashing. Resolution recorded during TASK-011.
- **RISK-004**: Snapshot replay in TASK-009 still shares `message` object identity with live state; mutations of stored messages post-enqueue would still be visible. Assumption: `JSONRPCMessage` values are treated as immutable by the SDK (confirmed by current usage).
- **ASSUMPTION-001**: `workspaceCacheManager` remains a process singleton in the short term; a per-scope map is out of scope.
- **ASSUMPTION-002**: No external consumer relies on `getSession` emitting a change notification.

## 8. Related Specifications / Further Reading

- `src/server.ts` — session subscription fan-out into `memory://sessions` and `discover://context`
- `src/transport.ts` — stateful server/transport pairing and resumability model
- [MCP Server SDK — EventStore](https://github.com/modelcontextprotocol/typescript-sdk)
