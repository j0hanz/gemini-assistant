# Resources Redesign — Design Spec

**Date:** 2026-05-01
**Status:** Approved (brainstorming complete, awaiting user spec review)
**Scope:** MCP resource surface of `gemini-assistant` — URI scheme, content shapes, subscriptions, caching, security, module layout. Tools, prompts, and the public-contract for tools/prompts are out of scope.

---

## Goals

Treat resources as the connective tissue between tools, sessions, and Gemini state, optimized for an **assistant-first, lazy-fetch** consumption model. Tool results emit terse `resource_link` blocks pointing at rich resources; the assistant fetches only what it needs. Resources expose Gemini-native state (raw turn parts, grounding metadata, workspace cache contents, scanned file inventory) with proper MCP v2 semantics (`subscribe: true`, `lastModified`, `_meta`, `size`).

**Non-goals:** changing the public tool/prompt contract; introducing new env-var flags; embedding `EmbeddedResource` blocks by default; building a generic filesystem browser.

---

## Section 1 — URI Map (hard cutover)

Two schemes, no aliases, no legacy. Old URIs are removed.

### `assistant://` — meta / static

| URI                              | Replaces               | Notes                                                 |
| -------------------------------- | ---------------------- | ----------------------------------------------------- |
| `assistant://discover/catalog`   | `discover://catalog`   | tools + prompts + resources catalog (JSON + Markdown) |
| `assistant://discover/workflows` | `discover://workflows` | guided workflows (JSON + Markdown)                    |
| `assistant://discover/context`   | `discover://context`   | dashboard snapshot (memoized 5 s)                     |
| `assistant://profiles`           | `gemini://profiles`    | tool profiles + combo matrix                          |
| `assistant://instructions`       | _(new)_                | the server's `SERVER_INSTRUCTIONS` blob, linkable     |

### `gemini://` — live model / session / workspace state

| URI                                        | Replaces                                   | Notes                                                         |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------- |
| `gemini://sessions`                        | `session://`                               | active sessions list                                          |
| `gemini://session/{id}`                    | `session://{id}`                           | session detail                                                |
| `gemini://session/{id}/transcript`         | `session://{id}/transcript`                | gated by `MCP_EXPOSE_SESSION_RESOURCES`                       |
| `gemini://session/{id}/events`             | `session://{id}/events`                    | gated, normalized events                                      |
| `gemini://session/{id}/turn/{n}/parts`     | `gemini://sessions/{id}/turns/{n}/parts`   | raw `Part[]` from in-memory `rawParts` (no Gemini round-trip) |
| `gemini://session/{id}/turn/{n}/grounding` | _(new)_                                    | per-turn grounding rollup                                     |
| `gemini://workspace/cache`                 | `workspace://cache`                        | cache status JSON                                             |
| `gemini://workspace/cache/contents`        | _(new — split from `workspace://context`)_ | assembled context body (Markdown)                             |
| `gemini://workspace/files`                 | _(new)_                                    | file inventory: paths, sizes, scores, mtimeMs                 |
| `gemini://workspace/files/{path}`          | _(new)_                                    | single scanned file's content slice                           |

The legacy `workspace://context` resource is removed; its assembled-Markdown role moves to `gemini://workspace/cache/contents`.

### Tier classification

- **Static** (no notifications): `assistant://discover/catalog`, `assistant://discover/workflows`, `assistant://profiles`, `assistant://instructions`.
- **listChanged-only**: `gemini://sessions`, `assistant://discover/context`, `gemini://workspace/files`.
- **Subscribe-capable + listChanged** (per-URI `resources/updated`): every other `gemini://*` URI.

---

## Section 2 — Content shapes, metadata, and the lazy-link contract

### 2.1 Standard MCP metadata on every resource

Every `registerResource()` call sets:

