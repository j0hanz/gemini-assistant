# Memory Tool Removal & Resource Surface Refinement

**Date:** 2026-04-22
**Status:** Approved — ready for implementation plan

## Problem

The `memory` tool is over-engineered for what it delivers:

- 9 discriminated actions, 7 of which are read-only mirrors of existing MCP resources.
- The name "memory" misleads LLMs into expecting persistent recall semantics.
- Gemini context caches (`caches.create/update`) are a provider-specific optimization that few clients actually need. Exposing them as a top-level tool surface, plus a separate `delete_cache` tool, scatters cache lifecycle across multiple tools.
- The `memory://` URI scheme becomes meaningless once the tool is gone.

## Goal

Eliminate the user-visible "memory" concept. Reduce the public tool surface from 6 → 4 tools. Make Gemini context caching a silent internal optimization (workspace only). Rename URI schemes to be semantically honest.

## Non-goals

- Changing `chat`, `research`, `analyze`, `review` behavior beyond removing `cacheName` inputs.
- Altering the workspace auto-cache mechanism itself (it stays; only its external surface changes).
- Preserving backwards compatibility with the old `memory://` URIs or the `memory` / `delete_cache` tools. This is a clean break.

## Design

### Public tool surface (4 tools, down from 6)

| Tool               | Status                            |
| ------------------ | --------------------------------- |
| `chat`             | Kept. `cacheName` input removed.  |
| `research`         | Unchanged.                        |
| `analyze`          | Unchanged.                        |
| `review`           | `cacheName` removed (if present). |
| ~~`memory`~~       | **Removed.**                      |
| ~~`delete_cache`~~ | **Removed.**                      |

### Gemini cache handling

- **User-visible cache CRUD: removed entirely.** No tool can create, update, delete, list, or read Gemini context caches.
- **Workspace auto-cache: kept.** `WorkspaceCacheManagerImpl` continues to silently cache assembled workspace context under the hood. Clients never see a `cacheName`.
- **`cacheName` parameter: removed from all tool inputs.** No tool references caches by name.
- **`client.ts` cache helpers:** `listCacheSummaries`, `getCacheSummary`, `completeCacheNames`, and related exports removed. Internal use inside `WorkspaceCacheManagerImpl` keeps `getAI().caches.*` calls directly.

### Resource surface

**Removed:**

- `memory://caches` — cache list
- `memory://caches/{cacheName}` — cache detail

**Renamed (flat form, scheme scopes the domain):**

| Old                                        | New                                |
| ------------------------------------------ | ---------------------------------- |
| `memory://sessions`                        | `session://`                       |
| `memory://sessions/{sessionId}`            | `session://{sessionId}`            |
| `memory://sessions/{sessionId}/transcript` | `session://{sessionId}/transcript` |
| `memory://sessions/{sessionId}/events`     | `session://{sessionId}/events`     |
| `memory://workspace/context`               | `workspace://context`              |
| `memory://workspace/cache`                 | `workspace://cache`                |

**Unchanged:**

- `discover://catalog`, `discover://workflows`, `discover://context`

### Prompts

- `memory` prompt: **removed**.
- `recommendedPrompt: 'memory'` references: removed from catalog entries.

### Catalog / public-contract

- `memory` and `delete_cache` removed from `JOB_METADATA`, `DISCOVERY_ENTRIES`.
- `memory://caches*` resource entries removed from `DISCOVERY_ENTRIES`.
- Session and workspace resource entries updated to new URIs.
- Any workflow referencing `memory` tool or cache actions reworked or removed.
- Type-level URI union (`PublicResourceUri` or equivalent) updated.

### Schemas

- Remove: `createMemoryInputSchema`, `MemoryInputSchema`, `MemoryOutputSchema`, `CreateCacheInput*`, `UpdateCacheInput*`, `DeleteCacheInput*`, `DeleteCachePublicOutputSchema`, `MemoryInput` union type.
- Remove `cacheName` field from `chat`/`review` input schemas.
- Fragments referencing cache names: removed.

### Files touched

**Deleted:**

- `src/tools/memory.ts`
- `__tests__/tools/memory.test.ts`
- Any cache-only test fixtures

**Modified:**

- `src/server.ts` — stop registering `memory` + `delete_cache` tools.
- `src/resources.ts` — drop cache resources, rename session/workspace URIs.
- `src/lib/resource-uris.ts` — update URI builders and constants.
- `src/client.ts` — drop public cache helpers; keep `getAI()` export.
- `src/lib/workspace-context.ts` — keep as-is (already uses `getAI().caches.*` directly).
- `src/schemas/inputs.ts` — drop memory/cache schemas, drop `cacheName` from tool inputs.
- `src/schemas/outputs.ts` — drop memory/cache output schemas.
- `src/schemas/fragments.ts` — drop cache fragments.
- `src/tools/chat.ts` — drop `cacheName` handling.
- `src/tools/review.ts` — drop `cacheName` if present.
- `src/public-contract.ts` — remove `memory`, `delete_cache`, cache resources; rename session/workspace URIs.
- `src/prompts.ts` — drop `memory` prompt.
- `src/catalog.ts` — transitive via public-contract.
- Tests across `__tests__/` referencing old names/URIs updated or removed.

## Data flow after change

```
LLM client
  ├─ chat / research / analyze / review   (4 tools)
  └─ resources
       ├─ session://...          (read-only session state)
       ├─ workspace://context    (assembled project context)
       ├─ workspace://cache      (internal workspace cache status)
       └─ discover://...         (catalog + workflows)

Internal (invisible to client):
  WorkspaceCacheManagerImpl  ──► getAI().caches.*   (silent optimization)
```

## Testing strategy

1. Delete `__tests__/tools/memory.test.ts`.
2. Update tests that assert on tool names, URI strings, catalog contents, or schemas.
3. Keep `WorkspaceCacheManagerImpl` tests — internal behavior is unchanged.
4. Full suite must pass: `npm run format && npm run lint && npm run type-check && npm run test`.

## Risks

- **Breaking change.** Any existing client using `memory`/`delete_cache`/`cacheName` or old URIs breaks. Acceptable per user direction (clean break).
- **Catalog consumers.** `discover://catalog` output changes shape. Documented as expected.

## Rollout

Single PR. No deprecation window.
