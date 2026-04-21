---
goal: Fix resource/prompt provisioning bugs and tighten URI handling in gemini-assistant
version: 1.0
date_created: 2026-04-21
last_updated: 2026-04-21
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['bug', 'refactor', 'resources', 'prompts']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This implementation plan outlines the steps required to fix several identified bugs in the resource and prompt provisioning logic of `gemini-assistant`. The main issues to address include incorrect suppression of `systemInstruction` in cached prompts, improper error handling for malformed resource URIs, and hardcoded resource URI strings that risk drift. The plan also includes adding regression tests to prevent future occurrences of these bugs.

## 1. Requirements & Constraints

- **REQ-001**: `resolveTextPrompt` / `resolvePartPrompt` in `src/lib/model-prompts.ts` must only suppress `systemInstruction` when an equivalent `cacheText` is actually moved into the cached prompt body. They must not silently drop instructions when callers pass `cacheName` without `cacheText`.
- **REQ-002**: `decodeTemplateParam` in `src/resources.ts` must convert `URIError` from malformed percent-encoding into `ProtocolError(ProtocolErrorCode.InvalidParams, …)`.
- **REQ-003**: The `memory-cache-detail` read handler must distinguish a missing cache (`ResourceNotFound`) from upstream/runtime failures (`InternalError`) and must not swallow nested `ProtocolError` instances.
- **REQ-004**: `textResource()` reads for `memory://workspace/context` must include an explicit `mimeType: 'text/markdown'` matching the registered resource descriptor.
- **REQ-005**: Static resource URI strings used in both `src/resources.ts` and `src/server.ts` must come from `src/lib/resource-uris.ts`. No new hardcoded URI string literals may remain in those two files for cache/discovery/workspace resources after this change.
- **REQ-006**: The discover-prompt job completion list must be derived from `PublicJobNameSchema` enum values, not a hardcoded array.
- **PAT-001**: Use existing `ProtocolError` / `ProtocolErrorCode` surfaces defined by `@modelcontextprotocol/server`.
- **PAT-002**: Preserve existing dual `application/json` + `text/markdown` shape from `dualContentResource()` for already-dual resources.
- **CON-001**: Do not introduce behavior changes for `memory://workspace/context` change notifications. Its content is derived from `assembleWorkspaceContext` (filesystem), not from `subscribeWorkspaceCacheChange` (Gemini cache state).
- **CON-002**: Do not fence raw transcript/event message text; current clients may rely on markdown passthrough.
- **GUD-001**: Match the existing `docs/plan/*.md` template style (front matter + phased task tables).

## 2. Implementation Steps

### Implementation Phase 1: Critical correctness — cached prompt resolution

- GOAL-001: Ensure cached-mode prompt resolution never silently drops `systemInstruction` when no `cacheText` is supplied.

| Task     | Description                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/lib/model-prompts.ts`, introduce `useCacheText = Boolean(cacheName && policy.cacheText)` inside `resolveTextPrompt`. Use it to decide whether to prepend `policy.cacheText` to `promptText` and whether to suppress `systemInstruction`.        | ✅        | 2026-04-21 |
| TASK-002 | In `src/lib/model-prompts.ts`, apply the same `useCacheText` guard inside `resolvePartPrompt`. Only prepend `{ text: policy.cacheText }` and clear `systemInstruction` when `useCacheText` is true.                                                     | ✅        | 2026-04-21 |
| TASK-003 | Add a regression test in `__tests__/lib/model-prompts.test.ts` asserting that `buildGroundedAnswerPrompt('q', undefined, 'caches/foo')` retains the grounded-answer `systemInstruction` (because the policy has no `cacheText`).                        | ✅        | 2026-04-21 |
| TASK-004 | Add a regression test in `__tests__/lib/model-prompts.test.ts` asserting that `buildFileAnalysisPrompt({ kind: 'single', goal: 'g', cacheName: 'caches/foo' })` retains its `systemInstruction`.                                                        | ✅        | 2026-04-21 |
| TASK-005 | Add a regression test in `__tests__/lib/model-prompts.test.ts` asserting that `buildDiffReviewPrompt({ mode: 'review', promptText: 'x', cacheName: 'caches/foo' })` (which DOES supply `cacheText`) still drops `systemInstruction` and prepends cache. | ✅        | 2026-04-21 |

### Implementation Phase 2: Resource URI parsing and error classification

- GOAL-002: Keep URI parsing failures inside the MCP `ProtocolError` contract and surface cache backend failures accurately.

| Task     | Description                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | In `src/resources.ts`, wrap the `decodeURIComponent(normalized)` call inside `decodeTemplateParam` in `try/catch` and rethrow as `new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid percent-encoding in resource URI parameter')`.                                           | ✅        | 2026-04-21 |
| TASK-007 | In `src/resources.ts`, replace `normalizeTemplateParam` + inline `decodeURIComponent` in the `memory-cache-detail` read handler with a single `decodeTemplateParam(cacheName)` call.                                                                                                   | ✅        | 2026-04-21 |
| TASK-008 | In `src/resources.ts` `memory-cache-detail` read handler, treat `await getCacheSummary(decoded)` returning a nullish value as `ResourceNotFound`. Rethrow caught `ProtocolError` unchanged. Log and rethrow other errors as `ProtocolErrorCode.InternalError`.                         | ✅        | 2026-04-21 |
| TASK-009 | Extend `textResource()` in `src/resources.ts` with an optional `mimeType` parameter (default `'text/plain'`). Update `readWorkspaceContextResource` to pass `'text/markdown'`.                                                                                                         | ✅        | 2026-04-21 |
| TASK-010 | Add tests in `__tests__/resources.test.ts` covering: (a) malformed `%` in a session/cache template param returns `InvalidParams`; (b) `getCacheSummary` throwing a non-protocol error returns `InternalError`, not `ResourceNotFound`; (c) nullish summary returns `ResourceNotFound`. | ✅        | 2026-04-21 |