- `mimeType` — primary content type
- `annotations.audience: ['assistant']` (catalog/workspace dashboards also include `'user'`)
- `annotations.priority` — 0.3 static / 0.6 catalog / 0.8 session / 1.0 workspace context
- `annotations.lastModified` — ISO datetime, set per-read from the underlying source's mtime/createdAt:
  - sessions: `lastAccessedAt`
  - cache: `createdAt`
  - workspace files: `fs.stat.mtimeMs`
  - turns: turn timestamp
- `size` — byte length of the primary content (in `_meta`)
- `_meta` — typed extension bag (see 2.3)

### 2.2 Content shapes per resource

- **Dual-content (JSON primary + Markdown alt)**: `assistant://discover/catalog`, `…/workflows`, `…/context`, `gemini://session/{id}/transcript`, `…/events`, `…/turn/{n}/grounding`.
- **JSON-only**: `assistant://profiles`, `gemini://sessions`, `gemini://session/{id}`, `gemini://session/{id}/turn/{n}/parts`, `gemini://workspace/cache`, `gemini://workspace/files`.
- **Markdown-only**: `assistant://instructions`, `gemini://workspace/cache/contents`.
- **Text/auto-detected**: `gemini://workspace/files/{path}` — `mimeType` from extension; binary files return `blob` (base64) instead of `text`.

### 2.3 `_meta` schema

A single typed shape declared in `src/schemas/resource-meta.ts`:

```ts
{
  generatedAt: string;        // ISO datetime of this read
  source: 'static' | 'session' | 'workspace' | 'gemini-api';
  cached: boolean;            // true if served from memo cache
  ttlMs?: number;             // remaining TTL when cached
  size: number;               // byte length of primary content
  links?: ResourceLinkRef[];  // related resources the reader may follow
}
```

`ResourceLinkRef = { uri, name, description?, mimeType? }` — server-internal hint distinct from MCP's `ResourceLink` content block.

### 2.4 Lazy-link contract

Every tool result with associated rich state emits MCP `resource_link` content blocks at the **end** of `content[]`, after the human-readable text.

| Tool                                    | Always-emitted links                                                                     | Conditional links                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`, `research`, `analyze`, `review` | `gemini://session/{id}` (when sessionId present), `gemini://session/{id}/turn/{n}/parts` | `…/turn/{n}/grounding` (only when grounding metadata present); `gemini://workspace/cache` (only when cache used); `gemini://workspace/cache/contents` (only when assembled fresh) |

Rules:

- Links are terse — `description` is one short sentence.
- Links never appear inside `structuredContent`, only `content[]`.
- A new `appendResourceLinks(result, refs)` helper in `src/lib/response.ts` standardizes emission.

### 2.5 Fixed turn-parts contract

`gemini://session/{id}/turn/{n}/parts`:

- Sources from persisted `rawParts` already stored per turn in `SessionStore` (`src/sessions.ts`).
- Returns the documented `Part[]` shape verbatim (oversized `inlineData` elided as `{ mimeType, size, elided: true }`).
- **No Gemini API round-trip on read.** The current `getAI().interactions.get()` path is removed.
- Sessions without `rawParts` for the requested turn return `ResourceNotFound`.

### 2.6 Grounding rollup shape

`gemini://session/{id}/turn/{n}/grounding`:

```ts
{
  webSearch?: { queries: string[]; citations: { uri, title, snippet?, score? }[] };
  urlContext?: { url, title?, retrievedAt, snippet?, status }[];
  fileSearch?: { corpus, hits: { fileUri, title?, chunk, score }[] };
  codeExecution?: { language, code, stdout?, stderr?, exitCode? }[];
  raw?: unknown;  // full Gemini groundingMetadata, gated by MCP_EXPOSE_SESSION_RESOURCES
}
```

Sourced from per-turn metadata captured by `src/lib/streaming.ts`. Empty sections omitted. When unset entirely, the corresponding tool emits no grounding link.

### 2.7 Workspace files contract

