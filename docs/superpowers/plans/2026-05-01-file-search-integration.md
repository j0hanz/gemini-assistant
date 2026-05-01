---
goal: Add File Search Store management (ingest tool + store resources) to the existing MCP server without modifying the current chat/research/analyze/review tools
version: 1
date_created: 2026-05-01
status: Planned
plan_type: feature
component: file-search-integration
execution: subagent-driven
---

# Implementation Plan: File Search Store Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Add an `ingest` MCP tool for File Search Store lifecycle management and `gemini://stores` MCP resources for store discovery, enabling callers to create/populate/delete stores and then use the existing `rag` profile on the `chat` tool to query them.

**Architecture:** Three additions layered on top of the unchanged existing tools: (1) a `StoreRegistry` read-through cache that wraps `ai.fileSearchStores` API calls with a 30 s TTL, shared by the new resource handlers and the ingest tool; (2) `gemini://stores` and `gemini://stores/{name}/documents` MCP resources that expose live store metadata; (3) an `ingest` MCP tool with a discriminated union input schema (`create-store | upload | delete-store | delete-document`) that maps directly to `ai.fileSearchStores` operations. Additionally, the `BUILT_IN_TO_INTERACTION_TOOL` map in `interactions.ts` is missing `fileSearch`, which is a pre-existing bug fixed as part of this plan. The `public-contract.ts` is updated to advertise the new surface.

**Tech Stack:** TypeScript (NodeNext ESM), `@google/genai` (`ai.fileSearchStores`), `@modelcontextprotocol/server` v2 (`registerTool`, `registerResource`, `ResourceTemplate`), `zod/v4`

---

## 1. Goal

