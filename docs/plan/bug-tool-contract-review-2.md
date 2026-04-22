---
goal: Fix MCP v2 tool contract bugs in memory tool and harden structuredContent boundary
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Planned'
tags: ['bug', 'mcp', 'contract', 'memory', 'schema']
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Three concrete MCP v2 tool contract defects were identified in the `memory` tool during contract review:

1. `memory` action `caches.update` forwards the intermediate `updateCacheWork` shape (`{ cacheName, expireTime? }`) verbatim into the public `MemoryOutputSchema.cache` slot, which is `z.strictObject(cacheSummaryFields)` and requires `name` (not `cacheName`). The success response is silently flipped to `isError: true` by `validateStructuredToolResult`.
2. `memory` action `caches.delete` assigns `deleted: undefined` / `confirmationRequired: undefined` into strictObject output, making the response fragile against Zod `exactOptionalPropertyTypes`-style strictness.
3. `memory.annotations.destructiveHint` is currently `true` for the whole tool, but only one of eleven actions (`caches.delete`) actually mutates or deletes state. The advertised hint misleads clients into over-gating the entire tool.

This plan implements the minimum safe fixes, adds regression tests, and applies two small hardening improvements (capability explicitness + `research.sources` filter). Tool identifiers, input schemas, output schemas, and `execution.taskSupport` declarations are preserved unchanged. The `memory.destructiveHint` annotation is the sole intentionally client-visible change (see Compatibility Risks).

## 1. Requirements & Constraints

- **REQ-001**: Fix `memory` `caches.update` structuredContent so `MemoryOutputSchema.safeParse` succeeds on the happy path.
- **REQ-002**: Fix `memory` `caches.delete` structuredContent so optional booleans are never set to `undefined`.
- **REQ-003**: Correct `memory.annotations.destructiveHint` from `true` to `false` and scope destructive semantics to the `caches.delete` sub-action via tool description and tests.
- **REQ-004**: Preserve all externally advertised tool identifiers, input schemas, output schemas, and `execution.taskSupport` values unchanged. Annotation change for `memory.destructiveHint` is scoped and intentional under REQ-003.
- **REQ-005**: Preserve the repo's existing schema library and helper patterns (`z.strictObject`, `cacheSummaryFields`, `validateStructuredContent`, `validateStructuredToolResult`).
- **CON-001**: No rewrites of `updateCacheWork` / `deleteCacheWork` internal shapes — fix only at the memory-action boundary (`handleCachesUpdate`, `handleCachesDelete`).
- **CON-002**: No new abstractions; reuse existing `cacheSummaryFields` typing.
- **CON-003**: Keep changes additive. Do not remove existing fields from structuredContent.
- **GUD-001**: Use conditional spread (`...(cond ? { key: value } : {})`) for optional fields per the repo pattern documented in user memory (`exactOptionalPropertyTypes` and conditional spreads).
- **GUD-002**: Every tool result must include `content`; `structuredContent` must exactly match `outputSchema`.
- **PAT-001**: Follow the existing pattern used by `handleCachesCreate` — map intermediate fields explicitly into `CacheListEntrySchema`-compatible shape.
- **SEC-001**: Do not log cache bodies or system instructions; only names/TTLs (already current behavior — preserve).

## 2. Implementation Steps

### Implementation Phase 1 — Fix memory caches.update contract bug

- GOAL-001: Make `memory caches.update` produce valid `MemoryOutputSchema` output.

| Task     | Description                                                                                                                                                                                                                                                                                   | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In [src/tools/memory.ts](src/tools/memory.ts), update `handleCachesUpdate` to build a local `cacheEntry = { name: args.cacheName, ...(typeof structured.expireTime === 'string' ? { expireTime: structured.expireTime } : {}) }` and pass `cache: cacheEntry` instead of `cache: structured`. |           |      |
| TASK-002 | Run `npm run type-check` to confirm the new object is assignable to `MemoryOutputSchema.cache`.                                                                                                                                                                                               |           |      |
| TASK-003 | Run `npm run lint` and resolve any surface issues introduced by the edit.                                                                                                                                                                                                                     |           |      |

### Implementation Phase 2 — Fix memory caches.delete optional-boolean leakage

- GOAL-002: Ensure `deleted` and `confirmationRequired` are only present when they are actual booleans.