### Implementation Phase 3: Centralize remaining resource URI literals

- GOAL-003: Eliminate drift by routing all static cache/discovery/workspace resource URIs through `src/lib/resource-uris.ts`.

| Task     | Description                                                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-011 | Add the following exported constants to `src/lib/resource-uris.ts`: `DISCOVER_CATALOG_URI`, `DISCOVER_WORKFLOWS_URI`, `DISCOVER_CONTEXT_URI`, `MEMORY_CACHES_URI`, `MEMORY_WORKSPACE_CONTEXT_URI`, `MEMORY_WORKSPACE_CACHE_URI`.                                                                             | ✅        | 2026-04-21 |
| TASK-012 | Add `cacheDetailUri(cacheName: string)` helper in `src/lib/resource-uris.ts` using `${MEMORY_CACHES_URI}/${encodeURIComponent(cacheName)}`. Replace the inline template in `cacheDetailResources()` in `src/resources.ts`.                                                                                   | ✅        | 2026-04-21 |
| TASK-013 | In `src/resources.ts`, replace the string literals inside `DISCOVER_CATALOG_RESOURCE`, `DISCOVER_WORKFLOWS_RESOURCE`, `DISCOVER_CONTEXT_RESOURCE`, and the `registerCacheResources` / `registerDiscoveryResources` / `registerContextResource` / `registerWorkspaceResources` bodies with the new constants. | ✅        | 2026-04-21 |
| TASK-014 | In `src/server.ts`, replace every hardcoded URI string inside `handleCacheChange`, `handleWorkspaceCacheChange`, and the session-change handlers with the corresponding constant from `src/lib/resource-uris.ts`. Keep current notification targets unchanged.                                               | ✅        | 2026-04-21 |
| TASK-015 | Add an assertion in `__tests__/resources.test.ts` (or `__tests__/lib/resource-uris` if present) that the exported constants match the registered resource names — simple string equality.                                                                                                                    | ✅        | 2026-04-21 |

### Implementation Phase 4: Prompt drift cleanup

- GOAL-004: Remove the hardcoded discover-prompt job list and keep `renderWorkflowSection` graceful without changing semantics.

| Task     | Description                                                                                                                                                                                                                                                                | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-016 | In `src/prompts.ts`, derive `PUBLIC_JOB_OPTIONS` from `PublicJobNameSchema.options` (Zod v4) or a shared constant already exported from `src/schemas/fields.ts`. Use it in the `completable(...)` for `DiscoverPromptSchema.job`.                                          | ✅        | 2026-04-21 |
| TASK-017 | In `src/prompts.ts`, change `renderWorkflowSection` so a missing `findWorkflowEntry(name)` returns a short degraded section pointing to `discover://workflows` instead of throwing. Keep the happy path output byte-identical.                                             | ✅        | 2026-04-21 |
| TASK-018 | Add a test in `__tests__/prompts.test.ts` covering discover-prompt completion prefix filtering against the derived list, and that an unknown workflow name produces a degraded section (guarded through a narrow internal hook if needed — otherwise skip if unreachable). | ✅        | 2026-04-21 |

### Implementation Phase 5: Verification

- GOAL-005: Run the repo's standard safety gates.

| Task     | Description                               | Completed | Date       |
| -------- | ----------------------------------------- | --------- | ---------- |
| TASK-019 | Run `npm run format`.                     | ✅        | 2026-04-21 |
| TASK-020 | Run `npm run lint`.                       | ✅        | 2026-04-21 |
| TASK-021 | Run `npm run type-check`.                 | ✅        | 2026-04-21 |
| TASK-022 | Run `npm run test` and confirm all green. | ✅        | 2026-04-21 |