- `gemini://workspace/files` → `{ files: { path, size, mtimeMs, score, included }[], totals: { count, includedCount, estimatedTokens } }` from `WorkspaceCacheManagerImpl` scan results.
- `gemini://workspace/files/{path}` → file content (`text` or `blob`). Path validated against `getAllowedRoots()` and the cache's scanned-file allow-list (no arbitrary FS access).

---

## Section 3 — Subscriptions and change notifications

### 3.1 Capability declaration

```ts
capabilities: {
  resources: {
    listChanged: true,
    subscribe: true,        // NEW
  },
  // ...
}
```

`debouncedNotificationMethods` retains both `notifications/resources/list_changed` and `notifications/resources/updated`.

### 3.2 Tiered notifier

A single `ResourceNotifier` in `src/lib/resource-notifier.ts` owns all `sendResourceListChanged` / `sendResourceUpdated` calls. All other modules dispatch through it.

| Tier                           | Resources                                                                                                                                                                          | Emits                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Static                         | `assistant://discover/catalog`, `…/workflows`, `assistant://profiles`, `assistant://instructions`                                                                                  | nothing                               |
| Catalog (listChanged only)     | `gemini://sessions`, `assistant://discover/context`, `gemini://workspace/files`                                                                                                    | `list_changed` on collection mutation |
| Live (subscribe + listChanged) | `gemini://session/{id}`, `…/transcript`, `…/events`, `…/turn/{n}/parts`, `…/turn/{n}/grounding`, `gemini://workspace/cache`, `…/cache/contents`, `gemini://workspace/files/{path}` | per-URI `resources/updated`           |

### 3.3 Trigger wiring

- `SessionStore.subscribe` (existing) → notifier emits:
  - `list_changed` for `gemini://sessions` on add/evict
  - `updated` for `gemini://session/{id}` on every change
  - `updated` for `…/transcript` and `…/events` (gated by `MCP_EXPOSE_SESSION_RESOURCES`)
  - `updated` for `…/turn/{n}/parts` and `…/turn/{n}/grounding` for the new turn index
- `WorkspaceCacheManagerImpl` gains `onChange(cb)`:
  - `updated` for `gemini://workspace/cache` on status change
  - `updated` for `…/cache/contents` on cache rebuild
  - `list_changed` for `gemini://workspace/files` on rescan when count or content hash changes
  - `updated` for `gemini://workspace/files/{path}` only for paths whose `mtimeMs` changed
- `server.server.onRootsListChanged` triggers a workspace rescan, which feeds the bullet above.
- `assistant://discover/context` is read-time freshly assembled with a 5 s memo and emits no notifications.

### 3.4 Stateless-mode handling

When `STATELESS=true` or `MCP_EXPOSE_SESSION_RESOURCES=false`:

- Session-tier resources are **not registered**.
- `gemini://sessions` always registers (returns empty list when stateless).
- The notifier silently no-ops for unregistered URIs.

### 3.5 Subscription bookkeeping

The MCP SDK handles `resources/subscribe` / `unsubscribe` natively. The server only calls `sendResourceUpdated({ uri })` on the right URIs at the right times.

### 3.6 Performance guards

- Existing SDK debouncing applies via `debouncedNotificationMethods`.
- `gemini://workspace/files/{path}` updates are capped at 50 unique paths per debounce window; beyond that the notifier emits a single `list_changed` on `gemini://workspace/files`.
- Notifier exposes `dispose()` invoked from `ServerInstance.close()`.

---

## Section 4 — Caching, performance, and security

### 4.1 ResourceMemo

`src/lib/resource-memo.ts`:

```ts
class ResourceMemo<K, V> {
  get(key: K, ttlMs: number, build: () => V | Promise<V>): Promise<V>;
  invalidate(key?: K): void;
}
```

Uses single-flight: concurrent reads for the same key share one in-flight `Promise`.

### 4.2 Per-resource TTLs

