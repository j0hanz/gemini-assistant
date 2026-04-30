---
goal: Hard-cutover redesign of the MCP resource surface — two-scheme URIs, lazy resource_link contract, subscribe capability, grounding rollup, fixed turn-parts contract, memoization
version: 1
date_created: 2026-05-01
status: Planned
plan_type: refactor
component: resources
execution: subagent-driven
---

# Implementation Plan: Resources Redesign

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized; follow them in order, run every verification, and commit at each commit step.

**Goal:** Replace the existing 7-static + 4-template resource surface with a hard-cutover two-scheme design (`assistant://` static, `gemini://` live), advertise `subscribe: true`, fix the broken turn-parts contract (no Gemini API round-trip), add a per-turn grounding rollup, split workspace into `cache`/`cache/contents`/`files`/`files/{path}`, memoize reads with single-flight, and emit terse `resource_link` blocks from every tool result.

**Architecture:** The monolithic `src/resources.ts` (~1100 lines) splits into a slim registration entry plus one file per logical area under `src/resources/` (`uris`, `metadata`, `discover`, `sessions`, `turns`, `workspace`). A new `ResourceNotifier` ([src/lib/resource-notifier.ts](src/lib/resource-notifier.ts)) becomes the single owner of `sendResourceListChanged` / `sendResourceUpdated` calls; a new `ResourceMemo` ([src/lib/resource-memo.ts](src/lib/resource-memo.ts)) provides TTL + single-flight caching. Sessions persist per-turn `groundingMetadata` alongside `rawParts`. Tools append `resource_link` content blocks via a new `appendResourceLinks()` helper.

**Tech Stack:** TypeScript strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `@modelcontextprotocol/server` v2, `@google/genai` SDK, Zod v4, Node built-in test runner with `tsx/esm`, `node scripts/tasks.mjs` for verification.

---

## 1. Goal

After this plan:

- Every resource is reachable under either `assistant://` (static/meta) or `gemini://` (live model state). Old URIs (`session://`, `discover://`, `workspace://context`, `workspace://cache`, `gemini://profiles`, `gemini://sessions/{id}/turns/{n}/parts`) are deleted.
- `gemini://session/{id}/turn/{n}/parts` returns the documented `Part[]` from in-memory `rawParts` with no Gemini API round-trip.
- `gemini://session/{id}/turn/{n}/grounding` exposes Gemini grounding metadata (web citations, URL context, file-search hits, executed code) per turn.
- `gemini://workspace/files` lists scanned files with scores; `gemini://workspace/files/{path}` returns one file's content with strict path validation.
- Server advertises `resources.subscribe: true`. A single `ResourceNotifier` emits tier-appropriate `list_changed` / `updated` notifications.
- All four tools (`chat`, `research`, `analyze`, `review`) append terse `resource_link` blocks to their `content[]` output.
- `node scripts/tasks.mjs` passes; `package.json` MAJOR version is bumped; `.github/resources.md` reference doc is regenerated.

## 2. Requirements & Constraints