## 3. Alternatives

- **ALT-001**: Tighten callers instead of `resolve*Prompt` — require every call site that passes `cacheName` to also pass `cacheText`. Rejected: many signatures already accept optional `cacheName`, and the guard is cheaper and safer at the resolver.
- **ALT-002**: Fence transcript/event markdown to defend against user-injected markdown. Rejected per CON-002 — it strips legitimate markdown rendering and no rendering bug is on record.
- **ALT-003**: Also notify `memory://workspace/context` on `subscribeWorkspaceCacheChange`. Rejected per CON-001 — that resource is filesystem-derived, so the notification would be spurious.
- **ALT-004**: Introduce a new `ResourceUri` typed wrapper. Rejected — adds API surface without clear benefit; string constants are enough to stop drift.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` v2 (already a direct dependency) — provides `ProtocolError`, `ProtocolErrorCode`, `ResourceTemplate`, `McpServer`.
- **DEP-002**: `zod/v4` — used for `PublicJobNameSchema.options` extraction in Phase 4.
- **DEP-003**: Node.js `>=24` (per `package.json` engines).

## 5. Files

- **FILE-001**: `src/lib/model-prompts.ts` — cached-prompt resolver fix.
- **FILE-002**: `src/resources.ts` — URI decoding, cache-detail error classification, `textResource` mimeType, URI constants adoption.
- **FILE-003**: `src/lib/resource-uris.ts` — new URI constants and `cacheDetailUri` helper.
- **FILE-004**: `src/server.ts` — replace hardcoded URI strings in notification handlers.
- **FILE-005**: `src/prompts.ts` — derived `PUBLIC_JOB_OPTIONS`, graceful `renderWorkflowSection`.
- **FILE-006**: `__tests__/lib/model-prompts.test.ts` — regression tests for cached-prompt resolution.
- **FILE-007**: `__tests__/resources.test.ts` — URI decoding + cache-detail error classification tests.
- **FILE-008**: `__tests__/prompts.test.ts` — completion list and degraded workflow rendering tests.

## 6. Testing

- **TEST-001**: `buildGroundedAnswerPrompt('q', undefined, 'caches/foo')` keeps its `systemInstruction`.
- **TEST-002**: `buildFileAnalysisPrompt({ kind: 'single', goal, cacheName })` keeps its `systemInstruction`.
- **TEST-003**: `buildDiffReviewPrompt({ mode: 'review', promptText, cacheName })` drops `systemInstruction` AND prepends `cacheText` — behavior preserved.
- **TEST-004**: Malformed percent-encoding on a cache-detail URI (e.g. `memory://caches/%E0%A4`) yields `ProtocolErrorCode.InvalidParams`.
- **TEST-005**: Upstream `getCacheSummary` error (simulated via mock throwing non-`ProtocolError`) yields `ProtocolErrorCode.InternalError`.
- **TEST-006**: `getCacheSummary` returning nullish yields `ProtocolErrorCode.ResourceNotFound`.
- **TEST-007**: `readWorkspaceContextResource` response includes `mimeType: 'text/markdown'`.
- **TEST-008**: Exported URI constants match the names registered with `server.registerResource(...)`.
- **TEST-009**: Discover-prompt job completion filters against the enum-derived options list.

## 7. Risks & Assumptions

- **RISK-001**: Additional `mimeType` on `memory://workspace/context` may surface as a visible diff to existing clients; low impact because the registered descriptor already declares `text/markdown`.
- **RISK-002**: Error-classification change for `memory-cache-detail` reclassifies some previously-`ResourceNotFound` responses as `InternalError`. Acceptable — the previous behavior was incorrect.
- **RISK-003**: Extracting `PublicJobNameSchema.options` relies on Zod v4 enum shape. Low risk; confirmed supported by Zod v4.
- **ASSUMPTION-001**: No caller currently depends on `resolve*Prompt` stripping `systemInstruction` when `cacheText` is absent. Grep of `src/tools/*.ts` shows all `cacheName` pass-throughs go to policies that either supply `cacheText` or expect instructions to remain.
- **ASSUMPTION-002**: `renderWorkflowSection`'s throw is practically unreachable because `PublicWorkflowName` is enum-typed; the graceful fallback is purely defensive.

## 8. Related Specifications / Further Reading

- `docs/plan/bug-observability-contract-1.md` — prior bug-fix plan template.
- `docs/specs/2026-04-18-tool-surface-consolidation-design.md` — adjacent public-contract context.
- Model Context Protocol v2 resource/prompt guidance in `@modelcontextprotocol/server` package docs.