| Resource                                   | TTL                         | Invalidation                     |
| ------------------------------------------ | --------------------------- | -------------------------------- |
| `assistant://discover/catalog`             | ∞ (build once)              | never                            |
| `assistant://discover/workflows`           | ∞                           | never                            |
| `assistant://profiles`                     | ∞                           | never                            |
| `assistant://instructions`                 | ∞                           | never                            |
| `assistant://discover/context`             | 5 s                         | TTL only                         |
| `gemini://workspace/cache`                 | event-driven                | `WorkspaceCacheManager.onChange` |
| `gemini://workspace/cache/contents`        | event-driven                | same                             |
| `gemini://workspace/files`                 | event-driven                | rescan event                     |
| `gemini://workspace/files/{path}`          | per-path keyed by `mtimeMs` | path-level                       |
| `gemini://session/{id}/turn/{n}/parts`     | ∞ per `(id, n)`             | session evict                    |
| `gemini://session/{id}/turn/{n}/grounding` | ∞ per `(id, n)`             | session evict                    |

Other dynamic resources (sessions list, transcript, events, session detail) read directly from `SessionStore` — reads are O(1)/O(turns), no memo needed.

### 4.3 Eliminated redundant work

- `assembleWorkspaceContext(roots)` no longer runs on every `workspace://context` read; it runs only when `WorkspaceCacheManager` rebuilds.
- Discovery catalog rendering becomes a lazy-built singleton.

### 4.4 Path validation for `gemini://workspace/files/{path}`

1. Decode `{path}`, then `path.normalize()`.
2. Reject if normalized path contains `..` segments.
3. Reject if not absolute or not under any allowed root from `getAllowedRoots(rootsFetcher)`.
4. **Allow-list gate:** must appear in the most recent `WorkspaceCacheManager.scannedFiles`.
5. Symlinks resolved via `fs.realpath` and re-checked against allowed roots.
6. Max size 1 MiB; larger files return `ResourceNotFound` with a hint.
7. Binary detection: extension blacklist or first 8 KiB containing NUL bytes → `blob` (base64) with detected `mimeType` (`application/octet-stream` fallback). Otherwise `text` with charset `utf-8`.
8. All read errors map to `ProtocolErrorCode.ResourceNotFound` (no `ENOENT`/`EACCES` leaks).

### 4.5 Turn-parts security

- `id` and `n` validated as today (`/^\d+$/` for `n`).
- `n` must be `< turnCount`; otherwise `ResourceNotFound`.
- Source is in-memory `rawParts` / per-turn grounding metadata.
- Oversized `inlineData` elided.
- `raw` field on grounding gated by `MCP_EXPOSE_SESSION_RESOURCES`.

### 4.6 Concurrency

- Single-flight memo prevents thundering-herd rebuilds.
- `WorkspaceCacheManager.onChange` events dispatched on a microtask queue to avoid re-entrancy with the polling loop.

### 4.7 Token & size accounting

- `_meta.size` = byte length of primary content.
- `assistant://discover/context` adds `sessions.estimatedTokens` to its existing `workspace.estimatedTokens`.
- `gemini://workspace/files` includes per-file `score` and aggregate `estimatedTokens`.

---

## Section 5 — Implementation map and testing

### 5.1 Module layout

```text
src/
  resources.ts                    # registration entry only — slim (~80 lines)
  resources/                      # NEW directory
    uris.ts                       # URI constants + builders + template strings
    metadata.ts                   # _meta builder, lastModified/size helpers
    discover.ts                   # assistant://discover/* + assistant://profiles + assistant://instructions
    sessions.ts                   # gemini://sessions, …/session/{id}, …/transcript, …/events
    turns.ts                      # …/turn/{n}/parts and …/turn/{n}/grounding
    workspace.ts                  # gemini://workspace/cache, …/cache/contents, …/files, …/files/{path}
  lib/
    resource-notifier.ts          # NEW — single owner of resource notifications
    resource-memo.ts              # NEW — TTL + single-flight memo
    response.ts                   # extended with appendResourceLinks(result, refs)
    workspace-context.ts          # extended with onChange + scannedFiles allow-list export
    streaming.ts                  # captures groundingMetadata per turn → SessionStore
  sessions.ts                     # stores per-turn groundingMetadata alongside rawParts
  schemas/
    resource-meta.ts              # NEW — _meta zod schema
    grounding.ts                  # NEW — grounding rollup zod schema
  server.ts                       # capabilities.resources.subscribe = true; rewires notifier
  catalog.ts                      # updated URI strings in DISCOVERY_ENTRIES
  public-contract.ts              # updated resource entries
```