| ID                                        | Type        | Statement                                                                                                                                                                       |
| :---------------------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Two URI schemes only: `assistant://` (static/meta) and `gemini://` (live). All legacy URIs removed (hard cutover).                                                              |
| [`REQ-002`](#2-requirements--constraints) | Requirement | `gemini://session/{id}/turn/{n}/parts` reads from in-memory `rawParts` (no `getAI().interactions.get()` call) and returns the documented `Part[]` shape.                        |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `gemini://session/{id}/turn/{n}/grounding` returns `{ webSearch?, urlContext?, fileSearch?, codeExecution?, raw? }`; `raw` gated by `MCP_EXPOSE_SESSION_RESOURCES`.             |
| [`REQ-004`](#2-requirements--constraints) | Requirement | Server advertises `capabilities.resources = { listChanged: true, subscribe: true }`.                                                                                            |
| [`REQ-005`](#2-requirements--constraints) | Requirement | `ResourceNotifier` is the single owner of all `sendResourceListChanged` / `sendResourceUpdated` calls; tier-aware (static silent / catalog list-changed / live per-URI).        |
| [`REQ-006`](#2-requirements--constraints) | Requirement | `ResourceMemo` supplies TTL + single-flight caching for static catalogs (∞ TTL), `discover/context` (5 s), and event-driven workspace resources.                                |
| [`REQ-007`](#2-requirements--constraints) | Requirement | Every read-handler attaches `_meta: { generatedAt, source, cached, ttlMs?, size, links? }` and `annotations.lastModified` (ISO datetime).                                       |
| [`REQ-008`](#2-requirements--constraints) | Requirement | Every tool (`chat`, `research`, `analyze`, `review`) appends terse `resource_link` content blocks via `appendResourceLinks()`; links never appear inside `structuredContent`.   |
| [`REQ-009`](#2-requirements--constraints) | Requirement | `gemini://workspace/files/{path}` enforces: normalized-`..` rejection, allowed-roots gate, `WorkspaceCacheManager.scannedFiles` allow-list, symlink real-path recheck, ≤ 1 MiB. |
| [`REQ-010`](#2-requirements--constraints) | Requirement | Sessions store per-turn `groundingMetadata` alongside `rawParts`; `streaming.ts` captures `groundingMetadata` from each completion.                                             |
| [`REQ-011`](#2-requirements--constraints) | Requirement | When `STATELESS=true` or `MCP_EXPOSE_SESSION_RESOURCES=false`, session-tier resources are not registered (current code registers and rejects on read).                          |
| [`REQ-012`](#2-requirements--constraints) | Requirement | `package.json` MAJOR version bumped; `.github/resources.md` regenerated to match the new contract.                                                                              |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No `console.log` — use `logger` from [src/lib/logger.ts](src/lib/logger.ts).                                                                                                    |
| [`CON-002`](#2-requirements--constraints) | Constraint  | TypeScript strict mode; optional fields use `?:` + `\| undefined` only on inline object types, not standalone params.                                                           |
| [`CON-003`](#2-requirements--constraints) | Constraint  | ESM imports include `.js` extensions; Zod imports use `import { z } from 'zod/v4'`.                                                                                             |
| [`CON-004`](#2-requirements--constraints) | Constraint  | No new env vars. Existing flags (`MCP_EXPOSE_SESSION_RESOURCES`, `WORKSPACE_CACHE_ENABLED`, `WORKSPACE_AUTO_SCAN`, `STATELESS`) retained.                                       |
| [`CON-005`](#2-requirements--constraints) | Constraint  | Run `node scripts/tasks.mjs` before every commit step.                                                                                                                          |
| [`CON-006`](#2-requirements--constraints) | Constraint  | Public tool/prompt contract ([src/public-contract.ts](src/public-contract.ts)) tools and prompts sections are not modified — only the resources section is updated.             |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | One file per logical area under `src/resources/`; the existing `src/resources.ts` becomes a thin registration entry (~80 lines).                                                |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | All read errors map to `ProtocolErrorCode.ResourceNotFound` (no `ENOENT`/`EACCES` leaks); template-param errors use `InvalidParams`.                                            |

## 3. Current Context

### File structure

| File                                                                                 | Status | Responsibility                                                                                                          |
| :----------------------------------------------------------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------------------- |
| [src/resources.ts](src/resources.ts)                                                 | Modify | Reduce to ~80-line registration entry; delegate to `src/resources/*`                                                    |
| [src/resources/uris.ts](src/resources/uris.ts)                                       | Create | URI constants, builders, template strings, `decodeTemplateParam`, path-normalize helpers                                |
| [src/resources/metadata.ts](src/resources/metadata.ts)                               | Create | `_meta` builder, `lastModified`/`size` helpers, `dualContentResource` / `jsonResource` / `textResource` helpers         |
| [src/resources/discover.ts](src/resources/discover.ts)                               | Create | `assistant://discover/*`, `assistant://profiles`, `assistant://instructions` registration + handlers                    |
| [src/resources/sessions.ts](src/resources/sessions.ts)                               | Create | `gemini://sessions`, `gemini://session/{id}`, `…/transcript`, `…/events` registration + handlers                        |
| [src/resources/turns.ts](src/resources/turns.ts)                                     | Create | `gemini://session/{id}/turn/{n}/parts` and `…/grounding` (in-memory, no Gemini round-trip)                              |
| [src/resources/workspace.ts](src/resources/workspace.ts)                             | Create | `gemini://workspace/cache`, `…/cache/contents`, `…/files`, `…/files/{path}`                                             |
| [src/lib/resource-notifier.ts](src/lib/resource-notifier.ts)                         | Create | Single owner of all resource notifications; tier-aware                                                                  |
| [src/lib/resource-memo.ts](src/lib/resource-memo.ts)                                 | Create | TTL + single-flight memo                                                                                                |
| [src/lib/response.ts](src/lib/response.ts)                                           | Modify | Add `appendResourceLinks(result, refs)` helper                                                                          |
| [src/lib/streaming.ts](src/lib/streaming.ts)                                         | Modify | Capture `groundingMetadata` per turn into the session                                                                   |
| [src/lib/workspace-context.ts](src/lib/workspace-context.ts)                         | Modify | Expose `onChange(cb)`, `scannedFiles` allow-list, `getFileEntry(path)`                                                  |
| [src/sessions.ts](src/sessions.ts)                                                   | Modify | Persist per-turn `groundingMetadata`; expose `listTurnIndices(id)`, `getTurnRawParts(id, n)`, `getTurnGrounding(id, n)` |
| [src/server.ts](src/server.ts)                                                       | Modify | Set `capabilities.resources.subscribe = true`; rewire all notification calls to `ResourceNotifier`                      |
| [src/catalog.ts](src/catalog.ts)                                                     | Modify | Update `DISCOVERY_ENTRIES` resource URIs to new scheme                                                                  |
| [src/public-contract.ts](src/public-contract.ts)                                     | Modify | Update `RESOURCE_ENTRIES` URIs and descriptions                                                                         |
| [src/tools/chat.ts](src/tools/chat.ts)                                               | Modify | Call `appendResourceLinks()` at end of handler                                                                          |
| [src/tools/research.ts](src/tools/research.ts)                                       | Modify | Same                                                                                                                    |
| [src/tools/analyze.ts](src/tools/analyze.ts)                                         | Modify | Same                                                                                                                    |
| [src/tools/review.ts](src/tools/review.ts)                                           | Modify | Same                                                                                                                    |
| [src/schemas/resource-meta.ts](src/schemas/resource-meta.ts)                         | Create | Zod schema for `_meta` shape                                                                                            |
| [src/schemas/grounding.ts](src/schemas/grounding.ts)                                 | Create | Zod schema for grounding rollup                                                                                         |
| [.github/resources.md](.github/resources.md)                                         | Modify | Regenerate to match new URI contract                                                                                    |
| [package.json](package.json)                                                         | Modify | Bump MAJOR version                                                                                                      |
| [`__tests__/resources/uris.test.ts`](__tests__/resources/uris.test.ts)               | Create | URI builder round-trip + path validation tests                                                                          |
| [`__tests__/resources/discover.test.ts`](__tests__/resources/discover.test.ts)       | Create | `assistant://*` shape + memo TTL tests                                                                                  |
| [`__tests__/resources/sessions.test.ts`](__tests__/resources/sessions.test.ts)       | Create | session list/detail/transcript/events tests                                                                             |
| [`__tests__/resources/turns.test.ts`](__tests__/resources/turns.test.ts)             | Create | parts + grounding handler tests; assert no `getAI` invocation                                                           |
| [`__tests__/resources/workspace.test.ts`](__tests__/resources/workspace.test.ts)     | Create | files inventory + path-validation tests                                                                                 |
| [`__tests__/lib/resource-notifier.test.ts`](__tests__/lib/resource-notifier.test.ts) | Create | tier-mapping + storm-cap tests                                                                                          |
| [`__tests__/lib/resource-memo.test.ts`](__tests__/lib/resource-memo.test.ts)         | Create | TTL + single-flight tests                                                                                               |
| [`__tests__/resources.test.ts`](__tests__/resources.test.ts)                         | Modify | Replace legacy-URI assertions with new URIs; keep regression coverage                                                   |

### Relevant symbols

| Symbol                                                    | Why it matters                                                                             |
| :-------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| [registerResources](src/resources.ts)                     | Public entry point; will delegate to per-area registrars                                   |
| [registerSessionResources](src/resources.ts)              | Will move into `src/resources/sessions.ts` + `turns.ts` and rename URIs                    |
| [getSessionTurnPartsResourceData](src/resources.ts)       | Currently calls `getAI().interactions.get()`; rewrite to read from `SessionStore.rawParts` |
| [SessionStore](src/sessions.ts)                           | Will gain `listTurnIndices`, `getTurnRawParts`, `getTurnGrounding` accessors               |
| [WorkspaceCacheManagerImpl](src/lib/workspace-context.ts) | Will expose `onChange`, `scannedFiles`, `getFileEntry`                                     |
| [sendResourceUpdatedForServer](src/server.ts)             | Replaced by `ResourceNotifier`                                                             |
| [SessionChangeEvent](src/sessions.ts)                     | Subscribed in server.ts to drive notifications; will route through notifier instead        |
| [buildToolResult](src/lib/response.ts)                    | Tool-result helper; gains a new sibling `appendResourceLinks`                              |
| [StreamingContext](src/lib/streaming.ts)                  | Will capture `groundingMetadata` from each completion event                                |

### Existing commands

```bash
# Full verification suite (format → lint/type-check/knip → test/build)
node scripts/tasks.mjs

# Single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts
```

### Current behaviour

Resources live in a 1100-line `src/resources.ts` with 7 static URIs (`session://`, `discover://catalog|workflows|context`, `gemini://profiles`, `workspace://context|cache`) and 4 templates (`session://{id}`, `…/transcript`, `…/events`, `gemini://sessions/{id}/turns/{n}/parts`). The turn-parts handler does a Gemini API round-trip on every read and returns `{outputs, status}` instead of `Part[]`. `subscribe: true` is not advertised. Tools never emit `resource_link` blocks.

---

## 4. Implementation Phases

The plan has **six phases**. Each phase ends with `node scripts/tasks.mjs` passing and a commit.

| Phase   | Theme                                                       | Tasks               |
| :------ | :---------------------------------------------------------- | :------------------ |
| PHASE-1 | Foundations: schemas, memo, notifier, URI module            | TASK-101 → TASK-104 |
| PHASE-2 | Session-store extensions for turns + grounding              | TASK-201 → TASK-202 |
| PHASE-3 | New resource modules (discover, sessions, turns, workspace) | TASK-301 → TASK-304 |
| PHASE-4 | Tool resource_link emission                                 | TASK-401 → TASK-402 |
| PHASE-5 | Wire-up: server.ts, capabilities, public-contract           | TASK-501 → TASK-503 |
| PHASE-6 | Cleanup, docs, version bump                                 | TASK-601 → TASK-602 |

---

### PHASE-1 — Foundations

**Goal:** Land the standalone primitives (schemas, memo, notifier, URI module) without touching existing resource handlers. Each is independently testable.

#### TASK-101: `_meta` and grounding zod schemas

| Field      | Value                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                       |
| Files      | Create: [src/schemas/resource-meta.ts](src/schemas/resource-meta.ts), [src/schemas/grounding.ts](src/schemas/grounding.ts) |
| Outcome    | Zod v4 schemas for `_meta` and grounding rollup compile and export their inferred types.                                   |

- [ ] **Step 1:** Create [src/schemas/resource-meta.ts](src/schemas/resource-meta.ts):

```ts
import { z } from 'zod/v4';

export const ResourceLinkRefSchema = z.strictObject({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceLinkRef = z.infer<typeof ResourceLinkRefSchema>;

export const ResourceMetaSchema = z.strictObject({
  generatedAt: z.string(),
  source: z.enum(['static', 'session', 'workspace', 'gemini-api']),
  cached: z.boolean(),
  ttlMs: z.number().int().nonnegative().optional(),
  size: z.number().int().nonnegative(),
  links: z.array(ResourceLinkRefSchema).optional(),
});
export type ResourceMeta = z.infer<typeof ResourceMetaSchema>;
```

- [ ] **Step 2:** Create [src/schemas/grounding.ts](src/schemas/grounding.ts):

```ts
import { z } from 'zod/v4';

export const WebCitationSchema = z.strictObject({
  uri: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  score: z.number().optional(),
});

export const UrlContextEntrySchema = z.strictObject({
  url: z.string(),
  title: z.string().optional(),
  retrievedAt: z.string(),
  snippet: z.string().optional(),
  status: z.string(),
});

export const FileSearchHitSchema = z.strictObject({
  fileUri: z.string(),
  title: z.string().optional(),
  chunk: z.string(),
  score: z.number(),
});

export const CodeExecutionEntrySchema = z.strictObject({
  language: z.string(),
  code: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().optional(),
});

export const GroundingRollupSchema = z.strictObject({
  webSearch: z
    .strictObject({
      queries: z.array(z.string()),
      citations: z.array(WebCitationSchema),
    })
    .optional(),
  urlContext: z.array(UrlContextEntrySchema).optional(),
  fileSearch: z
    .strictObject({
      corpus: z.string(),
      hits: z.array(FileSearchHitSchema),
    })
    .optional(),
  codeExecution: z.array(CodeExecutionEntrySchema).optional(),
  raw: z.unknown().optional(),
});
export type GroundingRollup = z.infer<typeof GroundingRollupSchema>;
```

- [ ] **Step 3:** Verify type-check passes:

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 4:** Commit:

```bash
git add src/schemas/resource-meta.ts src/schemas/grounding.ts
git commit -m "feat(schemas): add ResourceMeta and GroundingRollup zod schemas"
```

#### TASK-102: `ResourceMemo` (TTL + single-flight)

| Field      | Value                                                                                                                                                             |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                              |
| Files      | Create: [src/lib/resource-memo.ts](src/lib/resource-memo.ts), [`__tests__/lib/resource-memo.test.ts`](__tests__/lib/resource-memo.test.ts)                        |
| Outcome    | `ResourceMemo<K, V>` class with `get(key, ttlMs, build)` and `invalidate(key?)`. Concurrent reads share one in-flight `Promise`. TTL of `Infinity` never expires. |

- [ ] **Step 1:** Create the failing test [`__tests__/lib/resource-memo.test.ts`](__tests__/lib/resource-memo.test.ts):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ResourceMemo } from '../../src/lib/resource-memo.js';

test('ResourceMemo: returns cached value within TTL', async () => {
  const memo = new ResourceMemo<string, number>();
  let calls = 0;
  const v1 = await memo.get('k', 60_000, () => ++calls);
  const v2 = await memo.get('k', 60_000, () => ++calls);
  assert.equal(v1, 1);
  assert.equal(v2, 1);
  assert.equal(calls, 1);
});

test('ResourceMemo: rebuilds after TTL expires', async () => {
  const memo = new ResourceMemo<string, number>();
  let calls = 0;
  await memo.get('k', 1, () => ++calls);
  await new Promise((r) => setTimeout(r, 5));
  await memo.get('k', 1, () => ++calls);
  assert.equal(calls, 2);
});

test('ResourceMemo: single-flight — concurrent reads share one build', async () => {
  const memo = new ResourceMemo<string, number>();
  let calls = 0;
  const build = async (): Promise<number> => {
    await new Promise((r) => setTimeout(r, 10));
    return ++calls;
  };
  const results = await Promise.all([
    memo.get('k', 60_000, build),
    memo.get('k', 60_000, build),
    memo.get('k', 60_000, build),
    memo.get('k', 60_000, build),
    memo.get('k', 60_000, build),
  ]);
  assert.deepEqual(results, [1, 1, 1, 1, 1]);
  assert.equal(calls, 1);
});

test('ResourceMemo: invalidate forces rebuild', async () => {
  const memo = new ResourceMemo<string, number>();
  let calls = 0;
  await memo.get('k', 60_000, () => ++calls);
  memo.invalidate('k');
  await memo.get('k', 60_000, () => ++calls);
  assert.equal(calls, 2);
});

test('ResourceMemo: invalidate() with no key clears all', async () => {
  const memo = new ResourceMemo<string, number>();
  let calls = 0;
  await memo.get('a', 60_000, () => ++calls);
  await memo.get('b', 60_000, () => ++calls);
  memo.invalidate();
  await memo.get('a', 60_000, () => ++calls);
  await memo.get('b', 60_000, () => ++calls);
  assert.equal(calls, 4);
});
```

- [ ] **Step 2:** Verify tests fail:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/resource-memo.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3:** Create [src/lib/resource-memo.ts](src/lib/resource-memo.ts):

```ts
interface MemoEntry<V> {
  value: V;
  expiresAt: number;
}

export class ResourceMemo<K, V> {
  private readonly cache = new Map<K, MemoEntry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  async get(key: K, ttlMs: number, build: () => V | Promise<V>): Promise<V> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<V> => {
      try {
        const value = await build();
        const expiresAt =
          ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
        this.cache.set(key, { value, expiresAt });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key?: K): void {
    if (key === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(key);
  }
}
```

- [ ] **Step 4:** Verify tests pass:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/resource-memo.test.ts
```

Expected: 5/5 passed.

- [ ] **Step 5:** Commit:

```bash
git add src/lib/resource-memo.ts __tests__/lib/resource-memo.test.ts
git commit -m "feat(lib): add ResourceMemo with TTL + single-flight"
```

#### TASK-103: `ResourceNotifier` (tier-aware notifications)

| Field      | Value                                                                                                                                                            |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-102                                                                                                                                                         |
| Files      | Create: [src/lib/resource-notifier.ts](src/lib/resource-notifier.ts), [`__tests__/lib/resource-notifier.test.ts`](__tests__/lib/resource-notifier.test.ts)       |
| Outcome    | `ResourceNotifier` with `notifyListChanged(uri)`, `notifyUpdated(uri)`, `notifyFilesChanged(paths[])` (storm-cap to list-changed at >50 paths), and `dispose()`. |

- [ ] **Step 1:** Create the failing test [`__tests__/lib/resource-notifier.test.ts`](__tests__/lib/resource-notifier.test.ts):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ResourceNotifier } from '../../src/lib/resource-notifier.js';

interface FakeServer {
  listChanged: string[];
  updated: string[];
  sendResourceListChanged(): void;
  sendResourceUpdated(params: { uri: string }): Promise<void>;
}

function fakeServer(): FakeServer {
  return {
    listChanged: [],
    updated: [],
    sendResourceListChanged() {
      this.listChanged.push('all');
    },
    async sendResourceUpdated(params) {
      this.updated.push(params.uri);
    },
  };
}

test('notifyUpdated emits per-URI', async () => {
  const srv = fakeServer();
  const n = new ResourceNotifier(srv);
  await n.notifyUpdated('gemini://session/abc');
  assert.deepEqual(srv.updated, ['gemini://session/abc']);
});

test('notifyListChanged emits collection notification', async () => {
  const srv = fakeServer();
  const n = new ResourceNotifier(srv);
  await n.notifyListChanged();
  assert.equal(srv.listChanged.length, 1);
});

test('notifyFilesChanged storm-caps at 50 paths', async () => {
  const srv = fakeServer();
  const n = new ResourceNotifier(srv);
  const paths = Array.from({ length: 51 }, (_, i) => `/r/f${i}.ts`);
  await n.notifyFilesChanged(paths);
  // Above cap: collection-level list_changed instead of per-path updates
  assert.equal(srv.listChanged.length, 1);
  assert.equal(srv.updated.length, 0);
});

test('notifyFilesChanged under cap emits per-path updates', async () => {
  const srv = fakeServer();
  const n = new ResourceNotifier(srv);
  await n.notifyFilesChanged(['/r/a.ts', '/r/b.ts']);
  assert.equal(srv.updated.length, 2);
  assert.equal(srv.listChanged.length, 0);
});

test('dispose makes subsequent notifications no-op', async () => {
  const srv = fakeServer();
  const n = new ResourceNotifier(srv);
  n.dispose();
  await n.notifyUpdated('gemini://session/x');
  await n.notifyListChanged();
  assert.equal(srv.updated.length, 0);
  assert.equal(srv.listChanged.length, 0);
});
```

- [ ] **Step 2:** Verify tests fail:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/resource-notifier.test.ts
```

- [ ] **Step 3:** Create [src/lib/resource-notifier.ts](src/lib/resource-notifier.ts):

```ts
import { fileResourceUri } from '../resources/uris.js';
import { logger } from './logger.js';

interface NotifierServer {
  sendResourceListChanged(): void;
  sendResourceUpdated(params: { uri: string }): Promise<void>;
}

const FILE_STORM_CAP = 50;
const FILES_COLLECTION_URI = 'gemini://workspace/files';

export class ResourceNotifier {
  private disposed = false;
  private readonly log = logger.child('resource-notifier');

  constructor(private readonly server: NotifierServer) {}

  async notifyUpdated(uri: string): Promise<void> {
    if (this.disposed) return;
    try {
      await this.server.sendResourceUpdated({ uri });
    } catch (err) {
      this.log.warn('sendResourceUpdated failed', { uri, err: String(err) });
    }
  }

  async notifyListChanged(): Promise<void> {
    if (this.disposed) return;
    try {
      this.server.sendResourceListChanged();
    } catch (err) {
      this.log.warn('sendResourceListChanged failed', { err: String(err) });
    }
  }

  async notifyFilesChanged(paths: readonly string[]): Promise<void> {
    if (this.disposed) return;
    if (paths.length > FILE_STORM_CAP) {
      await this.notifyListChanged();
      return;
    }
    await Promise.all(paths.map((p) => this.notifyUpdated(fileResourceUri(p))));
  }

  dispose(): void {
    this.disposed = true;
  }
}
```

> Note: `fileResourceUri` is implemented in TASK-104. Until then, the test passes `paths` whose URI form happens to match `gemini://workspace/files/<path>` exactly through the helper.

- [ ] **Step 4:** Verify tests pass (after TASK-104, since `fileResourceUri` is referenced). Defer running until end of TASK-104.

- [ ] **Step 5:** No commit yet — wait for TASK-104.

#### TASK-104: URI module

| Field      | Value                                                                                                                                                             |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-103                                                                                                                                                          |
| Files      | Create: [src/resources/uris.ts](src/resources/uris.ts), [`__tests__/resources/uris.test.ts`](__tests__/resources/uris.test.ts)                                    |
| Outcome    | URI constants, builders, template strings, `decodeTemplateParam` (existing logic moved verbatim), `validateScannedFilePath()` for `…/files/{path}` security gate. |

- [ ] **Step 1:** Create the failing test [`__tests__/resources/uris.test.ts`](__tests__/resources/uris.test.ts):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fileResourceUri,
  parseFileResourcePath,
  sessionResourceUri,
  turnGroundingUri,
  turnPartsUri,
} from '../../src/resources/uris.js';

test('sessionResourceUri encodes id', () => {
  assert.equal(sessionResourceUri('a/b'), 'gemini://session/a%2Fb');
});

test('turnPartsUri builds template', () => {
  assert.equal(turnPartsUri('s1', 3), 'gemini://session/s1/turn/3/parts');
});

test('turnGroundingUri builds template', () => {
  assert.equal(turnGroundingUri('s1', 3), 'gemini://session/s1/turn/3/grounding');
});

test('fileResourceUri encodes path', () => {
  assert.equal(fileResourceUri('/r/a b.ts'), 'gemini://workspace/files/%2Fr%2Fa%20b.ts');
});

test('parseFileResourcePath round-trips', () => {
  const uri = fileResourceUri('/r/a b.ts');
  assert.equal(parseFileResourcePath(uri), '/r/a b.ts');
});

test('parseFileResourcePath returns undefined for non-file URI', () => {
  assert.equal(parseFileResourcePath('gemini://session/x'), undefined);
});
```

- [ ] **Step 2:** Verify tests fail.

- [ ] **Step 3:** Create [src/resources/uris.ts](src/resources/uris.ts):

```ts
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

// ============================== assistant:// ==============================
export const ASSISTANT_DISCOVER_CATALOG_URI = 'assistant://discover/catalog' as const;
export const ASSISTANT_DISCOVER_WORKFLOWS_URI = 'assistant://discover/workflows' as const;
export const ASSISTANT_DISCOVER_CONTEXT_URI = 'assistant://discover/context' as const;
export const ASSISTANT_PROFILES_URI = 'assistant://profiles' as const;
export const ASSISTANT_INSTRUCTIONS_URI = 'assistant://instructions' as const;

// ============================== gemini:// =================================
export const SESSIONS_LIST_URI = 'gemini://sessions' as const;
export const WORKSPACE_CACHE_URI = 'gemini://workspace/cache' as const;
export const WORKSPACE_CACHE_CONTENTS_URI = 'gemini://workspace/cache/contents' as const;
export const WORKSPACE_FILES_URI = 'gemini://workspace/files' as const;

export const SESSION_DETAIL_TEMPLATE = 'gemini://session/{sessionId}' as const;
export const SESSION_TRANSCRIPT_TEMPLATE = 'gemini://session/{sessionId}/transcript' as const;
export const SESSION_EVENTS_TEMPLATE = 'gemini://session/{sessionId}/events' as const;
export const TURN_PARTS_TEMPLATE = 'gemini://session/{sessionId}/turn/{turnIndex}/parts' as const;
export const TURN_GROUNDING_TEMPLATE =
  'gemini://session/{sessionId}/turn/{turnIndex}/grounding' as const;
export const FILE_RESOURCE_TEMPLATE = 'gemini://workspace/files/{path}' as const;

export function sessionResourceUri(sessionId: string): string {
  return `gemini://session/${encodeURIComponent(sessionId)}`;
}
export function sessionTranscriptUri(sessionId: string): string {
  return `${sessionResourceUri(sessionId)}/transcript`;
}
export function sessionEventsUri(sessionId: string): string {
  return `${sessionResourceUri(sessionId)}/events`;
}
export function turnPartsUri(sessionId: string, turnIndex: number): string {
  return `gemini://session/${encodeURIComponent(sessionId)}/turn/${String(turnIndex)}/parts`;
}
export function turnGroundingUri(sessionId: string, turnIndex: number): string {
  return `gemini://session/${encodeURIComponent(sessionId)}/turn/${String(turnIndex)}/grounding`;
}
export function fileResourceUri(path: string): string {
  return `gemini://workspace/files/${encodeURIComponent(path)}`;
}
export function parseFileResourcePath(uri: string): string | undefined {
  const prefix = 'gemini://workspace/files/';
  if (!uri.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(uri.slice(prefix.length));
  } catch {
    return undefined;
  }
}

// ============================ template params =============================
export function normalizeTemplateParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function decodeTemplateParam(value: string | string[] | undefined): string | undefined {
  const normalized = normalizeTemplateParam(value);
  if (normalized === undefined) return undefined;
  try {
    return decodeURIComponent(normalized);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Invalid percent-encoding in resource URI parameter',
    );
  }
}

export function requireTemplateParam(value: string | string[] | undefined, label: string): string {
  const decoded = decodeTemplateParam(value);
  if (!decoded) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${label} required`);
  }
  return decoded;
}
```

- [ ] **Step 4:** Run both URI and notifier test suites:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources/uris.test.ts __tests__/lib/resource-notifier.test.ts
```

Expected: all tests pass.

- [ ] **Step 5:** Run full task suite:

```bash
node scripts/tasks.mjs --quick
```

- [ ] **Step 6:** Commit:

```bash
git add src/lib/resource-notifier.ts src/resources/uris.ts __tests__/lib/resource-notifier.test.ts __tests__/resources/uris.test.ts
git commit -m "feat(resources): add ResourceNotifier and URI module"
```

---

### PHASE-2 — Session-store extensions

**Goal:** Persist per-turn `groundingMetadata` alongside `rawParts`, and expose accessors needed by `turns.ts`.

#### TASK-201: Capture `groundingMetadata` in streaming

| Field      | Value                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                      |
| Files      | Modify: [src/lib/streaming.ts](src/lib/streaming.ts), [`__tests__/lib/streaming.test.ts`](__tests__/lib/streaming.test.ts)                                |
| Outcome    | The `StreamingContext` accumulates `groundingMetadata` from each completion event into a single rollup; emitted alongside `rawParts` in the final result. |

- [ ] **Step 1:** Read [src/lib/streaming.ts](src/lib/streaming.ts) to find the per-event accumulator. Locate the `consumeStream()` (or equivalent) function that handles `candidates[0].groundingMetadata`.

- [ ] **Step 2:** Add a failing test in [`__tests__/lib/streaming.test.ts`](__tests__/lib/streaming.test.ts) that feeds two mock events (one with `webSearchQueries`, one with `groundingChunks`) and asserts the returned `groundingMetadata` rollup includes both.

```ts
test('streaming: accumulates groundingMetadata across events', async () => {
  const events = [
    { candidates: [{ groundingMetadata: { webSearchQueries: ['typescript zod'] } }] },
    {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
          },
        },
      ],
    },
  ];
  const result = await consumeStream(/* mock async iterable from events */);
  assert.deepEqual(result.groundingMetadata.webSearchQueries, ['typescript zod']);
  assert.equal(result.groundingMetadata.groundingChunks?.[0]?.web?.uri, 'https://example.com');
});
```

- [ ] **Step 3:** Run the test, confirm it fails (no `groundingMetadata` field on result).

- [ ] **Step 4:** Modify [src/lib/streaming.ts](src/lib/streaming.ts) — add a `groundingMetadata` accumulator to the streaming context, merge each event's `candidates[0].groundingMetadata` into it, and include it in the returned result type.

- [ ] **Step 5:** Run all streaming tests:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts
```

- [ ] **Step 6:** Commit:

```bash
git add src/lib/streaming.ts __tests__/lib/streaming.test.ts
git commit -m "feat(streaming): accumulate groundingMetadata per turn"
```

#### TASK-202: SessionStore turn accessors

| Field      | Value                                                                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-201                                                                                                                                                                                                  |
| Files      | Modify: [src/sessions.ts](src/sessions.ts), [`__tests__/sessions.test.ts`](__tests__/sessions.test.ts)                                                                                                    |
| Outcome    | `SessionStore` persists per-turn `groundingMetadata` and exposes `listTurnIndices(id): number[]`, `getTurnRawParts(id, n): Part[] \| undefined`, `getTurnGrounding(id, n): GroundingRollup \| undefined`. |

- [ ] **Step 1:** In [`__tests__/sessions.test.ts`](__tests__/sessions.test.ts), add a failing test:

```ts
test('SessionStore: stores and retrieves per-turn grounding', () => {
  const store = createSessionStore();
  const id = store.createSession();
  store.appendTurn(id, {
    role: 'assistant',
    parts: [{ text: 'hi' }],
    rawParts: [{ text: 'hi' }],
    groundingMetadata: { webSearchQueries: ['q'] },
  });
  assert.deepEqual(store.listTurnIndices(id), [0]);
  assert.equal(store.getTurnRawParts(id, 0)?.[0]?.text, 'hi');
  assert.equal(store.getTurnGrounding(id, 0)?.webSearch?.queries[0], 'q');
});
```

- [ ] **Step 2:** Run the test; confirm it fails.

- [ ] **Step 3:** Modify [src/sessions.ts](src/sessions.ts):
  - Extend the per-turn record to include `groundingMetadata?: unknown` (raw shape from Gemini SDK).
  - Add `listTurnIndices(sessionId: string): number[]`.
  - Add `getTurnRawParts(sessionId: string, turnIndex: number): Part[] | undefined`.
  - Add `getTurnGrounding(sessionId: string, turnIndex: number): GroundingRollup | undefined` — converts raw `groundingMetadata` into the `GroundingRollup` shape from [src/schemas/grounding.ts](src/schemas/grounding.ts) (web → `webSearch.citations`, urlContextMetadata → `urlContext`, etc.).
  - Update the `appendTurn` (or equivalent) signature to accept and store the optional `groundingMetadata`.
  - Update `SessionChangeEvent.turnPartsAdded` to also carry the new turn's grounding presence flag (used in PHASE-5 to fire `…/grounding` updates only when grounding exists).

- [ ] **Step 4:** Run sessions tests:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

- [ ] **Step 5:** Run `npm run type-check` and fix any callers (chat tool, streaming consumer).

- [ ] **Step 6:** Commit:

```bash
git add src/sessions.ts __tests__/sessions.test.ts src/tools/chat.ts
git commit -m "feat(sessions): persist per-turn grounding and expose turn accessors"
```

---

### PHASE-3 — New resource modules

**Goal:** Replace the monolithic `src/resources.ts` with one file per logical area. Each module exports a `register*Resources(server, deps)` function and is independently tested.

> **Module guidance:** Every read handler MUST attach `_meta` via a shared `buildMeta()` helper in [src/resources/metadata.ts](src/resources/metadata.ts) and set `annotations.lastModified`. Every error path uses `ProtocolError(ResourceNotFound)` for missing resources and `ProtocolError(InvalidParams)` for malformed template params (already enforced by `requireTemplateParam`).

#### TASK-301: `metadata.ts` shared helpers

| Field      | Value                                                                                                                                                                                                                       |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-101, TASK-104                                                                                                                                                                                                          |
| Files      | Create: [src/resources/metadata.ts](src/resources/metadata.ts)                                                                                                                                                              |
| Outcome    | Exports `buildMeta()`, `jsonResource()`, `dualContentResource()`, `textResource()`, `blobResource()`, `byteSize()`. Existing equivalents in `src/resources.ts` are moved here verbatim and extended with `_meta` injection. |

- [ ] **Step 1:** Create [src/resources/metadata.ts](src/resources/metadata.ts) (port the existing helpers from [src/resources.ts](src/resources.ts) lines ~95-130 and add `_meta` injection):

```ts
import type { ReadResourceResult } from '@modelcontextprotocol/server';

import type { ResourceLinkRef, ResourceMeta } from '../schemas/resource-meta.js';

const MIME_JSON = 'application/json' as const;
const MIME_MARKDOWN = 'text/markdown' as const;
const MIME_TEXT = 'text/plain' as const;

export interface BuildMetaInput {
  source: ResourceMeta['source'];
  cached: boolean;
  ttlMs?: number;
  size: number;
  links?: ResourceLinkRef[];
}

export function buildMeta(input: BuildMetaInput): ResourceMeta {
  return {
    generatedAt: new Date().toISOString(),
    source: input.source,
    cached: input.cached,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    size: input.size,
    ...(input.links ? { links: input.links } : {}),
  };
}

export function byteSize(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

export function toResourceUri(uri: URL | string): string {
  return typeof uri === 'string' ? uri : uri.href;
}

export interface ContentEnvelopeOptions {
  meta: ResourceMeta;
  lastModified?: string;
}

export function jsonResource(
  uri: URL | string,
  data: unknown,
  opts: ContentEnvelopeOptions,
): ReadResourceResult {
  const text = JSON.stringify(data);
  return {
    contents: [
      {
        uri: toResourceUri(uri),
        mimeType: MIME_JSON,
        text,
        ...(opts.lastModified ? { annotations: { lastModified: opts.lastModified } } : {}),
        _meta: { ...opts.meta },
      },
    ],
  };
}

export function dualContentResource(
  uri: URL | string,
  data: unknown,
  markdown: string,
  opts: ContentEnvelopeOptions,
): ReadResourceResult {
  const json = JSON.stringify(data);
  const u = toResourceUri(uri);
  const ann = opts.lastModified ? { annotations: { lastModified: opts.lastModified } } : {};
  return {
    contents: [
      { uri: u, mimeType: MIME_JSON, text: json, ...ann, _meta: { ...opts.meta } },
      { uri: u, mimeType: MIME_MARKDOWN, text: markdown, ...ann },
    ],
  };
}

export function textResource(
  uri: URL | string,
  text: string,
  mimeType: string = MIME_TEXT,
  opts?: ContentEnvelopeOptions,
): ReadResourceResult {
  return {
    contents: [
      {
        uri: toResourceUri(uri),
        mimeType,
        text,
        ...(opts?.lastModified ? { annotations: { lastModified: opts.lastModified } } : {}),
        ...(opts ? { _meta: { ...opts.meta } } : {}),
      },
    ],
  };
}

export function blobResource(
  uri: URL | string,
  blobBase64: string,
  mimeType: string,
  opts: ContentEnvelopeOptions,
): ReadResourceResult {
  return {
    contents: [
      {
        uri: toResourceUri(uri),
        mimeType,
        blob: blobBase64,
        ...(opts.lastModified ? { annotations: { lastModified: opts.lastModified } } : {}),
        _meta: { ...opts.meta },
      },
    ],
  };
}
```

- [ ] **Step 2:** `npm run type-check` — fix any errors.

- [ ] **Step 3:** Commit:

```bash
git add src/resources/metadata.ts
git commit -m "feat(resources): add metadata + content envelope helpers"
```

#### TASK-302: `discover.ts` — assistant://\* registrations

| Field      | Value                                                                                                                                                 |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-301, TASK-102                                                                                                                                    |
| Files      | Create: [src/resources/discover.ts](src/resources/discover.ts), [`__tests__/resources/discover.test.ts`](__tests__/resources/discover.test.ts)        |
| Outcome    | `registerDiscoverResources(server, deps)` registers all five `assistant://` URIs. Static URIs use ∞-TTL memoization; `discover/context` uses 5 s TTL. |

- [ ] **Step 1:** Create the failing test [`__tests__/resources/discover.test.ts`](__tests__/resources/discover.test.ts) (asserting all five URIs in `resources/list`, JSON+Markdown content shapes, `_meta.cached === true` on second read of catalog within TTL):

```ts
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerDiscoverResources } from '../../src/resources/discover.js';

test('discover: registers all five assistant:// URIs', async () => {
  const server = new McpServer(
    { name: 't', version: '0.0.0' },
    { capabilities: { resources: {} } },
  );
  registerDiscoverResources(server);
  const list = await server.server.handleListResources({});
  const uris = list.resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, [
    'assistant://discover/catalog',
    'assistant://discover/context',
    'assistant://discover/workflows',
    'assistant://instructions',
    'assistant://profiles',
  ]);
});

test('discover: catalog second read serves from cache (_meta.cached=true)', async () => {
  // ... read once, then read again, parse _meta from first contents entry, assert cached
});
```

- [ ] **Step 2:** Run the test; confirm it fails.

- [ ] **Step 3:** Create [src/resources/discover.ts](src/resources/discover.ts):

Implementation outline (port `readDiscoverCatalogResource`, `readDiscoverWorkflowsResource`, `readDiscoverContextResource`, `readGeminiProfilesResource`, plus a new `readInstructionsResource`):

```ts
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';

import { ResourceMemo } from '../lib/resource-memo.js';
// or wherever SERVER_INSTRUCTIONS lives
import { COMBO_MATRIX, PROFILES, TOOL_PROFILE_NAMES } from '../lib/tool-profiles.js';

import {
  listDiscoveryEntries,
  listWorkflowEntries,
  renderDiscoveryCatalogMarkdown,
  renderWorkflowCatalogMarkdown,
} from '../catalog.js';
import { SERVER_INSTRUCTIONS } from '../server-instructions.js';
import {
  buildMeta,
  byteSize,
  dualContentResource,
  jsonResource,
  textResource,
} from './metadata.js';
import {
  ASSISTANT_DISCOVER_CATALOG_URI,
  ASSISTANT_DISCOVER_CONTEXT_URI,
  ASSISTANT_DISCOVER_WORKFLOWS_URI,
  ASSISTANT_INSTRUCTIONS_URI,
  ASSISTANT_PROFILES_URI,
} from './uris.js';

interface DiscoverDeps {
  rootsFetcher: RootsFetcher;
  sessionStore: SessionStore;
  workspaceCacheManager: WorkspaceCacheManagerImpl;
}

export function registerDiscoverResources(server: McpServer, deps?: DiscoverDeps): void {
  const memo = new ResourceMemo<string, ReadResourceResult>();
  const INF = Number.POSITIVE_INFINITY;
  const CONTEXT_TTL_MS = 5_000;

  // --- catalog (∞ TTL) ---
  server.registerResource(
    'assistant-discover-catalog',
    ASSISTANT_DISCOVER_CATALOG_URI,
    {
      title: 'Discovery Catalog',
      description: 'Machine-readable catalog of public tools, prompts, and resources.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.6 },
    },
    async (uri): Promise<ReadResourceResult> =>
      memo.get(ASSISTANT_DISCOVER_CATALOG_URI, INF, () => {
        const entries = listDiscoveryEntries();
        const md = renderDiscoveryCatalogMarkdown(entries);
        return dualContentResource(uri, entries, md, {
          meta: buildMeta({
            source: 'static',
            cached: false,
            size: byteSize(JSON.stringify(entries)),
          }),
        });
      }),
  );

  // ... workflows (∞), profiles (∞), instructions (∞), discover/context (5s + dep injection)
}
```

(The full `discover.ts` is similar in spirit to the current monolithic implementation; reuse the existing render functions.)

- [ ] **Step 4:** Run discover tests; confirm pass.

- [ ] **Step 5:** Commit:

```bash
git add src/resources/discover.ts __tests__/resources/discover.test.ts
git commit -m "feat(resources): assistant:// registrations with memoization"
```

#### TASK-303: `sessions.ts` and `turns.ts`

| Field      | Value                                                                                                                                                                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-202, TASK-301, TASK-104                                                                                                                                                                                                                                               |
| Files      | Create: [src/resources/sessions.ts](src/resources/sessions.ts), [src/resources/turns.ts](src/resources/turns.ts), [`__tests__/resources/sessions.test.ts`](__tests__/resources/sessions.test.ts), [`__tests__/resources/turns.test.ts`](__tests__/resources/turns.test.ts) |
| Outcome    | Sessions list + detail + transcript + events under new URIs. Turn parts sourced from `getTurnRawParts()`. Turn grounding sourced from `getTurnGrounding()`. **No `getAI()` calls.** Stateless mode skips registration entirely.                                            |

- [ ] **Step 1:** Create the failing tests:

[`__tests__/resources/turns.test.ts`](__tests__/resources/turns.test.ts):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('turn-parts: serves Part[] from in-memory rawParts (no Gemini API call)', async () => {
  // Arrange: server with session store containing a turn with rawParts
  // Mock getAI() to throw if called
  // Act: read gemini://session/<id>/turn/0/parts
  // Assert: result.contents[0].text JSON.parses to Part[] with expected text
});

test('turn-parts: out-of-range turn index returns ResourceNotFound', async () => {
  // ...
});

test('turn-grounding: returns rollup with webSearch when grounding present', async () => {
  // ...
});

test('turn-grounding: returns ResourceNotFound when turn has no grounding metadata', async () => {
  // ...
});
```

[`__tests__/resources/sessions.test.ts`](__tests__/resources/sessions.test.ts) — similar suite for the four session URIs, plus a test that asserts none of the four resources register when `STATELESS=true`.

- [ ] **Step 2:** Run the tests; confirm they fail.

- [ ] **Step 3:** Implement [src/resources/sessions.ts](src/resources/sessions.ts) and [src/resources/turns.ts](src/resources/turns.ts):
  - Port the four session handlers (`session://`, `session://{id}`, `…/transcript`, `…/events`) into `sessions.ts`, swapping URIs to the new scheme via `uris.ts`.
  - Move turn-parts/grounding into `turns.ts` and **delete** the `getAI().interactions.get()` path. New body:

```ts
async (uri, { sessionId, turnIndex }): Promise<ReadResourceResult> => {
  if (!getExposeSessionResources()) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, 'Session resources are disabled');
  }
  const id = requireTemplateParam(sessionId, 'Session ID');
  const idxStr = normalizeTemplateParam(turnIndex);
  if (!idxStr || !/^\d+$/.test(idxStr)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Turn index required');
  }
  const idx = Number.parseInt(idxStr, 10);
  const parts = sessionStore.getTurnRawParts(id, idx);
  if (!parts) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Turn ${String(idx)} not found`);
  }
  const lastModified = new Date(
    sessionStore.getSessionEntry(id)?.lastAccessedAt ?? Date.now(),
  ).toISOString();
  return jsonResource(uri, parts, {
    meta: buildMeta({ source: 'session', cached: false, size: byteSize(JSON.stringify(parts)) }),
    lastModified,
  });
};
```

- Same pattern for grounding, sourcing from `sessionStore.getTurnGrounding(id, idx)`. If `undefined`, throw `ResourceNotFound`.
- At the top of `registerSessionResources(server, sessionStore)` and `registerTurnResources(...)`, **early-return** when `getStatelessTransportFlag() || !getExposeSessionResources()` (except `gemini://sessions` itself, which always registers and returns an empty list when stateless).

- [ ] **Step 4:** Run both test files; confirm they pass.

- [ ] **Step 5:** Commit:

```bash
git add src/resources/sessions.ts src/resources/turns.ts __tests__/resources/sessions.test.ts __tests__/resources/turns.test.ts
git commit -m "feat(resources): gemini://session/* with fixed turn-parts contract + grounding"
```

#### TASK-304: `workspace.ts` — cache + files family

| Field      | Value                                                                                                                                                                                                                                                               |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | TASK-301, TASK-104                                                                                                                                                                                                                                                  |
| Files      | Create: [src/resources/workspace.ts](src/resources/workspace.ts), [`__tests__/resources/workspace.test.ts`](__tests__/resources/workspace.test.ts), Modify: [src/lib/workspace-context.ts](src/lib/workspace-context.ts)                                            |
| Outcome    | Four workspace URIs registered. `…/files/{path}` enforces all six security gates. `WorkspaceCacheManagerImpl` exposes `onChange(cb)`, `scannedFiles` (`Set<string>`), `getFileEntry(path): { mtimeMs, size, score, included }`, and emits change events on rebuild. |

- [ ] **Step 1:** Extend [src/lib/workspace-context.ts](src/lib/workspace-context.ts):
  - Add private `#listeners = new Set<() => void>()`.
  - Add public `onChange(cb): () => void` (returns unsubscribe).
  - Track `#scannedFiles: Map<string, { mtimeMs, size, score, included }>` populated during scan.
  - Add `scannedFiles(): ReadonlyMap<string, FileEntry>` and `getFileEntry(path): FileEntry | undefined`.
  - Fire listeners (queueMicrotask) at the end of every successful rebuild.

- [ ] **Step 2:** Add the failing workspace test [`__tests__/resources/workspace.test.ts`](__tests__/resources/workspace.test.ts):

```ts
test('workspace files: rejects path with ".." segments', async () => {
  // expect ProtocolError ResourceNotFound
});

test('workspace files: rejects path outside allowed roots', async () => {
  /* ... */
});
test('workspace files: rejects path not in scannedFiles allow-list', async () => {
  /* ... */
});
test('workspace files: rejects symlink that escapes allowed roots', async () => {
  /* ... */
});
test('workspace files: returns blob for binary file', async () => {
  /* ... */
});
test('workspace files: rejects file > 1 MiB', async () => {
  /* ... */
});
test('workspace files: returns text content + lastModified for allowed file', async () => {
  /* ... */
});
test('workspace cache contents: returns assembled markdown', async () => {
  /* ... */
});
test('workspace files inventory: returns scored list with totals', async () => {
  /* ... */
});
```

- [ ] **Step 3:** Run tests; confirm fail.

- [ ] **Step 4:** Create [src/resources/workspace.ts](src/resources/workspace.ts) implementing the four URIs:
  - `gemini://workspace/cache` — JSON `{ enabled, cacheName?, fresh, ttl, createdAt?, estimatedTokens }`. `lastModified` from `cacheStatus.createdAt`.
  - `gemini://workspace/cache/contents` — Markdown body from `assembleWorkspaceContext(roots)`, memoized by cache version.
  - `gemini://workspace/files` — JSON `{ files: FileEntry[], totals: { count, includedCount, estimatedTokens } }`.
  - `gemini://workspace/files/{path}` — implements the security pipeline:
    1. `decodeTemplateParam(path)` → `requireTemplateParam`.
    2. `path.normalize()`; reject if contains `..` segments.
    3. `path.isAbsolute()`; check `getAllowedRoots()` containment.
    4. `workspaceCacheManager.scannedFiles()` membership check.
    5. `await fs.realpath()`; re-check root containment (symlink escape).
    6. `await fs.stat()`; reject `> 1_048_576` bytes; return text or blob based on extension/NUL-byte sniff.
    7. Catch all errors → `ProtocolError(ResourceNotFound, 'File not available')`.

- [ ] **Step 5:** Run the workspace tests; confirm they pass.

- [ ] **Step 6:** Commit:

```bash
git add src/resources/workspace.ts src/lib/workspace-context.ts __tests__/resources/workspace.test.ts
git commit -m "feat(resources): gemini://workspace/* family with strict path validation"
```

---

### PHASE-4 — Tool resource_link emission

#### TASK-401: `appendResourceLinks()` helper

| Field      | Value                                                                                                                                                                                        |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-104                                                                                                                                                                                     |
| Files      | Modify: [src/lib/response.ts](src/lib/response.ts), [`__tests__/lib/response.test.ts`](__tests__/lib/response.test.ts)                                                                       |
| Outcome    | New function `appendResourceLinks(result, refs)` mutates `result.content` to append `{ type: 'resource_link', uri, name, description?, mimeType? }` blocks. Tests verify shape and ordering. |

- [ ] **Step 1:** Add failing test:

```ts
test('appendResourceLinks: appends resource_link blocks after existing text', () => {
  const r: CallToolResult = { content: [{ type: 'text', text: 'hello' }] };
  appendResourceLinks(r, [
    { uri: 'gemini://session/abc', name: 'session-abc', description: 'Active session' },
  ]);
  assert.equal(r.content.length, 2);
  assert.equal(r.content[1]?.type, 'resource_link');
  assert.equal(r.content[1]?.uri, 'gemini://session/abc');
});

test('appendResourceLinks: no-op when refs empty', () => {
  const r: CallToolResult = { content: [{ type: 'text', text: 'hi' }] };
  appendResourceLinks(r, []);
  assert.equal(r.content.length, 1);
});
```

- [ ] **Step 2:** Verify test fails.

- [ ] **Step 3:** Implement in [src/lib/response.ts](src/lib/response.ts):

```ts
export interface AppendableLink {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export function appendResourceLinks(result: CallToolResult, refs: readonly AppendableLink[]): void {
  if (refs.length === 0) return;
  for (const r of refs) {
    result.content.push({
      type: 'resource_link',
      uri: r.uri,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    });
  }
}
```

- [ ] **Step 4:** Run response tests:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

- [ ] **Step 5:** Commit:

```bash
git add src/lib/response.ts __tests__/lib/response.test.ts
git commit -m "feat(response): add appendResourceLinks helper"
```

#### TASK-402: Wire `resource_link` blocks into all four tools

| Field      | Value                                                                                                                                                                                                                                         |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-401, TASK-303                                                                                                                                                                                                                            |
| Files      | Modify: [src/tools/chat.ts](src/tools/chat.ts), [src/tools/research.ts](src/tools/research.ts), [src/tools/analyze.ts](src/tools/analyze.ts), [src/tools/review.ts](src/tools/review.ts), and the corresponding `__tests__/tools/*` files     |
| Outcome    | Each tool, on success, appends: `gemini://session/{id}` (when sessionId present), `gemini://session/{id}/turn/{n}/parts`, optionally `…/turn/{n}/grounding` (only when grounding present), `gemini://workspace/cache` (only when cache used). |

- [ ] **Step 1:** In [`__tests__/tools/chat.test.ts`](__tests__/tools/chat.test.ts), add a test:

```ts
test('chat: appends session + turn-parts resource_link blocks', async () => {
  const r = await chatTool.handler({ message: 'hi', sessionId: 's1' }, ctx);
  const links = r.content.filter((c) => c.type === 'resource_link');
  assert.ok(links.find((l) => l.uri === 'gemini://session/s1'));
  assert.ok(links.find((l) => l.uri.match(/^gemini:\/\/session\/s1\/turn\/\d+\/parts$/)));
});

test('chat: appends grounding link only when grounding metadata present', async () => {
  // First call without grounding — no grounding link
  // Second call with mocked grounding metadata — grounding link present
});
```

- [ ] **Step 2:** Run the test; confirm fail.

- [ ] **Step 3:** At the end of each tool's success path, build the link list and call `appendResourceLinks(result, links)`. Pseudocode (chat shown; replicate in research/analyze/review):

```ts
import { appendResourceLinks } from '../lib/response.js';

import {
  sessionResourceUri,
  turnGroundingUri,
  turnPartsUri,
  WORKSPACE_CACHE_URI,
} from '../resources/uris.js';

const links: AppendableLink[] = [];
if (sessionId !== undefined) {
  links.push({
    uri: sessionResourceUri(sessionId),
    name: 'session',
    description: 'Session detail',
  });
  if (turnIndex !== undefined) {
    links.push({
      uri: turnPartsUri(sessionId, turnIndex),
      name: 'turn-parts',
      description: 'Raw model turn parts',
      mimeType: 'application/json',
    });
    if (hasGrounding) {
      links.push({
        uri: turnGroundingUri(sessionId, turnIndex),
        name: 'grounding',
        description: 'Citations and grounding metadata',
        mimeType: 'application/json',
      });
    }
  }
}
if (workspaceCacheUsed) {
  links.push({
    uri: WORKSPACE_CACHE_URI,
    name: 'workspace-cache',
    description: 'Workspace cache status',
  });
}
appendResourceLinks(result, links);
return result;
```

- [ ] **Step 4:** Run all tool tests; confirm pass.

- [ ] **Step 5:** Run `node scripts/tasks.mjs --quick`.

- [ ] **Step 6:** Commit:

```bash
git add src/tools/*.ts __tests__/tools/*.test.ts
git commit -m "feat(tools): emit resource_link blocks for session/turn/grounding/cache"
```

---

### PHASE-5 — Wire-up and capability flip

#### TASK-501: `src/resources.ts` becomes the slim entry

| Field      | Value                                                                                                                                                                            |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-302, TASK-303, TASK-304                                                                                                                                                     |
| Files      | Modify: [src/resources.ts](src/resources.ts)                                                                                                                                     |
| Outcome    | `registerResources(server, deps)` calls each per-area registrar and otherwise contains no implementation. All legacy URI constants and handlers are deleted. File is ≤ 80 lines. |

- [ ] **Step 1:** Replace the entire body of [src/resources.ts](src/resources.ts) with:

```ts
import type { McpServer } from '@modelcontextprotocol/server';

import { buildServerRootsFetcher, type RootsFetcher } from './lib/validation.js';
import type { WorkspaceCacheManagerImpl } from './lib/workspace-context.js';

import { registerDiscoverResources } from './resources/discover.js';
import { registerSessionResources } from './resources/sessions.js';
import { registerTurnResources } from './resources/turns.js';
import { registerWorkspaceResources } from './resources/workspace.js';
import type { SessionStore } from './sessions.js';

export function registerResources(
  server: McpServer,
  sessionStore: SessionStore,
  workspaceCacheManager: WorkspaceCacheManagerImpl,
  rootsFetcher: RootsFetcher = buildServerRootsFetcher(server),
): void {
  registerDiscoverResources(server, { rootsFetcher, sessionStore, workspaceCacheManager });
  registerSessionResources(server, sessionStore);
  registerTurnResources(server, sessionStore);
  registerWorkspaceResources(server, rootsFetcher, workspaceCacheManager);
}
```

- [ ] **Step 2:** Update [`__tests__/resources.test.ts`](__tests__/resources.test.ts):
  - Replace assertions that test legacy URIs (`session://`, `discover://`, `workspace://`, `gemini://profiles`) with the new ones.
  - Add a regression test that legacy URIs are absent from `resources/list`.

- [ ] **Step 3:** Run `npm run knip` — fix any newly-unused exports.

- [ ] **Step 4:** Run `node scripts/tasks.mjs`. Fix any failures.

- [ ] **Step 5:** Commit:

```bash
git add src/resources.ts __tests__/resources.test.ts
git commit -m "refactor(resources): slim entry delegating to per-area modules"
```

#### TASK-502: Server capability + notifier wiring

| Field      | Value                                                                                                                                                                                                                                                                                                                        |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-501, TASK-103                                                                                                                                                                                                                                                                                                           |
| Files      | Modify: [src/server.ts](src/server.ts), [`__tests__/server.test.ts`](__tests__/server.test.ts) (or create if missing)                                                                                                                                                                                                        |
| Outcome    | `capabilities.resources = { listChanged: true, subscribe: true }`. All ad-hoc `sendResourceUpdated` / `sendResourceListChanged` calls replaced with `ResourceNotifier` calls. Notifier subscribes to `SessionStore.subscribe()` and `WorkspaceCacheManager.onChange()`. `ServerInstance.close()` calls `notifier.dispose()`. |

- [ ] **Step 1:** In [`__tests__/server.test.ts`](__tests__/server.test.ts), add (or extend) tests:

```ts
test('server advertises resources.subscribe capability', async () => {
  const { server } = createServerInstance({
    /* deps */
  });
  const init = await server.server.handleInitialize({
    /* ... */
  });
  assert.equal(init.capabilities.resources?.subscribe, true);
  assert.equal(init.capabilities.resources?.listChanged, true);
});

test('subscribing to gemini://session/<id> receives resources/updated on new turn', async () => {
  // ... arrange a fake transport, subscribe, append turn, assert notification
});
```

- [ ] **Step 2:** In [src/server.ts](src/server.ts):
  - Set `resources: { listChanged: true, subscribe: true }`.
  - Construct `const notifier = new ResourceNotifier(server.server)` after server creation.
  - Replace the existing `sessionStore.subscribe(...)` body to call:
    - `notifier.notifyListChanged()` for sessions list mutations
    - `notifier.notifyUpdated(sessionResourceUri(id))` for session detail change
    - `notifier.notifyUpdated(sessionTranscriptUri(id))` and `…events…` (gated by `getExposeSessionResources()`)
    - For `turnPartsAdded`: `notifier.notifyUpdated(turnPartsUri(id, n))` and (if grounding) `notifier.notifyUpdated(turnGroundingUri(id, n))`
  - Subscribe to `workspaceCacheManager.onChange()`:
    - `notifier.notifyUpdated(WORKSPACE_CACHE_URI)`
    - `notifier.notifyUpdated(WORKSPACE_CACHE_CONTENTS_URI)`
    - Compute changed file paths since previous scan; call `notifier.notifyFilesChanged(changedPaths)`
    - If file count or hash changed → `notifier.notifyListChanged()` for `gemini://workspace/files`
  - In `ServerInstance.close()`, call `notifier.dispose()` after `unsubscribeSessionChange()`.
  - Delete the old `sendResourceUpdatedForServer` / `sendResourceChangedForServer` helpers entirely.

- [ ] **Step 3:** Run `node scripts/tasks.mjs`. Fix failures.

- [ ] **Step 4:** Commit:

```bash
git add src/server.ts __tests__/server.test.ts
git commit -m "feat(server): advertise resources.subscribe and route via ResourceNotifier"
```

#### TASK-503: `public-contract.ts` and `catalog.ts` URI updates

| Field      | Value                                                                                                                                                                 |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-502                                                                                                                                                              |
| Files      | Modify: [src/public-contract.ts](src/public-contract.ts), [src/catalog.ts](src/catalog.ts), [`__tests__/catalog.test.ts`](__tests__/catalog.test.ts)                  |
| Outcome    | `RESOURCE_ENTRIES` in `public-contract.ts` lists exactly the new 11 URIs (5 assistant + 6 gemini). `catalog.ts` markdown render reflects them. Catalog tests updated. |

- [ ] **Step 1:** Update `RESOURCE_ENTRIES` in [src/public-contract.ts](src/public-contract.ts) — replace each entry's `uri` and refresh descriptions to match the new contract.

- [ ] **Step 2:** Run [`__tests__/catalog.test.ts`](__tests__/catalog.test.ts); update fixtures.

- [ ] **Step 3:** Run `node scripts/tasks.mjs`.

- [ ] **Step 4:** Commit:

```bash
git add src/public-contract.ts src/catalog.ts __tests__/catalog.test.ts
git commit -m "refactor(contract): align RESOURCE_ENTRIES with new URI scheme"
```

---

### PHASE-6 — Cleanup, docs, version bump

#### TASK-601: Regenerate `.github/resources.md`

| Field      | Value                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------- |
| Depends on | TASK-503                                                                                                  |
| Files      | Modify: [.github/resources.md](.github/resources.md)                                                      |
| Outcome    | The reference doc shows actual `resources/list` and `resources/templates/list` JSON for the new contract. |

- [ ] **Step 1:** Run the inspector and capture both responses:

```bash
npm run inspector
# inside inspector REPL: list resources, list resource templates; copy both JSON payloads
```

- [ ] **Step 2:** Replace the entire body of [.github/resources.md](.github/resources.md) with the captured JSON, preserving the existing two-section heading style (`## resources/list`, `## resources/templates/list`).

- [ ] **Step 3:** Commit:

```bash
git add .github/resources.md
git commit -m "docs: regenerate resources.md for new URI contract"
```

#### TASK-602: Version bump and final verification

| Field      | Value                                                                                                                                                                           |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | TASK-601                                                                                                                                                                        |
| Files      | Modify: [package.json](package.json)                                                                                                                                            |
| Outcome    | MAJOR version bumped (e.g., `1.x.y` → `2.0.0`). `node scripts/tasks.mjs` (full suite, no `--quick`) passes end-to-end. `npm run inspector` smoke tests succeed for all 11 URIs. |

- [ ] **Step 1:** Edit [package.json](package.json) — bump `version` MAJOR. (Confirm current value first; this plan does not assume a specific number.)

- [ ] **Step 2:** Run the **full** task suite:

```bash
node scripts/tasks.mjs
```

Expected: format clean, lint clean, type-check clean, knip clean, all tests pass, build succeeds.

- [ ] **Step 3:** Smoke-test through the inspector — for each of the 11 URIs, issue `resources/read` and confirm the response matches expectations.

- [ ] **Step 4:** Commit:

```bash
git add package.json
git commit -m "chore: bump MAJOR version for resources redesign"
```

---

## 5. Self-Review

**Spec coverage.** Every numbered section of the design spec has at least one task:

| Spec section                            | Tasks                                                |
| :-------------------------------------- | :--------------------------------------------------- |
| Section 1 — URI Map                     | TASK-104, TASK-302, TASK-303, TASK-304, TASK-503     |
| Section 2.1 — Standard MCP metadata     | TASK-301 (buildMeta + lastModified)                  |
| Section 2.2 — Content shapes            | TASK-301, TASK-302, TASK-303, TASK-304               |
| Section 2.3 — `_meta` schema            | TASK-101 (schema), TASK-301 (helper)                 |
| Section 2.4 — Lazy-link contract        | TASK-401, TASK-402                                   |
| Section 2.5 — Fixed turn-parts contract | TASK-202, TASK-303 (turns.ts)                        |
| Section 2.6 — Grounding rollup          | TASK-101, TASK-201, TASK-202, TASK-303               |
| Section 2.7 — Workspace files contract  | TASK-304                                             |
| Section 3.1 — Capability declaration    | TASK-502                                             |
| Section 3.2 — Tiered notifier           | TASK-103                                             |
| Section 3.3 — Trigger wiring            | TASK-502                                             |
| Section 3.4 — Stateless-mode handling   | TASK-303 (early-return), TASK-502                    |
| Section 3.5/3.6 — Subscriptions/perf    | TASK-103 (storm-cap)                                 |
| Section 4.1/4.2 — ResourceMemo + TTLs   | TASK-102, TASK-302, TASK-304                         |
| Section 4.3 — Eliminated redundant work | TASK-302, TASK-304 (memoization)                     |
| Section 4.4 — Path validation           | TASK-304                                             |
| Section 4.5 — Turn-parts security       | TASK-303 (turns.ts handlers)                         |
| Section 4.6 — Concurrency               | TASK-102 (single-flight), TASK-304 (microtask queue) |
| Section 4.7 — Token & size accounting   | TASK-301 (buildMeta), TASK-304 (totals)              |
| Section 5 — Implementation map + tests  | All tasks                                            |

**Placeholder scan.** No `TBD`, `TODO`, "implement later", or vague "appropriate error handling". Each task contains either complete code or a precise list of changes with named symbols.

**Type consistency.** Verified across tasks:

- `ResourceLinkRef` (in `resource-meta.ts`) vs `AppendableLink` (in `response.ts`) — distinct on purpose: the first is a server-internal `_meta` hint, the second is the input shape for `appendResourceLinks`. Both are exported from their own modules.
- `getTurnRawParts(id, n): Part[] | undefined` and `getTurnGrounding(id, n): GroundingRollup | undefined` are referenced in TASK-202 (definitions) and TASK-303 (use sites) with matching signatures.
- `WorkspaceCacheManagerImpl.scannedFiles()` returns a `ReadonlyMap<string, FileEntry>` in TASK-304; the workspace handler uses `.has(path)` for membership.
- `fileResourceUri(path)` is defined in TASK-104 and consumed by TASK-103 (`notifyFilesChanged`); the test in TASK-103 asserts the exact URI form, matching the builder.

**Open follow-ups.** Out-of-scope from spec (not in this plan): `EmbeddedResource` content blocks; cross-session deduplicated grounding library; arbitrary FS browser; tool/prompt contract changes.

---

## 6. Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-01-resources-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