| Task     | Description                                                                                                                                                                                                                                   | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-004 | In [src/tools/memory.ts](src/tools/memory.ts) `handleCachesDelete`, replace unconditional `deleted: structured.deleted` / `confirmationRequired: structured.confirmationRequired` with conditional spreads guarded by `typeof === 'boolean'`. |           |      |
| TASK-005 | Verify the three existing `deleteCacheWork` branches (confirmed, declined, unsupported) each produce schema-valid output.                                                                                                                     |           |      |

### Implementation Phase 3 — Correct memory destructiveHint annotation

- GOAL-003: Align `memory.annotations.destructiveHint` with actual per-action semantics.

| Task     | Description                                                                                                                                                                                                                                                                                  | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-MA1 | In [src/tools/memory.ts](src/tools/memory.ts) `registerMemoryTool`, change `annotations: { ...MUTABLE_ANNOTATIONS, destructiveHint: true }` to `annotations: MUTABLE_ANNOTATIONS`.                                                                                                           |           |      |
| TASK-MA2 | Update the `memory` tool `description` to explicitly name the destructive sub-action, e.g. append: `Only action=caches.delete is destructive.`                                                                                                                                               |           |      |
| TASK-MA3 | Update [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts): remove `DESTRUCTIVE_MUTABLE_ANNOTATIONS`, switch `memory.annotations` in `EXPECTED_TOOL_CONTRACTS` to `MUTABLE_ANNOTATIONS`, and add an assertion that the `memory` tool description matches `/caches\.delete/i`. |           |      |

### Implementation Phase 4 — Regression tests

- GOAL-004: Lock the fixes in with focused tests colocated with existing memory tests.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-006 | Add test in [**tests**/tools/memory.test.ts](__tests__/tools/memory.test.ts): `memory caches.update returns cache.name and validates against MemoryOutputSchema`. Mock `client.caches.update` to return `{ name: 'cachedContents/abc', expireTime: '2030-01-01T00:00:00Z' }`; assert `result.isError !== true`, `structuredContent.cache.name === args.cacheName`, `structuredContent.cache.expireTime === '2030-01-01T00:00:00Z'`, and `MemoryOutputSchema.safeParse(structuredContent).success === true`. |           |      |
| TASK-007 | Add test: `memory caches.delete unsupported-elicitation path produces schema-valid output`. Override `ctx.mcpReq.elicitInput` to throw; assert `structuredContent.deleted === false`, `structuredContent.confirmationRequired === true`, and `MemoryOutputSchema.safeParse(...).success === true`.                                                                                                                                                                                                          |           |      |
| TASK-008 | Add test: `memory caches.delete declined path omits missing boolean via schema parse`. Confirm `MemoryOutputSchema.safeParse` passes when elicitation returns action !== 'accept'.                                                                                                                                                                                                                                                                                                                          |           |      |

### Implementation Phase 5 — Additional boundary and helper tests

- GOAL-005: Close test gaps surfaced by external review for strict-object enforcement, required discriminator fields, and the shared output-validation helper.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                       | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-B01 | In [**tests**/contract-errors.e2e.test.ts](__tests__/contract-errors.e2e.test.ts) (or nearest boundary-error test), add a case that sends `tools/call` for `chat` with a valid `goal` plus an unknown key (e.g. `foo: 'bar'`) and asserts JSON-RPC error `-32602` (strictObject rejection). Repeat for `memory` with valid `action: 'sessions.list'` + unknown key.                                                               |           |      |
| TASK-B02 | Add a boundary test that sends `tools/call` for `review` with an empty arguments object (omitting `subjectKind`) and asserts JSON-RPC error `-32602`, locking in that the required discriminator is enforced at the protocol boundary.                                                                                                                                                                                            |           |      |
| TASK-B03 | Add a focused unit test in [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts) for `validateStructuredToolResult`: given a success `CallToolResult` whose `structuredContent` does not match a provided Zod schema, assert the returned result has `isError === true`, retains original `content` entries, appends a text entry explaining the internal validation failure, and contains no `structuredContent` key. |           |      |

### Implementation Phase 6 — Optional hardening (non-blocking)