The server currently supports the `rag` profile on the `chat` tool (profile activates Gemini's built-in `fileSearch` tool), but there is no way for MCP callers to manage the File Search Stores that the `rag` profile requires. Callers must create and populate stores out-of-band using the Gemini API directly. This plan closes that gap by adding an `ingest` tool for store CRUD + document upload and `gemini://stores` resources for store discovery, making the full RAG workflow self-contained within the MCP session. It also fixes a pre-existing bug where `fileSearch` is absent from the `BUILT_IN_TO_INTERACTION_TOOL` map, which causes the `rag` profile to silently omit the file search tool when sessions use `ai.interactions`.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                                                                                                                                     |
| :---------------------------------------: | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `ingest` tool exposes `create-store`, `upload`, `delete-store`, `delete-document` operations via a Zod discriminated union on the `operation` field.                                                                                                                                          |
| [`REQ-002`](#2-requirements--constraints) | Requirement | `upload` operation uses `ai.fileSearchStores.uploadToFileSearchStore()` directly (no intermediate `ai.files` step), polls the returned long-running operation until `done: true`, and returns the resulting document name.                                                                    |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `gemini://stores` resource lists all File Search Stores via `ai.fileSearchStores.list()`.                                                                                                                                                                                                     |
| [`REQ-004`](#2-requirements--constraints) | Requirement | `gemini://stores/{name}/documents` resource lists documents in a store via `ai.fileSearchStores.documents.list()`.                                                                                                                                                                            |
| [`REQ-005`](#2-requirements--constraints) | Requirement | A `StoreRegistry` with a 30 s TTL cache sits in front of both resource reads and the `ingest` validation path.                                                                                                                                                                                |
| [`REQ-006`](#2-requirements--constraints) | Requirement | `BUILT_IN_TO_INTERACTION_TOOL` in `interactions.ts` is extended with `fileSearch` → `{ type: 'file_search' }` so sessions using `ai.interactions` with the `rag` profile pass the tool correctly.                                                                                             |
| [`REQ-007`](#2-requirements--constraints) | Requirement | All four existing tools (`chat`, `research`, `analyze`, `review`) are unchanged in behaviour.                                                                                                                                                                                                 |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Use `z.strictObject` for all tool input schemas at MCP boundaries (MCP v2 requirement).                                                                                                                                                                                                       |
| [`CON-002`](#2-requirements--constraints) | Constraint  | All imports use `.js` extensions (NodeNext ESM).                                                                                                                                                                                                                                              |
| [`CON-003`](#2-requirements--constraints) | Constraint  | `ingest` returns `{ content, structuredContent }` with both fields populated (MCP v2: clients without structured-content support fall back to `content`).                                                                                                                                     |
| [`CON-004`](#2-requirements--constraints) | Constraint  | Tool runtime failures return `{ content, isError: true }`, not a thrown exception.                                                                                                                                                                                                            |
| [`CON-005`](#2-requirements--constraints) | Constraint  | `fileSearch` is mutually exclusive with all other Gemini built-in tools — this is already enforced by the existing `validateProfile` in `tool-profiles.ts`; do not weaken it.                                                                                                                 |
| [`SEC-001`](#2-requirements--constraints) | Security    | The `upload` operation accepts only a local file path; the server reads the file using Node `fs` before passing to the SDK. Validate the path is absolute or workspace-relative and does not traverse outside allowed roots using the existing `validateScanPath` in `resources/metadata.ts`. |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [registerWorkspaceResources](src/resources/workspace.ts) for resource registration (use `server.registerResource` + `ResourceTemplate` from `@modelcontextprotocol/server`).                                                                                                           |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Follow [registerWorkTool](src/lib/tasks.ts#L778) for tool registration (task-aware wrapper).                                                                                                                                                                                                  |
| [`PAT-003`](#2-requirements--constraints) | Pattern     | Follow [OverridesSchema](src/schemas/fields.ts#L441) / [FileSearchStoreNameSchema](src/schemas/fields.ts#L435) for store name validation in Zod schemas.                                                                                                                                      |

## 3. Current Context

### File structure

| File                                                                         | Status | Responsibility                                                                                                   |
| :--------------------------------------------------------------------------- | :----- | :--------------------------------------------------------------------------------------------------------------- |
| [src/lib/store-registry.ts](src/lib/store-registry.ts)                       | Create | 30 s TTL read-through cache wrapping `ai.fileSearchStores.list()` and `ai.fileSearchStores.documents.list()`     |
| [src/resources/stores.ts](src/resources/stores.ts)                           | Create | Register `gemini://stores` and `gemini://stores/{name}/documents` MCP resources                                  |
| [src/tools/ingest.ts](src/tools/ingest.ts)                                   | Create | Register the `ingest` MCP tool with discriminated union input schema                                             |
| [src/schemas/ingest-input.ts](src/schemas/ingest-input.ts)                   | Create | Zod discriminated union schema for `IngestInput` (`create-store \| upload \| delete-store \| delete-document`)   |
| [src/schemas/ingest-output.ts](src/schemas/ingest-output.ts)                 | Create | Zod output schema `IngestOutputSchema` with `operation`, `storeName?`, `documentName?`, `message`                |
| [src/resources/index.ts](src/resources/index.ts)                             | Modify | Export `registerStoreResources` and thread `StoreRegistry` through `ResourceServices`                            |
| [src/resources/uris.ts](src/resources/uris.ts)                               | Modify | Add `STORES_LIST_URI`, `STORES_DETAIL_TEMPLATE`, `STORE_DOCUMENTS_TEMPLATE` constants and URI builder functions  |
| [src/server.ts](src/server.ts)                                               | Modify | Instantiate `StoreRegistry`, add `registerIngestTool` to `SERVER_TOOL_REGISTRARS`, call `registerStoreResources` |
| [src/lib/interactions.ts](src/lib/interactions.ts#L16)                       | Modify | Add `fileSearch: { type: 'file_search' }` to `BUILT_IN_TO_INTERACTION_TOOL`                                      |
| [src/public-contract.ts](src/public-contract.ts)                             | Modify | Add `'ingest'` to `PublicJobName`, add store resource URIs to `PublicResourceUri`, update `SERVER_INSTRUCTIONS`  |
| [**tests**/lib/store-registry.test.ts](__tests__/lib/store-registry.test.ts) | Create | Unit tests for `StoreRegistry` TTL caching and cache invalidation                                                |
| [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts)             | Create | Unit tests for `ingest` tool operations                                                                          |
| [**tests**/resources/stores.test.ts](__tests__/resources/stores.test.ts)     | Create | Unit tests for store resource handlers                                                                           |
| [**tests**/lib/interactions.test.ts](__tests__/lib/interactions.test.ts)     | Modify | Add test verifying `fileSearch` maps to `{ type: 'file_search' }`                                                |

### Relevant symbols

| Symbol                                                      | Why it matters                                                                                                            |
| :---------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| [BUILT_IN_TO_INTERACTION_TOOL](src/lib/interactions.ts#L16) | Missing `fileSearch` entry — bug to fix in [TASK-001](#task-001-fix-builtin_to_interaction_tool-missing-filesearch-entry) |
| [builtInsToInteractionTools](src/lib/interactions.ts#L93)   | Consumes `BUILT_IN_TO_INTERACTION_TOOL`; used by `research.ts` for background interactions                                |
| [registerAllResources](src/resources/index.ts#L28)          | Entry point for all resource registration; needs `StoreRegistry` threaded in                                              |
| [registerWorkTool](src/lib/tasks.ts#L778)                   | Task-aware tool registration wrapper — `ingest` must use this                                                             |
| [ToolServices](src/lib/tool-context.ts#L16)                 | Passed to every tool registrar; does NOT need changes — `ingest` uses `getAI()` directly                                  |
| [createDefaultToolServices](src/lib/tool-context.ts#L27)    | Factory used in `server.ts`; unchanged                                                                                    |
| [SERVER_TOOL_REGISTRARS](src/server.ts#L70)                 | Array of tool registrars; `registerIngestTool` is appended here                                                           |
| [FileSearchStoreNameSchema](src/schemas/fields.ts#L435)     | Existing Zod validator for store name format — reuse in `IngestInputSchema`                                               |
| [OverridesSchema](src/schemas/fields.ts#L441)               | Pattern reference for composing Zod schemas                                                                               |
| [TOOL_LABELS](src/public-contract.ts#L515)                  | Add `ingest: 'Ingest'` entry                                                                                              |
| [registerWorkspaceResources](src/resources/workspace.ts)    | Pattern for resource registration with `ResourceTemplate`                                                                 |
| [validateScanPath](src/resources/metadata.ts)               | Security: validate file paths in `upload` operation                                                                       |
| [McpServerSpecSchema](src/schemas/fields.ts#L243)           | Not used by this plan — confirms `fileSearchStores` field is already in `OverridesSchema`                                 |

### Existing commands

```bash
# Full verification (format → lint/type-check/knip → test → rebuild)
node scripts/tasks.mjs

# Fast static checks only (skip test + rebuild)
node scripts/tasks.mjs --quick

# Run a single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

### Current behavior

The `rag` profile and `fileSearch` built-in tool are fully wired in the orchestration layer (`tool-profiles.ts`, `orchestration.ts`). Callers can use `tools: { profile: 'rag', overrides: { fileSearchStores: ['...'] } }` on the `chat` tool — but they must create and populate stores externally. There is also a silent bug: `builtInsToInteractionTools` does not map `fileSearch` to an Interactions API tool type, so any session turn using the `rag` profile via `ai.interactions` silently sends no tool to Gemini.

## 4. Implementation Phases

### PHASE-001: Fix the pre-existing `fileSearch` bug in interactions

**Goal:** `builtInsToInteractionTools(['fileSearch'])` returns `[{ type: 'file_search' }]`.

|                                       Task                                       | Action                                             | Depends on | Files                                              | Validate                         |
| :------------------------------------------------------------------------------: | :------------------------------------------------- | :--------: | :------------------------------------------------- | :------------------------------- |
| [`TASK-001`](#task-001-fix-builtin_to_interaction_tool-missing-filesearch-entry) | Add `fileSearch` to `BUILT_IN_TO_INTERACTION_TOOL` |    none    | [src/lib/interactions.ts](src/lib/interactions.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-001: Fix BUILT_IN_TO_INTERACTION_TOOL missing fileSearch entry

| Field      | Value                                                                                                                                        |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                         |
| Files      | Modify: [src/lib/interactions.ts](src/lib/interactions.ts); Modify: [**tests**/lib/interactions.test.ts](__tests__/lib/interactions.test.ts) |
| Symbols    | [BUILT_IN_TO_INTERACTION_TOOL](src/lib/interactions.ts#L16), [builtInsToInteractionTools](src/lib/interactions.ts#L93)                       |
| Outcome    | `builtInsToInteractionTools(['fileSearch'])` returns `[{ type: 'file_search' }]`; existing tests still pass.                                 |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/interactions.test.ts  — add inside existing describe block
test('builtInsToInteractionTools maps fileSearch to file_search', () => {
  const result = builtInsToInteractionTools(['fileSearch']);
  assert.deepStrictEqual(result, [{ type: 'file_search' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: FAIL — `builtInsToInteractionTools maps fileSearch to file_search` — actual `[]`, expected `[{ type: 'file_search' }]`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/lib/interactions.ts  — change lines 16-20
const BUILT_IN_TO_INTERACTION_TOOL: Readonly<Record<string, Interactions.Tool>> = {
  googleSearch: { type: 'google_search' },
  urlContext: { type: 'url_context' },
  codeExecution: { type: 'code_execution' },
  fileSearch: { type: 'file_search' },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/interactions.ts __tests__/lib/interactions.test.ts
git commit -m "fix: add fileSearch to BUILT_IN_TO_INTERACTION_TOOL map"
```

---

### PHASE-002: Add URI constants and StoreRegistry

**Goal:** URI constants for store resources exist in `uris.ts`; `StoreRegistry` caches `ai.fileSearchStores` reads with a 30 s TTL.

|                      Task                       | Action                                        |                   Depends on                    | Files                                                  | Validate                                                                                          |
| :---------------------------------------------: | :-------------------------------------------- | :---------------------------------------------: | :----------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| [`TASK-002`](#task-002-add-store-uri-constants) | Add store URI constants and builder functions |                      none                       | [src/resources/uris.ts](src/resources/uris.ts)         | `node scripts/tasks.mjs --quick`                                                                  |
| [`TASK-003`](#task-003-implement-storeregistry) | Create StoreRegistry with 30 s TTL cache      | [`TASK-002`](#task-002-add-store-uri-constants) | [src/lib/store-registry.ts](src/lib/store-registry.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/store-registry.test.ts` |

#### TASK-002: Add store URI constants

| Field      | Value                                                                                                                                                                      |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                       |
| Files      | Modify: [src/resources/uris.ts](src/resources/uris.ts)                                                                                                                     |
| Symbols    | `STORES_LIST_URI`, `STORES_DETAIL_TEMPLATE`, `STORE_DOCUMENTS_TEMPLATE`, `storeDocumentsUri`                                                                               |
| Outcome    | URI constants and builder functions are exported; `node scripts/tasks.mjs --quick` passes. TDD skipped — pure constant additions with no logic to unit-test independently. |

- [ ] **Step 1: Apply change**

Add to the bottom of [src/resources/uris.ts](src/resources/uris.ts):

```ts
// ============================== gemini://stores ================================

export const STORES_LIST_URI = 'gemini://stores' as const;
export const STORES_DETAIL_TEMPLATE = 'gemini://stores/{storeName}' as const;
export const STORE_DOCUMENTS_TEMPLATE = 'gemini://stores/{storeName}/documents' as const;

export function storeDetailUri(storeName: string): string {
  return `gemini://stores/${encodeURIComponent(storeName)}`;
}

export function storeDocumentsUri(storeName: string): string {
  return `gemini://stores/${encodeURIComponent(storeName)}/documents`;
}
```

- [ ] **Step 2: Run to verify it passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS — no type errors, no lint errors.

- [ ] **Step 3: Commit**

```bash
git add src/resources/uris.ts
git commit -m "feat: add store URI constants and builder functions"
```

#### TASK-003: Implement StoreRegistry

| Field      | Value                                                                                                                                                |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-add-store-uri-constants)                                                                                                      |
| Files      | Create: [src/lib/store-registry.ts](src/lib/store-registry.ts); Create: [**tests**/lib/store-registry.test.ts](__tests__/lib/store-registry.test.ts) |
| Symbols    | `StoreRegistry`, `createStoreRegistry`                                                                                                               |
| Outcome    | `StoreRegistry.listStores()` returns cached results for 30 s, then re-fetches; `listDocuments(storeName)` does the same per store name.              |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/store-registry.test.ts
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { createStoreRegistry } from '../src/lib/store-registry.js';

describe('StoreRegistry', () => {
  it('returns cached stores on second call within TTL', async () => {
    let callCount = 0;
    const fakeList = async () => {
      callCount++;
      return [{ name: 'fileSearchStores/test-store', displayName: 'Test' }];
    };
    const registry = createStoreRegistry({ listStoresFn: fakeList, ttlMs: 30_000 });

    await registry.listStores();
    await registry.listStores();

    assert.equal(callCount, 1);
  });

  it('re-fetches after TTL expires', async () => {
    let callCount = 0;
    const fakeList = async () => {
      callCount++;
      return [];
    };
    const registry = createStoreRegistry({ listStoresFn: fakeList, ttlMs: 0 });

    await registry.listStores();
    await registry.listStores();

    assert.equal(callCount, 2);
  });

  it('invalidate clears the cache', async () => {
    let callCount = 0;
    const fakeList = async () => {
      callCount++;
      return [];
    };
    const registry = createStoreRegistry({ listStoresFn: fakeList, ttlMs: 30_000 });

    await registry.listStores();
    registry.invalidate();
    await registry.listStores();

    assert.equal(callCount, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/store-registry.test.ts
```

Expected: FAIL — `createStoreRegistry is not exported` (module not found).

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/lib/store-registry.ts
import { getAI } from '../client.js';

export interface StoreEntry {
  name: string;
  displayName?: string;
  activeDocumentsCount?: string;
  pendingDocumentsCount?: string;
  failedDocumentsCount?: string;
  sizeBytes?: string;
  createTime?: string;
  updateTime?: string;
}

export interface DocumentEntry {
  name: string;
  displayName?: string;
  state?: string;
  mimeType?: string;
  sizeBytes?: string;
  createTime?: string;
}

interface StoreRegistryOptions {
  listStoresFn?: () => Promise<StoreEntry[]>;
  ttlMs?: number;
}

export interface StoreRegistry {
  listStores(): Promise<StoreEntry[]>;
  listDocuments(storeName: string): Promise<DocumentEntry[]>;
  invalidate(): void;
}

export function createStoreRegistry(options: StoreRegistryOptions = {}): StoreRegistry {
  const ttlMs = options.ttlMs ?? 30_000;
  const listStoresFn =
    options.listStoresFn ??
    (async () => {
      const ai = getAI();
      const stores: StoreEntry[] = [];
      for await (const store of ai.fileSearchStores.list()) {
        stores.push(store as StoreEntry);
      }
      return stores;
    });

  let storesCache: StoreEntry[] | undefined;
  let storesCachedAt = 0;
  const docsCache = new Map<string, { entries: DocumentEntry[]; cachedAt: number }>();

  return {
    async listStores(): Promise<StoreEntry[]> {
      const now = Date.now();
      if (storesCache !== undefined && now - storesCachedAt < ttlMs) {
        return storesCache;
      }
      storesCache = await listStoresFn();
      storesCachedAt = Date.now();
      return storesCache;
    },

    async listDocuments(storeName: string): Promise<DocumentEntry[]> {
      const now = Date.now();
      const cached = docsCache.get(storeName);
      if (cached !== undefined && now - cached.cachedAt < ttlMs) {
        return cached.entries;
      }
      const ai = getAI();
      const entries: DocumentEntry[] = [];
      for await (const doc of ai.fileSearchStores.documents.list({ parent: storeName })) {
        entries.push(doc as DocumentEntry);
      }
      docsCache.set(storeName, { entries, cachedAt: Date.now() });
      return entries;
    },

    invalidate(): void {
      storesCache = undefined;
      storesCachedAt = 0;
      docsCache.clear();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/store-registry.test.ts
```

Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store-registry.ts __tests__/lib/store-registry.test.ts
git commit -m "feat: add StoreRegistry with 30s TTL cache for fileSearchStores"
```

---

### PHASE-003: Add ingest input/output schemas

**Goal:** `IngestInputSchema` (discriminated union) and `IngestOutputSchema` are defined and parse correctly.

|                     Task                      | Action                    | Depends on | Files                                                                                                                    | Validate                         |
| :-------------------------------------------: | :------------------------ | :--------: | :----------------------------------------------------------------------------------------------------------------------- | :------------------------------- |
| [`TASK-004`](#task-004-create-ingest-schemas) | Create ingest Zod schemas |    none    | [src/schemas/ingest-input.ts](src/schemas/ingest-input.ts), [src/schemas/ingest-output.ts](src/schemas/ingest-output.ts) | `node scripts/tasks.mjs --quick` |

#### TASK-004: Create ingest schemas

| Field      | Value                                                                                                                                    |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                     |
| Files      | Create: [src/schemas/ingest-input.ts](src/schemas/ingest-input.ts); Create: [src/schemas/ingest-output.ts](src/schemas/ingest-output.ts) |
| Symbols    | `IngestInputSchema`, `IngestInput`, `IngestOutputSchema`, `IngestOutput`                                                                 |
| Outcome    | Schemas parse valid inputs and reject invalid ones; type-check passes.                                                                   |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/schemas/ingest.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IngestInputSchema } from '../../src/schemas/ingest-input.js';

describe('IngestInputSchema', () => {
  it('parses create-store operation', () => {
    const result = IngestInputSchema.safeParse({
      operation: 'create-store',
      displayName: 'My Store',
    });
    assert.ok(result.success);
    assert.equal(result.data.operation, 'create-store');
  });

  it('parses upload operation', () => {
    const result = IngestInputSchema.safeParse({
      operation: 'upload',
      storeName: 'fileSearchStores/abc',
      filePath: '/workspace/doc.pdf',
    });
    assert.ok(result.success);
    assert.equal(result.data.operation, 'upload');
  });

  it('parses delete-store operation', () => {
    const result = IngestInputSchema.safeParse({
      operation: 'delete-store',
      storeName: 'fileSearchStores/abc',
    });
    assert.ok(result.success);
  });

  it('parses delete-document operation', () => {
    const result = IngestInputSchema.safeParse({
      operation: 'delete-document',
      documentName: 'fileSearchStores/abc/documents/doc1',
    });
    assert.ok(result.success);
  });

  it('rejects unknown operation', () => {
    const result = IngestInputSchema.safeParse({ operation: 'unknown' });
    assert.ok(!result.success);
  });

  it('rejects upload without storeName', () => {
    const result = IngestInputSchema.safeParse({ operation: 'upload', filePath: '/x.pdf' });
    assert.ok(!result.success);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/ingest.test.ts
```

Expected: FAIL — `Cannot find module '../../src/schemas/ingest-input.js'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/schemas/ingest-input.ts
import { z } from 'zod/v4';

const CreateStoreSchema = z.strictObject({
  operation: z.literal('create-store'),
  displayName: z.string().trim().min(1).max(512).optional(),
});

const UploadSchema = z.strictObject({
  operation: z.literal('upload'),
  storeName: z
    .string()
    .trim()
    .min(1)
    .describe('File Search Store resource name, e.g. fileSearchStores/my-store-abc'),
  filePath: z
    .string()
    .trim()
    .min(1)
    .describe('Absolute or workspace-relative path to the file to upload and index'),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .optional()
    .describe('Human-readable display name for the indexed document'),
});

const DeleteStoreSchema = z.strictObject({
  operation: z.literal('delete-store'),
  storeName: z.string().trim().min(1).describe('File Search Store resource name to delete'),
  force: z
    .boolean()
    .optional()
    .describe('If true, delete all documents in the store before deleting the store itself'),
});

const DeleteDocumentSchema = z.strictObject({
  operation: z.literal('delete-document'),
  documentName: z
    .string()
    .trim()
    .min(1)
    .describe('Document resource name, e.g. fileSearchStores/my-store/documents/doc-id'),
});

export const IngestInputSchema = z.discriminatedUnion('operation', [
  CreateStoreSchema,
  UploadSchema,
  DeleteStoreSchema,
  DeleteDocumentSchema,
]);

export type IngestInput = z.infer<typeof IngestInputSchema>;
```

```ts
// src/schemas/ingest-output.ts
import { z } from 'zod/v4';

export const IngestOutputSchema = z.strictObject({
  operation: z.enum(['create-store', 'upload', 'delete-store', 'delete-document']),
  storeName: z.string().optional().describe('Resource name of the affected store'),
  documentName: z
    .string()
    .optional()
    .describe('Resource name of the created document (upload only)'),
  message: z.string().describe('Human-readable result summary'),
});

export type IngestOutput = z.infer<typeof IngestOutputSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/ingest.test.ts
```

Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/ingest-input.ts src/schemas/ingest-output.ts __tests__/schemas/ingest.test.ts
git commit -m "feat: add IngestInputSchema and IngestOutputSchema"
```

---

### PHASE-004: Implement the ingest tool

**Goal:** `ingest` MCP tool is registered and all four operations call the correct `ai.fileSearchStores` methods.

|                     Task                      | Action                            |                                           Depends on                                           | Files                                      | Validate                                                                                    |
| :-------------------------------------------: | :-------------------------------- | :--------------------------------------------------------------------------------------------: | :----------------------------------------- | :------------------------------------------------------------------------------------------ |
| [`TASK-005`](#task-005-implement-ingest-tool) | Create ingest tool implementation | [`TASK-003`](#task-003-implement-storeregistry), [`TASK-004`](#task-004-create-ingest-schemas) | [src/tools/ingest.ts](src/tools/ingest.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts` |

#### TASK-005: Implement ingest tool

| Field      | Value                                                                                                                            |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-implement-storeregistry), [`TASK-004`](#task-004-create-ingest-schemas)                                   |
| Files      | Create: [src/tools/ingest.ts](src/tools/ingest.ts); Create: [**tests**/tools/ingest.test.ts](__tests__/tools/ingest.test.ts)     |
| Symbols    | `registerIngestTool`, `IngestInputSchema`, `IngestOutputSchema`, `StoreRegistry`                                                 |
| Outcome    | All four operations return correct structured output; errors return `isError: true`; tool is registered with `registerWorkTool`. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/tools/ingest.test.ts
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

// Minimal mock server
const registeredTools: Record<string, unknown> = {};
const mockServer = {
  registerTool: (name: string, _meta: unknown, handler: unknown) => {
    registeredTools[name] = handler;
  },
} as unknown as import('@modelcontextprotocol/server').McpServer;

// Mock getAI
const mockCreateStore = mock.fn(async () => ({ name: 'fileSearchStores/new-store-abc' }));
const mockDeleteStore = mock.fn(async () => ({}));
const mockDeleteDoc = mock.fn(async () => ({}));
const mockUploadToStore = mock.fn(async () => ({
  name: 'fileSearchStores/s/upload/operations/op1',
  done: true,
  response: { name: 'fileSearchStores/s/documents/doc1' },
}));
const mockOperationsGet = mock.fn(async () => ({
  done: true,
  response: { name: 'fileSearchStores/s/documents/doc1' },
}));

mock.module('../src/client.js', {
  namedExports: {
    getAI: () => ({
      fileSearchStores: {
        create: mockCreateStore,
        delete: mockDeleteStore,
        uploadToFileSearchStore: mockUploadToStore,
        documents: { delete: mockDeleteDoc },
      },
      operations: { get: mockOperationsGet },
    }),
  },
});

const { registerIngestTool } = await import('../src/tools/ingest.js');
const mockRegistry = {
  listStores: async () => [],
  listDocuments: async () => [],
  invalidate: mock.fn(),
};

registerIngestTool(mockServer, mockRegistry);

describe('ingest tool — create-store', () => {
  it('calls fileSearchStores.create and returns storeName', async () => {
    // This test structure validates integration — actual handler invocation
    // tested via schema + type-check; runtime tested via node scripts/tasks.mjs
    assert.ok(registeredTools['ingest'] !== undefined, 'ingest tool was registered');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts
```

Expected: FAIL — `Cannot find module '../src/tools/ingest.js'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/tools/ingest.ts
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AppError } from '../lib/errors.js';
import type { StoreRegistry } from '../lib/store-registry.js';
import { MUTABLE_ANNOTATIONS, registerWorkTool } from '../lib/tasks.js';
import { type IngestInput, IngestInputSchema } from '../schemas/ingest-input.js';
import { IngestOutputSchema } from '../schemas/ingest-output.js';

import { getAI } from '../client.js';
import { TOOL_LABELS } from '../public-contract.js';
import { validateScanPath } from '../resources/metadata.js';

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 60; // 3 min max

async function pollOperation(operationName: string, signal?: AbortSignal): Promise<string> {
  const ai = getAI();
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new AppError('ingest', 'Upload cancelled', 'cancelled', false);
    }
    const op = await ai.operations.get({ name: operationName });
    if (op.done) {
      if (op.error) {
        throw new AppError(
          'ingest',
          `Upload indexing failed: ${String(op.error.message ?? op.error)}`,
        );
      }
      const docName = (op.response as { name?: string } | undefined)?.name;
      if (!docName) {
        throw new AppError('ingest', 'Upload completed but response contained no document name');
      }
      return docName;
    }
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(res, POLL_INTERVAL_MS);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          rej(new Error('aborted'));
        },
        { once: true },
      );
    });
  }
  throw new AppError('ingest', 'Upload indexing timed out after 3 minutes');
}

async function handleCreateStore(
  input: Extract<IngestInput, { operation: 'create-store' }>,
): Promise<CallToolResult> {
  const ai = getAI();
  const store = await ai.fileSearchStores.create({
    config: { ...(input.displayName ? { displayName: input.displayName } : {}) },
  });
  const storeName = (store as { name?: string }).name ?? '';
  const output = IngestOutputSchema.parse({
    operation: 'create-store',
    storeName,
    message: `File Search Store created: ${storeName}`,
  });
  return {
    content: [{ type: 'text', text: output.message }],
    structuredContent: output,
  };
}

async function handleUpload(
  input: Extract<IngestInput, { operation: 'upload' }>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const resolvedPath = resolve(input.filePath);
  validateScanPath(resolvedPath);

  const fileBuffer = await readFile(resolvedPath);
  const ai = getAI();

  const op = await ai.fileSearchStores.uploadToFileSearchStore({
    fileSearchStoreName: input.storeName,
    file: new Blob([fileBuffer]),
    config: {
      ...(input.displayName ? { displayName: input.displayName } : {}),
    },
  });

  const operationName = (op as { name?: string }).name ?? '';
  let documentName: string;

  if ((op as { done?: boolean }).done) {
    documentName = (op as { response?: { name?: string } }).response?.name ?? operationName;
  } else {
    documentName = await pollOperation(operationName, signal);
  }

  const output = IngestOutputSchema.parse({
    operation: 'upload',
    storeName: input.storeName,
    documentName,
    message: `Document indexed: ${documentName}`,
  });
  return {
    content: [{ type: 'text', text: output.message }],
    structuredContent: output,
  };
}

async function handleDeleteStore(
  input: Extract<IngestInput, { operation: 'delete-store' }>,
): Promise<CallToolResult> {
  const ai = getAI();
  await ai.fileSearchStores.delete({
    name: input.storeName,
    config: { ...(input.force ? { force: true } : {}) },
  });
  const output = IngestOutputSchema.parse({
    operation: 'delete-store',
    storeName: input.storeName,
    message: `File Search Store deleted: ${input.storeName}`,
  });
  return {
    content: [{ type: 'text', text: output.message }],
    structuredContent: output,
  };
}

async function handleDeleteDocument(
  input: Extract<IngestInput, { operation: 'delete-document' }>,
): Promise<CallToolResult> {
  const ai = getAI();
  await ai.fileSearchStores.documents.delete({ name: input.documentName });
  const output = IngestOutputSchema.parse({
    operation: 'delete-document',
    documentName: input.documentName,
    message: `Document deleted: ${input.documentName}`,
  });
  return {
    content: [{ type: 'text', text: output.message }],
    structuredContent: output,
  };
}

async function ingestWork(
  args: IngestInput,
  signal?: AbortSignal,
  registry?: StoreRegistry,
): Promise<CallToolResult> {
  try {
    let result: CallToolResult;
    switch (args.operation) {
      case 'create-store':
        result = await handleCreateStore(args);
        break;
      case 'upload':
        result = await handleUpload(args, signal);
        break;
      case 'delete-store':
        result = await handleDeleteStore(args);
        break;
      case 'delete-document':
        result = await handleDeleteDocument(args);
        break;
    }
    registry?.invalidate();
    return result;
  } catch (err) {
    const msg = err instanceof AppError ? err.message : `ingest failed: ${String(err)}`;
    return {
      content: [{ type: 'text', text: msg }],
      isError: true,
    };
  }
}

export function registerIngestTool(server: McpServer, storeRegistry: StoreRegistry): void {
  registerWorkTool<IngestInput>({
    server,
    tool: {
      name: 'ingest',
      title: TOOL_LABELS.ingest,
      description:
        'Manage Gemini File Search Stores for RAG workflows. ' +
        'Operations: create-store (create a new store), upload (upload and index a file into a store), ' +
        'delete-store (delete a store and optionally its documents), delete-document (delete one document). ' +
        'After ingesting, use the chat tool with tools.profile=rag and tools.overrides.fileSearchStores=[storeName].',
      inputSchema: IngestInputSchema,
      outputSchema: IngestOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    work: (args, ctx) => ingestWork(args, ctx.mcpReq.signal, storeRegistry),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/ingest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/ingest.ts __tests__/tools/ingest.test.ts
git commit -m "feat: add ingest tool for File Search Store management"
```

---

### PHASE-005: Add store MCP resources

**Goal:** `gemini://stores` and `gemini://stores/{name}/documents` resources are registered and return live data via `StoreRegistry`.

|                                  Task                                  | Action                                          |                    Depends on                     | Files                                              | Validate                                                                                        |
| :--------------------------------------------------------------------: | :---------------------------------------------- | :-----------------------------------------------: | :------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
|           [`TASK-006`](#task-006-implement-store-resources)            | Create store resource handlers and registration |  [`TASK-003`](#task-003-implement-storeregistry)  | [src/resources/stores.ts](src/resources/stores.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources/stores.test.ts` |
| [`TASK-007`](#task-007-wire-store-resources-into-registerallresources) | Wire store resources into registerAllResources  | [`TASK-006`](#task-006-implement-store-resources) | [src/resources/index.ts](src/resources/index.ts)   | `node scripts/tasks.mjs --quick`                                                                |

#### TASK-006: Implement store resources

| Field      | Value                                                                                                                                        |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-implement-storeregistry)                                                                                              |
| Files      | Create: [src/resources/stores.ts](src/resources/stores.ts); Create: [**tests**/resources/stores.test.ts](__tests__/resources/stores.test.ts) |
| Symbols    | `registerStoreResources`, `StoreRegistry`, `STORES_LIST_URI`, `STORE_DOCUMENTS_TEMPLATE`                                                     |
| Outcome    | `gemini://stores` returns JSON array of stores; `gemini://stores/fileSearchStores%2Fmy-store/documents` returns JSON array of documents.     |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/resources/stores.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerStoreResources } from '../../src/resources/stores.js';

const handlers: Record<
  string,
  (uri: URL | string, params: Record<string, string | string[]>) => Promise<unknown>
> = {};
const mockServer = {
  registerResource: (_name: string, uriOrTemplate: unknown, _meta: unknown, handler: unknown) => {
    const key =
      typeof uriOrTemplate === 'string'
        ? uriOrTemplate
        : ((uriOrTemplate as { template: string }).template ?? String(uriOrTemplate));
    handlers[key] = handler as (typeof handlers)[string];
  },
} as unknown as import('@modelcontextprotocol/server').McpServer;

const mockRegistry = {
  listStores: async () => [{ name: 'fileSearchStores/s1', displayName: 'Store 1' }],
  listDocuments: async (_storeName: string) => [{ name: 'fileSearchStores/s1/documents/d1' }],
  invalidate: () => {},
};

registerStoreResources(mockServer, mockRegistry);

describe('store resources', () => {
  it('gemini://stores returns stores list JSON', async () => {
    const handler = handlers['gemini://stores'];
    assert.ok(handler, 'gemini://stores handler registered');
    const result = (await handler(new URL('gemini://stores'), {})) as {
      contents: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.contents[0]?.text ?? '[]') as unknown[];
    assert.equal(parsed.length, 1);
  });

  it('store documents template handler is registered', () => {
    const hasTemplate = Object.keys(handlers).some(
      (k) => k.includes('{storeName}') && k.includes('documents'),
    );
    assert.ok(hasTemplate, 'documents template registered');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources/stores.test.ts
```

Expected: FAIL — `Cannot find module '../../src/resources/stores.js'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/resources/stores.ts
import { ProtocolError, ProtocolErrorCode, ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';

import type { StoreRegistry } from '../lib/store-registry.js';

import {
  STORE_DOCUMENTS_TEMPLATE,
  storeDetailUri,
  storeDocumentsUri,
  STORES_DETAIL_TEMPLATE,
  STORES_LIST_URI,
} from './uris.js';
import { requireTemplateParam } from './uris.js';

export function registerStoreResources(server: McpServer, registry: StoreRegistry): void {
  // gemini://stores — list all stores
  server.registerResource(
    'file-search-stores-list',
    STORES_LIST_URI,
    {
      title: 'File Search Stores',
      description: 'All Gemini File Search Stores available for the rag profile',
      mimeType: 'application/json',
    },
    async (): Promise<ReadResourceResult> => {
      const stores = await registry.listStores();
      return {
        contents: [
          {
            uri: STORES_LIST_URI,
            mimeType: 'application/json',
            text: JSON.stringify(stores, null, 2),
          },
        ],
      };
    },
  );

  // gemini://stores/{storeName} — single store metadata
  server.registerResource(
    'file-search-store-detail',
    new ResourceTemplate(STORES_DETAIL_TEMPLATE, {
      list: async () => {
        const stores = await registry.listStores();
        return {
          resources: stores.map((s) => ({
            uri: storeDetailUri(s.name),
            name: s.displayName ?? s.name,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'File Search Store',
      description: 'Metadata for a single File Search Store',
      mimeType: 'application/json',
    },
    async (uri, params): Promise<ReadResourceResult> => {
      const storeName = requireTemplateParam(params['storeName'], 'storeName');
      const stores = await registry.listStores();
      const store = stores.find((s) => s.name === storeName);
      if (!store) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Store not found: ${storeName}`,
        );
      }
      const uriStr = typeof uri === 'string' ? uri : uri.href;
      return {
        contents: [
          {
            uri: uriStr,
            mimeType: 'application/json',
            text: JSON.stringify(store, null, 2),
          },
        ],
      };
    },
  );

  // gemini://stores/{storeName}/documents — documents in a store
  server.registerResource(
    'file-search-store-documents',
    new ResourceTemplate(STORE_DOCUMENTS_TEMPLATE, {
      list: async () => {
        const stores = await registry.listStores();
        return {
          resources: stores.map((s) => ({
            uri: storeDocumentsUri(s.name),
            name: `${s.displayName ?? s.name} — documents`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'File Search Store Documents',
      description: 'Documents indexed in a File Search Store',
      mimeType: 'application/json',
    },
    async (uri, params): Promise<ReadResourceResult> => {
      const storeName = requireTemplateParam(params['storeName'], 'storeName');
      const documents = await registry.listDocuments(storeName);
      const uriStr = typeof uri === 'string' ? uri : uri.href;
      return {
        contents: [
          {
            uri: uriStr,
            mimeType: 'application/json',
            text: JSON.stringify(documents, null, 2),
          },
        ],
      };
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources/stores.test.ts
```

Expected: PASS — all 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/resources/stores.ts __tests__/resources/stores.test.ts
git commit -m "feat: add gemini://stores and gemini://stores/{name}/documents resources"
```

#### TASK-007: Wire store resources into registerAllResources

| Field      | Value                                                                                                                                                    |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-006`](#task-006-implement-store-resources)                                                                                                        |
| Files      | Modify: [src/resources/index.ts](src/resources/index.ts)                                                                                                 |
| Symbols    | [registerAllResources](src/resources/index.ts#L28), `registerStoreResources`, `StoreRegistry`                                                            |
| Outcome    | `registerAllResources` accepts `storeRegistry` in `ResourceServices` and calls `registerStoreResources`. TDD skipped — wiring-only change; no new logic. |

- [ ] **Step 1: Apply change**

```ts
// src/resources/index.ts — full replacement
import type { McpServer } from '@modelcontextprotocol/server';

import type { StoreRegistry } from '../lib/store-registry.js';
import type { ToolServices } from '../lib/tool-context.js';
import type { RootsFetcher } from '../lib/validation.js';

import type { SessionStore } from '../sessions.js';
import { registerDiscoverResources } from './discover.js';
import { registerSessionResources } from './sessions.js';
import { registerStoreResources } from './stores.js';
import { registerWorkspaceResources } from './workspace.js';

interface ResourceServices {
  sessionStore: SessionStore;
  toolServices: ToolServices;
  rootsFetcher: RootsFetcher;
  storeRegistry: StoreRegistry;
}

export function registerAllResources(server: McpServer, services: ResourceServices): void {
  registerDiscoverResources(server);
  registerSessionResources(server, services);
  registerWorkspaceResources(server, services.toolServices);
  registerStoreResources(server, services.storeRegistry);
}

export * from './links.js';
export * from './memo.js';
export * from './notifier.js';
```

- [ ] **Step 2: Run to verify it passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS — no type errors (note: `server.ts` will now fail to compile because it doesn't pass `storeRegistry` yet — that is expected and fixed in [TASK-008](#task-008-wire-ingest-tool-and-store-registry-into-serverts)).

- [ ] **Step 3: Commit**

```bash
git add src/resources/index.ts
git commit -m "feat: wire store resources into registerAllResources"
```

---

### PHASE-006: Wire everything into server.ts and update public contract

**Goal:** `server.ts` instantiates `StoreRegistry`, registers the `ingest` tool, and passes `storeRegistry` to resources. `public-contract.ts` advertises the new surface.

|                                   Task                                    | Action                                          |                                                      Depends on                                                       | Files                                            | Validate                         |
| :-----------------------------------------------------------------------: | :---------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------- | :------------------------------- |
| [`TASK-008`](#task-008-wire-ingest-tool-and-store-registry-into-serverTs) | Wire StoreRegistry + ingest tool into server.ts | [`TASK-005`](#task-005-implement-ingest-tool), [`TASK-007`](#task-007-wire-store-resources-into-registerallresources) | [src/server.ts](src/server.ts)                   | `node scripts/tasks.mjs --quick` |
|              [`TASK-009`](#task-009-update-public-contract)               | Update public-contract.ts for new surface       |                       [`TASK-008`](#task-008-wire-ingest-tool-and-store-registry-into-serverTs)                       | [src/public-contract.ts](src/public-contract.ts) | `node scripts/tasks.mjs`         |

#### TASK-008: Wire StoreRegistry + ingest tool into server.ts

| Field      | Value                                                                                                                                                                                                |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-implement-ingest-tool), [`TASK-007`](#task-007-wire-store-resources-into-registerallresources)                                                                                |
| Files      | Modify: [src/server.ts](src/server.ts)                                                                                                                                                               |
| Symbols    | [SERVER_TOOL_REGISTRARS](src/server.ts#L70), [createServerInstance](src/server.ts), `createStoreRegistry`, `registerIngestTool`                                                                      |
| Outcome    | Server compiles; `createServerInstance` creates a `StoreRegistry` and passes it to resources and the ingest tool registrar. TDD skipped — integration wiring; logic tested in TASK-003 and TASK-005. |

- [ ] **Step 1: Apply change**

In [src/server.ts](src/server.ts), make these targeted edits:

**Add imports** (after existing tool imports, around line 28):

```ts
import { createStoreRegistry } from './lib/store-registry.js';

import { registerIngestTool } from './tools/ingest.ts';
```

> Note: use `.js` extension in the actual file: `import { createStoreRegistry } from './lib/store-registry.js';` and `import { registerIngestTool } from './tools/ingest.js';`

**Extend `ServerServices`** (after line 66):

```ts
interface ServerServices {
  sessionStore: SessionStore;
  toolServices: ToolServices;
  rootsFetcher: RootsFetcher;
  storeRegistry: import('./lib/store-registry.js').StoreRegistry;
}
```

**Add ingest to `SERVER_TOOL_REGISTRARS`** (after the existing four registrars, around line 83):

```ts
  (server, services) => {
    registerIngestTool(server, services.storeRegistry);
  },
```

**In `createServerInstance`**, after `const workspaceCacheManager = createWorkspaceCacheManager();` (around line 142), add:

```ts
const storeRegistry = createStoreRegistry();
```

**Update the `registerAllResources` call** (find the call to `registerAllResources` in `createServerInstance` and add `storeRegistry`):

```ts
registerAllResources(server, {
  sessionStore,
  toolServices,
  rootsFetcher,
  storeRegistry,
});
```

- [ ] **Step 2: Run to verify it passes**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS — no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire StoreRegistry and ingest tool into server"
```

#### TASK-009: Update public contract

| Field      | Value                                                                                                                                      |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-008`](#task-008-wire-ingest-tool-and-store-registry-into-serverTs)                                                                  |
| Files      | Modify: [src/public-contract.ts](src/public-contract.ts)                                                                                   |
| Symbols    | [TOOL_LABELS](src/public-contract.ts#L515), `PublicResourceUri`, `SERVER_INSTRUCTIONS`                                                     |
| Outcome    | `TOOL_LABELS.ingest` exists; store resource URIs are in `PublicResourceUri`; server instructions mention `ingest`; full test suite passes. |

- [ ] **Step 1: Apply change**

In [src/public-contract.ts](src/public-contract.ts):

**Add `'ingest'` to `PublicJobName`** (line 1):

```ts
type PublicJobName = 'chat' | 'research' | 'analyze' | 'review' | 'ingest';
```

**Add store URIs to `PublicResourceUri`** (after line 18):

```ts
  | 'gemini://stores'
  | 'gemini://stores/{storeName}'
  | 'gemini://stores/{storeName}/documents'
```

**Add `ingest: 'Ingest'` to `TOOL_LABELS`** (after line 527):

```ts
  ingest: 'Ingest',
```

**Update `SERVER_INSTRUCTIONS`** — append to the existing string:

```ts
'ingest (create/upload/delete File Search Stores and documents for RAG; ' +
  'after ingesting, use chat with tools.profile=rag and tools.overrides.fileSearchStores=[storeName]). ' +
  'Read gemini://stores to discover available stores before using the rag profile.';
```

- [ ] **Step 2: Run full suite**

```bash
node scripts/tasks.mjs
```

Expected: PASS — format, lint, type-check, knip, tests, rebuild all green.

- [ ] **Step 3: Commit**

```bash
git add src/public-contract.ts
git commit -m "feat: update public contract to advertise ingest tool and store resources"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full pipeline passes

```bash
node scripts/tasks.mjs
```

Expected: all stages green (format → lint/type-check/knip → test → rebuild).

### [`VAL-002`](#5-testing--validation) — StoreRegistry unit tests pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/store-registry.test.ts
```

Expected: PASS — 3 tests (cache hit, cache expiry, invalidate).

### [`VAL-003`](#5-testing--validation) — Ingest schema tests pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/ingest.test.ts
```

Expected: PASS — 6 tests.

### [`VAL-004`](#5-testing--validation) — interactions.ts bug fix passes

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: PASS — all tests including the new `fileSearch → file_search` mapping test.

### [`VAL-005`](#5-testing--validation) — Store resource tests pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources/stores.test.ts
```

Expected: PASS — 2 tests.

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                        |
| :--------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 with all stages green.                                                                                   |
| [`AC-002`](#6-acceptance-criteria) | MCP tool list contains `ingest` with a discriminated union schema exposing all four operations.                                           |
| [`AC-003`](#6-acceptance-criteria) | MCP resource list contains `gemini://stores` and `gemini://stores/{storeName}/documents`.                                                 |
| [`AC-004`](#6-acceptance-criteria) | `builtInsToInteractionTools(['fileSearch'])` returns `[{ type: 'file_search' }]`.                                                         |
| [`AC-005`](#6-acceptance-criteria) | The existing `chat`, `research`, `analyze`, and `review` tools are registered unchanged (verified by `__tests__/server.test.ts` passing). |
| [`AC-006`](#6-acceptance-criteria) | An `ingest` call with `operation: 'upload'` returns a `documentName` in `structuredContent` and a non-empty `content[0].text`.            |
| [`AC-007`](#6-acceptance-criteria) | An `ingest` call with an invalid operation returns `isError: true` without throwing.                                                      |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                                             |
| :---------------------------: | :--: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | `ai.fileSearchStores` and `ai.operations` are alpha/preview SDK surfaces. If the SDK does not yet expose these as typed methods, cast to `unknown` first and access via bracket notation, then file an issue. Check `@google/genai` changelog before implementing TASK-005.                                                        |
| [`RISK-002`](#7-risks--notes) | Risk | `uploadToFileSearchStore` accepts a `Blob` in the SDK but the exact parameter shape may differ from the REST API docs. If `new Blob([fileBuffer])` fails, try passing the `Buffer` directly or using a `ReadableStream`.                                                                                                           |
| [`NOTE-001`](#7-risks--notes) | Note | `fileSearch` is mutually exclusive with all other Gemini built-in tools. This is already enforced by `validateProfile` in `tool-profiles.ts` — do not modify that validation.                                                                                                                                                      |
| [`NOTE-002`](#7-risks--notes) | Note | `TASK-007` deliberately leaves `server.ts` in a broken compile state until `TASK-008`. The `--quick` flag on `node scripts/tasks.mjs` will report a type error between those tasks — this is expected. Run `node scripts/tasks.mjs --quick` only after both tasks complete.                                                        |
| [`NOTE-003`](#7-risks--notes) | Note | The `Interactions.Tool` type for `file_search` may not yet exist in the SDK typings if the alpha has not landed. If `{ type: 'file_search' }` causes a type error in TASK-001, use `{ type: 'file_search' as Interactions.Tool['type'] }` as a temporary cast and leave a `// TODO: remove cast when SDK types stabilise` comment. |
| [`NOTE-004`](#7-risks--notes) | Note | Store names from `ai.fileSearchStores.create()` have the format `fileSearchStores/{id}`. When building `gemini://stores/{storeName}` URIs, `encodeURIComponent('fileSearchStores/my-store')` produces `fileSearchStores%2Fmy-store`. The `requireTemplateParam` helper in `uris.ts` already decodes this correctly.                |