### 5.2 Removed code

- `getAI().interactions.get()` round-trip in turn-parts handler (~60 lines).
- `sessionTurnPartsResources()` empty-list shim — replaced by real list driven by `SessionStore.listTurnIndices(id)`.
- All ad-hoc `sendResourceUpdated` call sites in `server.ts` — moved to notifier.
- Legacy `discover://`, `session://`, `workspace://`, `gemini://profiles` constants — fully removed.

### 5.3 Config flags

No new env vars. Existing flags retained: `MCP_EXPOSE_SESSION_RESOURCES`, `WORKSPACE_CACHE_ENABLED`, `WORKSPACE_AUTO_SCAN`, `STATELESS`.

### 5.4 Testing strategy

| Test file                                 | Scope                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/resources/uris.test.ts`        | URI builders round-trip; percent-encoding; rejection of `..`                                                                    |
| `__tests__/resources/discover.test.ts`    | `assistant://*` shapes; `_meta.cached` toggling; memo TTL                                                                       |
| `__tests__/resources/sessions.test.ts`    | list/detail/transcript/events; gating; stateless skip                                                                           |
| `__tests__/resources/turns.test.ts`       | parts returns `Part[]`; grounding rollup with/without metadata; `n` out-of-range → ResourceNotFound; assert `getAI` not invoked |
| `__tests__/resources/workspace.test.ts`   | files inventory; `files/{path}` allow-list, `..` rejection, symlink-escape rejection, binary→blob, size cap                     |
| `__tests__/lib/resource-notifier.test.ts` | tier mapping; debounce; storm-cap fallback to listChanged; dispose detaches                                                     |
| `__tests__/lib/resource-memo.test.ts`     | TTL expiry; single-flight (5 concurrent reads → 1 build); invalidate                                                            |
| `__tests__/tools/*.test.ts` (extended)    | each tool emits expected `resource_link` blocks only when applicable                                                            |
| `__tests__/server.test.ts` (extended)     | capability advertises `subscribe: true`; subscribe → mutate → `resources/updated` received                                      |

E2e (`*.e2e.test.ts`) using `mock-gemini-environment.ts`:

- Full chat turn → assert `content` ends with a `resource_link` block whose URI resolves and returns valid `Part[]` for parts and a grounding rollup for grounding.
- `resources/list` returns the new URI set; old URIs absent (regression guard for hard cutover).

### 5.5 Verification gates

`node scripts/tasks.mjs` runs format → lint/type-check/knip → test/build. All must pass.

`.github/resources.md` is regenerated to match the new contract and committed alongside the implementation.

### 5.6 Risk register

| Risk                                   | Mitigation                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Hard cutover breaks downstream clients | MAJOR version bump in `package.json`; release notes document the URI mapping |
| Subscribe storm on bulk file edits     | 50-path debounce cap (Section 3.6)                                           |
| `…/files/{path}` arbitrary-FS-read     | Multi-layer validation (Section 4.4)                                         |
| Memoization staleness                  | Event-driven invalidation; static resources are truly static                 |
| Test surface explodes                  | One folder under `__tests__/resources/` mirrors `src/resources/`             |

---

## Out of scope

- Embedded-resource content blocks (`EmbeddedResource`) in tool replies — deferred.
- Cross-session deduplicated grounding library (`gemini://grounding/...` flat namespace) — deferred.
- Filesystem browser under `gemini://workspace/files/{...path}` for non-scanned files — deferred.
- Tool/prompt public-contract changes — out of scope.

---

## Open questions

None. All design choices confirmed during brainstorming.