- GOAL-006: Reduce latent contract risk without changing the public surface.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                             | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-009 | In [src/server.ts](src/server.ts) `createServerInstance`, add explicit `tools: { listChanged: false }` to the `capabilities` object, adjacent to `resources: { listChanged: true }`. Must be declared before `server.connect()` (capabilities block).                                                                                                                                   |           |      |
| TASK-010 | In [src/lib/response.ts](src/lib/response.ts) `collectGroundedSources`, filter returned URLs through `isPublicHttpUrl` from `src/schemas/fields.ts` to prevent an unexpected non-public grounding URL from flipping a successful `research` response into `isError: true` via `ResearchOutputSchema.sources` refinement. Import `isPublicHttpUrl` from the same module the schema uses. |           |      |
| TASK-011 | Add a regression test in [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts) covering a mixed-URL grounding metadata fixture (one public, one `file://`) and asserting only the public URL is returned.                                                                                                                                                                    |           |      |

### Implementation Phase 7 — Validation gate

- GOAL-007: Confirm no regressions across the full contract surface.

| Task     | Description                                                                                                                                       | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-012 | Run `npm run format`.                                                                                                                             |           |      |
| TASK-013 | Run `npm run lint`.                                                                                                                               |           |      |
| TASK-014 | Run `npm run type-check`.                                                                                                                         |           |      |
| TASK-015 | Run `npm run test` and confirm `__tests__/mcp-tools.e2e.test.ts`, `__tests__/tools/memory.test.ts`, `__tests__/schemas/outputs.test.ts` all pass. |           |      |

## 3. Alternatives

- **ALT-001**: Change `updateCacheWork` / `deleteCacheWork` to emit `{ name, ... }` directly. Rejected — those functions are referenced from multiple call sites and are effectively internal utilities; changing their shape would broaden the diff and risk unrelated regressions. Boundary mapping in the `handleCaches*` function keeps the change surgical.
- **ALT-002**: Widen `CacheListEntrySchema` to accept both `name` and `cacheName`. Rejected — that would weaken the external contract and create a permanent forked schema.
- **ALT-003**: Skip TASK-010 (research.sources filter) until a real failure is observed. Acceptable if the team prefers minimal change; recorded as optional in Phase 6.
- **ALT-004**: Split `caches.delete` into a dedicated destructive tool so the remaining `memory` actions can safely advertise `destructiveHint: false`. Rejected for this plan — it is an externally visible surface split with doc, test, and client-migration costs. Keep the single-tool contract and correct the hint via description + per-action documentation.
- **ALT-005**: Keep `memory.destructiveHint: true` to be conservative. Rejected — it misleads `tools/list` consumers; 10 of 11 actions are read-only or non-destructive mutations, and `caches.delete` has its own `confirm` flow plus elicitation.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server@2.0.0-alpha.2` (existing; no upgrade required).
- **DEP-002**: `zod@^4` (existing).
- **DEP-003**: `@cfworker/json-schema` (existing, unaffected).
- **DEP-004**: No new runtime dependencies are introduced.

## 5. Files

- **FILE-001**: [src/tools/memory.ts](src/tools/memory.ts) — `handleCachesUpdate` (must-fix M1), `handleCachesDelete` (must-fix M2), `registerMemoryTool` (must-fix M3: annotation + description).
- **FILE-002**: [src/server.ts](src/server.ts) — explicit `tools` capability (optional hardening).
- **FILE-003**: [src/lib/response.ts](src/lib/response.ts) — `collectGroundedSources` filter (optional hardening).
- **FILE-004**: [**tests**/tools/memory.test.ts](__tests__/tools/memory.test.ts) — regression tests for TASK-006..TASK-008.
- **FILE-005**: [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts) — regression test for TASK-011 and TASK-B03.
- **FILE-006**: [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts) — contract updates for TASK-MA3.
- **FILE-007**: [**tests**/contract-errors.e2e.test.ts](__tests__/contract-errors.e2e.test.ts) — boundary tests for TASK-B01 and TASK-B02.
- **FILE-008**: [src/schemas/outputs.ts](src/schemas/outputs.ts) — reference only (not modified); `MemoryOutputSchema`, `CacheListEntrySchema`.
- **FILE-009**: [src/schemas/fragments.ts](src/schemas/fragments.ts) — reference only (not modified); `cacheSummaryFields`.

## 6. Testing

- **TEST-001**: `memory caches.update returns cache.name and validates against MemoryOutputSchema` — success path, mocked `client.caches.update`. Asserts schema-valid `structuredContent.cache`.
- **TEST-002**: `memory caches.delete unsupported-elicitation path produces schema-valid output` — ensures `deleted: false`, `confirmationRequired: true` are both present booleans.
- **TEST-003**: `memory caches.delete declined path produces schema-valid output` — ensures `deleted: false`, `confirmationRequired: false`.
- **TEST-004**: `collectGroundedSources filters non-public URLs` — fixture with mixed http(s) + non-public URL, asserts only public URLs returned (only if TASK-010 is implemented).
- **TEST-005**: `memory tool advertises non-destructive annotations and caches.delete in description` — asserts `annotations` equals `MUTABLE_ANNOTATIONS` and description matches `/caches\.delete/i` (TASK-MA3).
- **TEST-006**: `chat rejects unknown top-level keys at the protocol boundary` — `tools/call` with a valid `goal` plus an extraneous key → JSON-RPC `-32602` (TASK-B01).
- **TEST-007**: `memory rejects unknown top-level keys at the protocol boundary` — `tools/call` for `sessions.list` plus an extraneous key → JSON-RPC `-32602` (TASK-B01).
- **TEST-008**: `review requires subjectKind at the protocol boundary` — empty `arguments` → JSON-RPC `-32602` (TASK-B02).
- **TEST-009**: `validateStructuredToolResult rewrites invalid structuredContent to isError with retained content` — unit test for TASK-B03.
- **TEST-010**: Existing `__tests__/mcp-tools.e2e.test.ts` contract assertions must continue to pass after the annotation + description adjustments in Phase 3, verifying no additional externally advertised schema/taskSupport changed.

## 7. Risks & Assumptions

- **RISK-001**: `MemoryOutputSchema.cache` (`CacheListEntrySchema`) may evolve later to carry additional fields; the boundary mapping in `handleCachesUpdate` intentionally emits only `name` and optional `expireTime`. Future additions must be forwarded explicitly.
- **RISK-002**: The SDK alpha dispatch override in `installTaskSafeToolCallHandler` continues to rely on internal SDK fields (`_registeredTools`, `validateToolOutput`). Out of scope for this plan but flagged as a latent risk if the SDK bumps.
- **RISK-003**: `collectGroundedSources` filter (TASK-010) could hide a real provider-side regression. Mitigation: log filtered URLs at `debug` level (add in TASK-010 implementation).
- **ASSUMPTION-001**: `validateStructuredToolResult` currently rewrites schema-mismatching success results to `isError: true`. Verified in [src/lib/response.ts](src/lib/response.ts#L140-L170).
- **ASSUMPTION-002**: No external client consumer relies on the bugged `cacheName` field in `memory.caches.update` structuredContent — the output is currently flipped to an error, so no stable consumer could depend on it.
- **RISK-004**: Changing `memory.destructiveHint` from `true` to `false` is a client-visible `tools/list` change. Clients that gate the whole tool as destructive will see a softer hint. Mitigation: update the tool `description` to explicitly identify `caches.delete` as the destructive sub-action, and keep the existing `confirm` + elicitation flow in `deleteCacheWork` unchanged so the destructive path still requires explicit consent.
- **ASSUMPTION-003**: The README drift flagged by external review (6-tool list including `discover`; `memory.action` called a discriminated union) is documentation-only and out of scope for this `src`-level contract plan. It may be addressed in a separate docs-only plan.
- **ASSUMPTION-004**: `validateStructuredToolResult` preserves original `content` entries when downgrading a success result to an error result; verified in [src/lib/response.ts](src/lib/response.ts#L140-L170).

## 8. Related Specifications / Further Reading

- [Model Context Protocol specification — Tools](https://modelcontextprotocol.io/specification/basic/tools)
- [docs/plan/bug-tool-contract-review-1.md](docs/plan/bug-tool-contract-review-1.md) — previous contract review plan
- [docs/plan/feature-task-contract-hardening-1.md](docs/plan/feature-task-contract-hardening-1.md) — task-support hardening context
- [src/lib/task-utils.ts](src/lib/task-utils.ts) — `installTaskSafeToolCallHandler` and task dispatch rationale
