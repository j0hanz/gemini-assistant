# Codebase Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce duplication and consolidate the gemini-assistant MCP server source tree without growing file count. Net -3 files (53 → 50). Add region headers to the three monolith files. Extract one truly-shared helper. No public API changes.

**Architecture:** Six phases that land independently. Phases 1–4 are mechanical file moves and reorganisation. Phase 5 extracts a single shared helper (with two more deferred if real duplication is not found). Phase 6 reorganises the three biggest tool files with region headers and rewires them to the helper from Phase 5.

**Tech Stack:** TypeScript strict (NodeNext, `verbatimModuleSyntax`), `node:test` via `tsx/esm`, Zod v4, `@google/genai`, `@modelcontextprotocol/server`, `@cfworker/json-schema`.

**Spec:** [`docs/superpowers/specs/2026-05-06-codebase-refactor-design.md`](../specs/2026-05-06-codebase-refactor-design.md)

---

## Verification gate (every phase)

After every phase, run:

```bash
node scripts/tasks.mjs
```

Expected: all green (format → lint → type-check → knip → test → rebuild).
If anything fails, fix the underlying issue before committing the phase. Do NOT pass `--all` to mask failures.

To verify no dead code is left after a deletion:

```bash
npm run knip
```

---

## Phase 1 — Delete `validation.ts` barrel

**Prerequisite:** None.
**Enables:** Phase 5 (cleaner namespace before extracting new helpers).

`src/lib/validation.ts` (83 lines) is a re-export barrel left behind after the validation split into `host-guard`/`url-guard`/`path-guard`. It also still owns one piece of real logic — `validateGeminiRequest` and the `GeminiRequestPreflight` type — used only by `tool-executor.ts`.

This phase moves the real logic into `tool-executor.ts` (its only consumer) and deletes the barrel and its redundant test file.

### Task 1.1 — Move `validateGeminiRequest` into `tool-executor.ts`

**Files:**

- Modify: `src/lib/tool-executor.ts`
- Modify: `src/lib/validation.ts` (delete the moved code)

- [ ] **Step 1: Open `src/lib/validation.ts` and copy lines 1–3 imports + lines 10–83 (everything after the re-exports) into `src/lib/tool-executor.ts`.** Insert the moved code after the existing imports and before `type ToolLabelKey`.

  Code to add to `tool-executor.ts` (append after the existing imports block):

  ```ts
  // ── Gemini Request Preflight ──────────────────────────────────────────────

  // Local mirror of orchestration.ActiveCapability to avoid type-import cycle with orchestration.ts.
  type PreflightCapability =
    | 'googleSearch'
    | 'urlContext'
    | 'codeExecution'
    | 'fileSearch'
    | 'functions';

  export interface GeminiRequestPreflight {
    allowExistingSessionSchema?: boolean | undefined;
    hasExistingSession?: boolean | undefined;
    jsonMode?: boolean | undefined;
    responseSchema?: unknown;
    sessionId?: string | undefined;
    activeCapabilities: ReadonlySet<PreflightCapability>;
    fileSearchStoreNames?: readonly string[] | undefined;
  }

  type PreflightCheck = (req: GeminiRequestPreflight) => CallToolResult | undefined;

  const disallowSchemaWithCodeExecution: PreflightCheck = (req) => {
    const schemaRequested = req.jsonMode ?? req.responseSchema !== undefined;
    if (schemaRequested && req.activeCapabilities.has('codeExecution')) {
      return new AppError(
        'chat',
        'chat: responseSchema cannot be combined with codeExecution',
      ).toToolResult();
    }
    return undefined;
  };

  const disallowEmptyFileSearchStore: PreflightCheck = (req) => {
    if (
      req.activeCapabilities.has('fileSearch') &&
      req.fileSearchStoreNames?.some((name) => name.trim().length === 0)
    ) {
      return new AppError(
        'chat',
        'chat: fileSearchStoreNames cannot contain empty values',
      ).toToolResult();
    }
    return undefined;
  };

  const disallowSchemaInExistingSession: PreflightCheck = (req) => {
    if (
      req.responseSchema &&
      req.sessionId &&
      req.hasExistingSession &&
      req.allowExistingSessionSchema !== true
    ) {
      return new AppError(
        'chat',
        'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
      ).toToolResult();
    }
    return undefined;
  };

  const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
    disallowSchemaWithCodeExecution,
    disallowEmptyFileSearchStore,
    disallowSchemaInExistingSession,
  ];

  export function validateGeminiRequest(req: GeminiRequestPreflight): CallToolResult | undefined {
    for (const check of PREFLIGHT_CHECKS) {
      const result = check(req);
      if (result) return result;
    }
    return undefined;
  }
  ```

  Note: `tool-executor.ts` already imports `AppError` from `./errors.js` and `CallToolResult` from `@modelcontextprotocol/server` — no new imports needed.

- [ ] **Step 2: Remove the now-stale import in `tool-executor.ts`.**

  In `src/lib/tool-executor.ts` line 35, delete:

  ```ts
  import { type GeminiRequestPreflight, validateGeminiRequest } from './validation.js';
  ```

- [ ] **Step 3: Run type-check to verify nothing broke.**

  ```bash
  npm run type-check
  ```

  Expected: success.

- [ ] **Step 4: Run the test suite.**

  ```bash
  npm test
  ```

  Expected: all tests pass (no behaviour change).

- [ ] **Step 5: Commit.**

  ```bash
  git add src/lib/tool-executor.ts
  git commit -m "refactor: move validateGeminiRequest from validation.ts into tool-executor.ts"
  ```

### Task 1.2 — Delete `validation.ts` and its redundant test file

**Files:**

- Delete: `src/lib/validation.ts`
- Delete: `__tests__/lib/validation.test.ts`

`__tests__/lib/validation.test.ts` only exercises symbols re-exported from `host-guard` / `url-guard` / `path-guard`. The same behaviours are already covered by `__tests__/lib/host-guard.test.ts`, `__tests__/lib/url-guard.test.ts`, and `__tests__/lib/path-guard.test.ts`. The test file is redundant and goes with the barrel.

- [ ] **Step 1: Verify `validation.test.ts` is purely re-export coverage.**

  ```bash
  npm test -- __tests__/lib/validation.test.ts
  ```

  Expected: tests pass. Skim the file (lines 1–11) — it imports six symbols from `validation.js`, all re-exports.

  Verify the underlying tests exist:

  ```bash
  ls __tests__/lib/host-guard.test.ts __tests__/lib/url-guard.test.ts __tests__/lib/path-guard.test.ts
  ```

  Expected: all three files exist.

- [ ] **Step 2: Verify no remaining importers of `validation.js` in `src/`.**

  ```bash
  git grep -n "from '.*validation\.js'" -- src/
  ```

  Expected: no matches (Task 1.1 removed the only one).

- [ ] **Step 3: Delete the files.**

  ```bash
  rm src/lib/validation.ts __tests__/lib/validation.test.ts
  ```

- [ ] **Step 4: Run the full task pipeline.**

  ```bash
  node scripts/tasks.mjs
  ```

  Expected: all green. `knip` should not flag any new dead code.

- [ ] **Step 5: Commit.**

  ```bash
  git add -u src/lib/validation.ts __tests__/lib/validation.test.ts
  git commit -m "refactor: delete validation.ts barrel and its redundant test"
  ```

---

## Phase 2 — Fold `tool-context.ts` into `tool-executor.ts`

**Prerequisite:** None (independent of Phase 1).
**Enables:** Phase 5 (single home for tool plumbing).

`src/lib/tool-context.ts` (38 lines) is mostly re-exports. The real exports — `ToolServices`, `ToolRootsFetcher`, `ToolWorkspaceAccess`, `ToolWorkspaceCacheManager`, and `createDefaultToolServices` — belong with `tool-executor.ts`, which already owns the rest of "tool plumbing" (`createToolContext`, `executor`, etc.).

Seven importers update to point at `tool-executor.js`.

### Task 2.1 — Move types and helpers into `tool-executor.ts`

**Files:**

- Modify: `src/lib/tool-executor.ts`

- [ ] **Step 1: Open `src/lib/tool-executor.ts` and append the contents of `tool-context.ts` (without the re-exports of helpers, which we keep direct).**

  Add at the bottom of `src/lib/tool-executor.ts`:

  ```ts
  // ── Tool services (consolidated from tool-context.ts) ──────────────────────

  import type { ClientCapabilities } from '@modelcontextprotocol/server';
  import { createSessionAccess, createSessionStore, type SessionAccess } from '../sessions.js';
  import {
    buildContextUsed,
    createWorkspaceAccess,
    createWorkspaceCacheManager,
    emptyContextUsed,
    type WorkspaceAccess,
    type WorkspaceCacheManagerImpl,
  } from './workspace-context.js';
  import { isPathWithinRoot, type RootsFetcher } from './path-guard.js';

  type ClientCapabilitiesAccessor = () => ClientCapabilities | undefined;

  export interface ToolServices {
    rootsFetcher: RootsFetcher;
    session: SessionAccess;
    workspace: WorkspaceAccess;
    clientCapabilities: ClientCapabilitiesAccessor;
  }

  export type ToolRootsFetcher = ToolServices['rootsFetcher'];
  export type ToolWorkspaceAccess = ToolServices['workspace'];
  export type ToolWorkspaceCacheManager = WorkspaceCacheManagerImpl;

  export function createDefaultToolServices(): ToolServices {
    return {
      rootsFetcher: () => Promise.resolve([]),
      session: createSessionAccess(createSessionStore()),
      workspace: createWorkspaceAccess(createWorkspaceCacheManager()),
      clientCapabilities: () => undefined,
    };
  }

  export { isPathWithinRoot, buildContextUsed, emptyContextUsed };
  ```

  Hoist the new `import type { ClientCapabilities }` and the workspace/session imports to the top import block, alongside the existing imports, to follow the file's existing import style (do not leave imports inline at the bottom). Keep the section header `// ── Tool services ──` where it is.

  Final import block top of `tool-executor.ts` should now include:

  ```ts
  import type { CallToolResult, ClientCapabilities, ServerContext } from '@modelcontextprotocol/server';
  // ... existing imports ...
  import { createSessionAccess, createSessionStore, type SessionAccess } from '../sessions.js';
  import { isPathWithinRoot, type RootsFetcher } from './path-guard.js';
  import {
    buildContextUsed,
    createWorkspaceAccess,
    createWorkspaceCacheManager,
    emptyContextUsed,
    type WorkspaceAccess,
    type WorkspaceCacheManagerImpl,
  } from './workspace-context.js';
  ```

- [ ] **Step 2: Run type-check.**

  ```bash
  npm run type-check
  ```

  Expected: success. Errors here usually mean the new imports duplicate existing ones — consolidate them.

- [ ] **Step 3: Commit (intermediate).**

  ```bash
  git add src/lib/tool-executor.ts
  git commit -m "refactor: hoist ToolServices types into tool-executor.ts"
  ```

### Task 2.2 — Update all 7 importers of `tool-context.js`

**Files:**

- Modify: `src/server.ts`
- Modify: `src/resources/index.ts`
- Modify: `src/tools/analyze.ts`
- Modify: `src/tools/chat.ts`
- Modify: `src/tools/ingest.ts`
- Modify: `src/tools/research.ts`
- Modify: `src/tools/review.ts`

Every `import ... from '../lib/tool-context.js'` (or `'./lib/tool-context.js'` in `server.ts`) becomes `from '../lib/tool-executor.js'` (or `'./lib/tool-executor.js'`). Symbols are identical.

- [ ] **Step 1: Update `src/server.ts` line 12.**

  Change:

  ```ts
  import type { ToolServices } from './lib/tool-context.js';
  ```

  To:

  ```ts
  import type { ToolServices } from './lib/tool-executor.js';
  ```

- [ ] **Step 2: Update `src/resources/index.ts` line 5.**

  Change:

  ```ts
  import type { ToolServices } from '../lib/tool-context.js';
  ```

  To:

  ```ts
  import type { ToolServices } from '../lib/tool-executor.js';
  ```

- [ ] **Step 3: Update `src/tools/analyze.ts` lines 23–27.**

  Change:

  ```ts
  import {
    createDefaultToolServices,
    type ToolRootsFetcher,
    type ToolServices,
  } from '../lib/tool-context.js';
  ```

  To:

  ```ts
  import {
    createDefaultToolServices,
    type ToolRootsFetcher,
    type ToolServices,
  } from '../lib/tool-executor.js';
  ```

  And merge with the existing `import { createToolContext, executor } from '../lib/tool-executor.js';` line into one import statement.

- [ ] **Step 4: Update `src/tools/chat.ts` lines 36–41.**

  Change:

  ```ts
  import {
    buildContextUsed,
    emptyContextUsed,
    type ToolServices,
    type ToolWorkspaceAccess,
  } from '../lib/tool-context.js';
  ```

  To:

  ```ts
  import {
    buildContextUsed,
    emptyContextUsed,
    type ToolServices,
    type ToolWorkspaceAccess,
  } from '../lib/tool-executor.js';
  ```

  Then merge with the existing `import { createToolContext, executor } from '../lib/tool-executor.js';` line.

- [ ] **Step 5: Update `src/tools/ingest.ts` line 10.**

  Change:

  ```ts
  import type { ToolRootsFetcher, ToolServices } from '../lib/tool-context.js';
  ```

  To:

  ```ts
  import type { ToolRootsFetcher, ToolServices } from '../lib/tool-executor.js';
  ```

  Then merge with the existing `import { createToolContext } from '../lib/tool-executor.js';` line.

- [ ] **Step 6: Update `src/tools/research.ts` line 60.**

  Change:

  ```ts
  import { createDefaultToolServices, type ToolServices } from '../lib/tool-context.js';
  ```

  To:

  ```ts
  import { createDefaultToolServices, type ToolServices } from '../lib/tool-executor.js';
  ```

  Then merge with the existing `import { createToolContext, executor, validateStreamResult } from '../lib/tool-executor.js';` line.

- [ ] **Step 7: Update `src/tools/review.ts` lines 28–34.**

  Change:

  ```ts
  import {
    createDefaultToolServices,
    isPathWithinRoot,
    type ToolRootsFetcher,
    type ToolServices,
    type ToolWorkspaceCacheManager,
  } from '../lib/tool-context.js';
  ```

  To:

  ```ts
  import {
    createDefaultToolServices,
    isPathWithinRoot,
    type ToolRootsFetcher,
    type ToolServices,
    type ToolWorkspaceCacheManager,
  } from '../lib/tool-executor.js';
  ```

  Then merge with the existing `import { createToolContext, executor } from '../lib/tool-executor.js';` line.

- [ ] **Step 8: Run type-check + lint to verify all imports resolve.**

  ```bash
  npm run type-check && npm run lint
  ```

  Expected: success.

- [ ] **Step 9: Commit (intermediate).**

  ```bash
  git add src/server.ts src/resources/index.ts src/tools/analyze.ts src/tools/chat.ts src/tools/ingest.ts src/tools/research.ts src/tools/review.ts
  git commit -m "refactor: rewire ToolServices imports to tool-executor.ts"
  ```

### Task 2.3 — Delete `tool-context.ts`

**Files:**

- Delete: `src/lib/tool-context.ts`

- [ ] **Step 1: Verify no remaining importers.**

  ```bash
  git grep -n "tool-context\.js" -- src/ __tests__/
  ```

  Expected: no matches.

- [ ] **Step 2: Delete the file.**

  ```bash
  rm src/lib/tool-context.ts
  ```

- [ ] **Step 3: Run the full task pipeline.**

  ```bash
  node scripts/tasks.mjs
  ```

  Expected: all green. Knip should not flag any new dead code in `tool-executor.ts`.

- [ ] **Step 4: Commit.**

  ```bash
  git add -u src/lib/tool-context.ts
  git commit -m "refactor: delete tool-context.ts (folded into tool-executor.ts)"
  ```

---

## Phase 3 — Merge ingest schemas

**Prerequisite:** None (independent of Phases 1, 2).
**Enables:** Cleaner schema directory before Phase 4.

`src/schemas/ingest-input.ts` (80 lines, exports `IngestOperationEnum`, `IngestInputSchema`, `IngestInput`) and `src/schemas/ingest-output.ts` (≈30 lines, exports `IngestOutputSchema`, `IngestOutput`) are paired and only used together. Merge into `src/schemas/ingest.ts`.

### Task 3.1 — Create `schemas/ingest.ts` with merged content

**Files:**

- Create: `src/schemas/ingest.ts`

- [ ] **Step 1: Create `src/schemas/ingest.ts` by concatenating the two existing files.**

  ```ts
  // src/schemas/ingest.ts
  import { z } from 'zod/v4';

  import { FileSearchStoreNameSchema, optionalField, textField, withFieldMetadata } from './fields.js';

  // ── Operation enum ─────────────────────────────────────────────────────────

  /**
   * Flat input schema for the `ingest` tool.
   *
   * MCP clients (including the MCP Inspector) introspect a tool's `inputSchema`
   * as a flat list of fields. A `z.discriminatedUnion` produces a JSON Schema
   * `anyOf` that most clients cannot render as a form, leaving the user with no
   * visible inputs. We therefore expose all fields on a single `z.strictObject`
   * and enforce per-operation requirements via `superRefine`.
   *
   * Path semantics for the `upload` operation:
   *   - a file path     → upload that single file
   *   - a directory     → walk that directory and upload all eligible files
   *
   * Workspace-wide uploads are intentionally unsupported: large workspaces
   * exceed MCP request timeouts. Always scope to a directory like `src`.
   */
  export const IngestOperationEnum = z.enum([
    'create-store',
    'upload',
    'delete-store',
    'delete-document',
  ] as const);

  // ── Input schema ───────────────────────────────────────────────────────────

  const RawIngestInputSchema = z.strictObject({
    operation: IngestOperationEnum.describe(
      "Operation to perform: 'create-store' | 'upload' | 'delete-store' | 'delete-document'.",
    ),
    storeName: FileSearchStoreNameSchema.describe(
      'File Search Store name. Required for all operations. Format: alphanumerics, _, -, /.',
    ),
    filePath: z
      .string()
      .trim()
      .max(4096)
      .optional()
      .describe(
        "Path to a file or directory (required for 'upload'). Absolute or workspace-relative (e.g. 'src').",
      ),
    documentName: optionalField(
      textField(
        'Document resource name from a previous upload (required when operation = delete-document).',
      ),
    ),
    displayName: optionalField(
      textField('Human-readable display name (optional, used by create-store and upload).', 256),
    ),
    mimeType: optionalField(
      textField('MIME type override for single-file upload (optional, ignored for batch).', 128),
    ),
  });

  export const IngestInputSchema = RawIngestInputSchema.superRefine((value, ctx) => {
    if (
      value.operation === 'upload' &&
      (value.filePath === undefined || value.filePath.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['filePath'],
        message:
          "filePath is required when operation = 'upload' (e.g. 'src', 'docs', or an absolute path).",
      });
    }
    if (
      value.operation === 'delete-document' &&
      (value.documentName === undefined || value.documentName.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentName'],
        message: "documentName is required when operation = 'delete-document'",
      });
    }
  });

  export type IngestInput = z.infer<typeof IngestInputSchema>;

  // ── Output schema ──────────────────────────────────────────────────────────

  export const IngestOutputSchema = z.strictObject({
    operation: withFieldMetadata(
      IngestOperationEnum,
      'Which operation was performed (create-store, upload, delete-store, delete-document)',
    ),
    storeName: optionalField(
      withFieldMetadata(z.string(), 'The store name involved in the operation'),
    ),
    documentName: optionalField(
      withFieldMetadata(z.string(), 'Document name (populated for single-file upload)'),
    ),
    uploadedCount: optionalField(
      withFieldMetadata(z.number().int().nonnegative(), 'Number of files uploaded (batch upload)'),
    ),
    skippedCount: optionalField(
      withFieldMetadata(
        z.number().int().nonnegative(),
        'Number of files skipped (binary, oversized, ignored directory, or cap reached)',
      ),
    ),
    uploadedFiles: optionalField(
      withFieldMetadata(
        z.array(z.string()).max(200),
        'Sample of uploaded file paths (truncated to first 200)',
      ),
    ),
    created: optionalField(
      withFieldMetadata(z.boolean(), 'True if the store was auto-created during this upload'),
    ),
    message: textField('Human-readable result message'),
  });

  export type IngestOutput = z.infer<typeof IngestOutputSchema>;
  ```

- [ ] **Step 2: Run type-check (file is not yet imported anywhere; type-check confirms it parses).**

  ```bash
  npm run type-check
  ```

  Expected: success.

### Task 3.2 — Update all 5 importers and delete the old files

**Files:**

- Modify: `src/tools/ingest.ts`
- Modify: `__tests__/schemas/ingest-input.test.ts`
- Modify: `__tests__/schemas/ingest-output.test.ts`
- Modify: `__tests__/tools/ingest.test.ts`
- Delete: `src/schemas/ingest-input.ts`
- Delete: `src/schemas/ingest-output.ts`

- [ ] **Step 1: Update `src/tools/ingest.ts` lines 12–14.**

  Change:

  ```ts
  import type { IngestInput } from '../schemas/ingest-input.js';
  import { IngestInputSchema } from '../schemas/ingest-input.js';
  import { type IngestOutput, IngestOutputSchema } from '../schemas/ingest-output.js';
  ```

  To:

  ```ts
  import {
    type IngestInput,
    IngestInputSchema,
    type IngestOutput,
    IngestOutputSchema,
  } from '../schemas/ingest.js';
  ```

- [ ] **Step 2: Update `__tests__/schemas/ingest-input.test.ts` line 4.**

  Change:

  ```ts
  import { IngestInputSchema } from '../../src/schemas/ingest-input.js';
  ```

  To:

  ```ts
  import { IngestInputSchema } from '../../src/schemas/ingest.js';
  ```

- [ ] **Step 3: Update `__tests__/schemas/ingest-output.test.ts` line 4.**

  Change:

  ```ts
  import { IngestOutputSchema } from '../../src/schemas/ingest-output.js';
  ```

  To:

  ```ts
  import { IngestOutputSchema } from '../../src/schemas/ingest.js';
  ```

- [ ] **Step 4: Update `__tests__/tools/ingest.test.ts` lines 8–11.**

  Change:

  ```ts
  import { IngestInputSchema } from '../../src/schemas/ingest-input.js';
  import type { IngestInput } from '../../src/schemas/ingest-input.js';
  import { IngestOutputSchema } from '../../src/schemas/ingest-output.js';
  import type { IngestOutput } from '../../src/schemas/ingest-output.js';
  ```

  To:

  ```ts
  import {
    type IngestInput,
    IngestInputSchema,
    type IngestOutput,
    IngestOutputSchema,
  } from '../../src/schemas/ingest.js';
  ```

- [ ] **Step 5: Verify no remaining importers of the old paths.**

  ```bash
  git grep -n "ingest-input\.js\|ingest-output\.js" -- src/ __tests__/
  ```

  Expected: no matches.

- [ ] **Step 6: Delete the old files.**

  ```bash
  rm src/schemas/ingest-input.ts src/schemas/ingest-output.ts
  ```

- [ ] **Step 7: Run the full task pipeline.**

  ```bash
  node scripts/tasks.mjs
  ```

  Expected: all green.

- [ ] **Step 8: Commit.**

  ```bash
  git add src/schemas/ingest.ts src/tools/ingest.ts __tests__/schemas/ingest-input.test.ts __tests__/schemas/ingest-output.test.ts __tests__/tools/ingest.test.ts
  git add -u src/schemas/ingest-input.ts src/schemas/ingest-output.ts
  git commit -m "refactor: merge ingest-input.ts + ingest-output.ts into ingest.ts"
  ```

---

## Phase 4 — Region headers in `transport.ts` and `response.ts`

**Prerequisite:** None (independent).
**Enables:** Faster navigation in Phase 6 when wiring helpers.

Both files are large kitchen sinks (1220 and 744 lines) but cohesive. This phase reorganises them top-to-bottom by responsibility and adds `// ── Section ──` headers in the style already used elsewhere in the codebase. **No logic changes; no extracted modules; no new files.**

The verification gate for this phase is: tests still pass, byte-for-byte same exports.

### Task 4.1 — Reorganise `transport.ts` with region headers

**Files:**

- Modify: `src/transport.ts`

- [ ] **Step 1: Read the full file once before reorganising.**

  ```bash
  wc -l src/transport.ts
  ```

  Expected: 1220 lines. Open it in an editor capable of holding the whole file in view.

- [ ] **Step 2: Reorder the file's top-level declarations into the following sections, each preceded by a `// ── Section ──` header.**

  Target layout (top to bottom):

  ```ts
  // imports (already at top, no change)

  // ── Types & runtime config ────────────────────────────────────────────────
  // - BunServerHandle, BunRuntime, DenoServerHandle, DenoRuntime, RuntimeGlobals
  // - CleanupEventStore, ServerInstance, ServerFactory, EventStoreFactory, ServerTransport
  // - ManagedPair, TransportOptions, TransportConstructor, StatefulPairMap, PairSelection
  // - ManagedRequestOptions, ResolvedTransportConfig
  // - resolveTransportRuntimeConfig
  // - HttpTransportResult, WebStandardTransportResult
  // - logger child, APPLICATION_JSON, BROAD_BIND_HOSTS, timeout constants
  // - createAsyncLock

  // ── Auth (bearer token) ──────────────────────────────────────────────────
  // - extractBearerIdentity
  // - isAuthorized
  // - assertHttpBindIsProtected

  // ── Rate limiting (per-session / per-IP / per-token) ─────────────────────
  // - parseForwardedForHeader
  // - nodeRateLimitKey
  // - webRateLimitKey
  // - takeRateLimit
  // - response helpers: nodeRateLimitedResponse, webRateLimitedResponse, missing-identity responses

  // ── Host validation ──────────────────────────────────────────────────────
  // - assertHostValidationIsConfigured
  // - isLoopbackBindHost
  // - host-related response helpers

  // ── CORS ─────────────────────────────────────────────────────────────────
  // - withCors
  // - appendUniqueHeaderValue
  // - appendResponseVaryHeader / appendHeadersVaryHeader

  // ── Session pool (LRU + TTL sweep) ───────────────────────────────────────
  // - statefulPairMap helpers
  // - LRU eviction + TTL sweep
  // - acquire/release reservation helpers

  // ── Request orchestration (managed pair lifecycle) ───────────────────────
  // - handleManagedRequest
  // - createPair / destroyPair

  // ── HTTP transport (Express) ─────────────────────────────────────────────
  // - rpcErrorPayload
  // - logListening
  // - nodeUnauthorizedResponse helpers
  // - the Express bootstrap up to startHttpTransport

  // ── Web-standard transport (Bun/Deno/Workers) ────────────────────────────
  // - webUnauthorizedResponse helpers
  // - the Web-standard handler builder up to startWebStandardTransport

  // ── Public entry ─────────────────────────────────────────────────────────
  export { startHttpTransport, startWebStandardTransport };
  ```

  Move declarations to match this top-down order. Insert the comment headers shown above (each header is one line, padded to a consistent width — copy the existing `// ── X ──` style already used in `response.ts` and `tasks.ts`).

  **Critical constraints:**
  - Do NOT change function bodies, parameter names, or return types.
  - Do NOT add or remove any `export` keywords.
  - Do NOT change which symbols are exported (the existing `startHttpTransport` and `startWebStandardTransport` are the only public exports, and they stay public; everything else stays internal).
  - Closures and helpers used only by one section must move with that section.

- [ ] **Step 3: Run lint + type-check.**

  ```bash
  npm run lint && npm run type-check
  ```

  Expected: success. Lint will catch unused imports if you accidentally drop one during the move.

- [ ] **Step 4: Run the test suite.**

  ```bash
  npm test
  ```

  Expected: all transport and end-to-end tests pass.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/transport.ts
  git commit -m "refactor: add region headers and reorganise transport.ts top-down"
  ```

### Task 4.2 — Reorganise `response.ts` with region headers

**Files:**

- Modify: `src/lib/response.ts`

- [ ] **Step 1: Reorder the file's top-level declarations into the following sections.**

  Target layout (top to bottom):

  ```ts
  // imports (already at top, no change)

  // ── pickDefined / stripEmpty / mergeStructured ───────────────────────────
  // - PickDefined type, pickDefined
  // - stripEmpty
  // - readStructuredObject, mergeStructured

  // ── JSON parsing ─────────────────────────────────────────────────────────
  // - JSON_CODE_BLOCK_PATTERN
  // - tryParseJsonResponse
  // - parseJson

  // ── URL metadata collection ──────────────────────────────────────────────
  // - domainFromPublicUrl
  // - collectUniquePublicEntries
  // - buildUrlContextSourceDetails
  // - collectUrlContextSources
  // - collectUrlMetadataWithCounts
  // - appendUrlStatus

  // ── Grounding citations ──────────────────────────────────────────────────
  // - collectGroundingCitations
  // - computeGroundingSignals
  // - deriveFindingsFromCitations
  // - countOccurrences

  // ── Source details ───────────────────────────────────────────────────────
  // - collectGroundedSourcesWithCounts
  // - collectGroundedSourceDetailsWithCounts
  // - mergeSourceDetails
  // - formatSourceLabels, formatCountLabel
  // - buildSourceReportMessage
  // - deriveOverallStatus
  // - extractSampledText

  // ── Warnings & schema validation ─────────────────────────────────────────
  // - buildDroppedSupportWarnings
  // - auditClaimedToolUsage
  // - hasSafeParse
  // - safeValidateStructuredContent
  // - buildStructuredValidationErrorResult
  // - validateStructuredToolResult
  // - extractTextContent

  // ── Structured content builders ──────────────────────────────────────────
  // - buildSharedStructuredMetadata
  // - buildBaseStructuredOutput
  // - SHARED_STRUCTURED_RESULT_KEYS
  // - pickSharedStructuredResultFields
  // - buildStructuredResponse
  // - buildSuccessfulStructuredContent
  // - appendSources
  // - withRelatedTaskMeta
  // - promptBlockedError
  // - deriveDiagramSyntaxValidation

  // ── Resource link helpers ────────────────────────────────────────────────
  // - createResourceLink (if present)
  ```

  Walk the existing file top-to-bottom, identify which section each declaration belongs to, and reorder. Insert the headers shown.

  **Critical constraints:** same as Task 4.1 — no body changes, no signature changes, no export changes.

- [ ] **Step 2: Run lint + type-check.**

  ```bash
  npm run lint && npm run type-check
  ```

  Expected: success.

- [ ] **Step 3: Run the response tests.**

  ```bash
  npm test -- __tests__/lib/response.test.ts
  ```

  Expected: pass.

- [ ] **Step 4: Run the full test suite.**

  ```bash
  npm test
  ```

  Expected: all green (response.ts is consumed by every tool).

- [ ] **Step 5: Commit.**

  ```bash
  git add src/lib/response.ts
  git commit -m "refactor: add region headers and reorganise response.ts top-down"
  ```

---

## Phase 5 — Extract one shared helper (and document deferrals)

**Prerequisite:** Phases 1, 2 (clean home for new code in `tool-executor.ts` / `response.ts`).
**Enables:** Phase 6 (rewires `chat.ts` to use the new helper).

The spec proposed three shared helpers (`buildToolResponse`, `persistToolEvent`, `validateSchemaOutput`) with the explicit rule that helpers without multiple consumers should be deferred. Exploration showed:

- **`validateSchemaOutput`** — real, lifts `validateJsonAgainstSchema` and `buildAskWarnings` out of `chat.ts` into `response.ts` where the rest of JSON parsing lives. Even with one consumer today, the move is a categorical fit (response-level utility currently in the wrong file). **Land.**
- **`persistToolEvent`** — only `chat.ts` calls `appendSessionEvent` / `appendSessionTranscript`. `research.ts` does not persist to sessions. Single consumer. **Defer; document.**
- **`buildToolResponse`** — already covered by existing `buildSuccessfulStructuredContent` and `buildStructuredResponse` in `response.ts`. The remaining variation across tools is too small to parameterise. **Defer; document.**

This phase lands the one real helper and documents the two deferrals in the commit message so the deferral reasoning is part of the project history.

### Task 5.1 — Extract `validateSchemaOutput` and `buildSchemaValidationWarnings` to `response.ts`

**Files:**

- Modify: `src/lib/response.ts`
- Modify: `src/tools/chat.ts`
- Create: `__tests__/lib/response-schema-validation.test.ts` (new, focused test for the new helpers)

- [ ] **Step 1: Write the failing test for `validateSchemaOutput` and `buildSchemaValidationWarnings`.**

  Create `__tests__/lib/response-schema-validation.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { describe, it } from 'node:test';

  import {
    buildSchemaValidationWarnings,
    validateSchemaOutput,
  } from '../../src/lib/response.js';

  describe('validateSchemaOutput', () => {
    it('returns no warnings when data matches the schema', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      assert.deepEqual(validateSchemaOutput({ name: 'ok' }, schema), []);
    });

    it('returns instance-location warnings for missing required fields', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      const warnings = validateSchemaOutput({}, schema);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /name/);
    });

    it('returns a single fallback warning when validation throws', () => {
      // A circular reference forces the cfworker validator to throw.
      const schema: Record<string, unknown> = { type: 'object' };
      schema.self = schema;
      assert.deepEqual(validateSchemaOutput({}, schema), [
        'Schema validation could not be performed',
      ]);
    });
  });

  describe('buildSchemaValidationWarnings', () => {
    it('warns when jsonMode is true but parsedData is undefined', () => {
      const warnings = buildSchemaValidationWarnings(undefined, true, undefined);
      assert.deepEqual(warnings, ['Failed to parse JSON from model response']);
    });

    it('returns no warnings when jsonMode is false and no schema is provided', () => {
      assert.deepEqual(buildSchemaValidationWarnings({}, false, undefined), []);
    });

    it('appends schema validation warnings when schema is provided', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      const warnings = buildSchemaValidationWarnings({}, true, schema);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /name/);
    });
  });
  ```

- [ ] **Step 2: Run the test — expect failure.**

  ```bash
  npm test -- __tests__/lib/response-schema-validation.test.ts
  ```

  Expected: failure with `validateSchemaOutput is not a function` (or import error).

- [ ] **Step 3: Add the helpers to `src/lib/response.ts`.**

  Add a new import at the top of the file:

  ```ts
  import { Validator } from '@cfworker/json-schema';
  ```

  Add the two helpers in the "Warnings & schema validation" section (created in Task 4.2):

  ```ts
  /**
   * Validate parsed JSON against a Gemini response schema.
   * Returns a list of human-readable warnings; an empty list means valid.
   */
  export function validateSchemaOutput(
    data: unknown,
    schema: Record<string, unknown>,
  ): string[] {
    try {
      const validator = new Validator(schema, '2020-12', false);
      const result = validator.validate(data);
      if (result.valid) return [];
      return result.errors.map((error) => `${error.instanceLocation}: ${error.error}`);
    } catch {
      return ['Schema validation could not be performed'];
    }
  }

  /**
   * Build the canonical warnings list for a schema-validated JSON response:
   * - if jsonMode was requested but parsing failed, emit "Failed to parse JSON".
   * - if parsing succeeded and a schema was provided, emit per-issue validation warnings.
   */
  export function buildSchemaValidationWarnings(
    parsedData: unknown,
    jsonMode: boolean | undefined,
    responseSchema: Record<string, unknown> | undefined,
  ): string[] {
    const warnings: string[] = [];

    if (jsonMode && parsedData === undefined) {
      warnings.push('Failed to parse JSON from model response');
    }

    if (parsedData !== undefined && responseSchema) {
      warnings.push(...validateSchemaOutput(parsedData, responseSchema));
    }

    return warnings;
  }
  ```

- [ ] **Step 4: Run the test — expect success.**

  ```bash
  npm test -- __tests__/lib/response-schema-validation.test.ts
  ```

  Expected: all three tests for each function pass.

- [ ] **Step 5: Update `chat.ts` to use the new helpers.**

  In `src/tools/chat.ts`, do four edits:

  - Remove the local `validateJsonAgainstSchema` (lines 132–141) and `buildAskWarnings` (lines 143–159).
  - Remove the unused `import { Validator } from '@cfworker/json-schema';` (line 3).
  - Update the response.ts import block (already imports several names) to include the new helpers:

  ```ts
  import {
    buildBaseStructuredOutput,
    buildSchemaValidationWarnings,
    buildStructuredResponse,
    createResourceLink,
    extractTextContent,
    mergeStructured,
    pickDefined,
    readStructuredObject,
    tryParseJsonResponse,
    validateSchemaOutput,
    withRelatedTaskMeta,
  } from '../lib/response.js';
  ```

  - Replace the single call site at line 230 — `buildAskWarnings(parsedData, jsonMode, responseSchema)` becomes `buildSchemaValidationWarnings(parsedData, jsonMode, responseSchema)`.

  Verify no remaining references:

  ```bash
  git grep -n "validateJsonAgainstSchema\|buildAskWarnings" -- src/tools/chat.ts
  ```

  Expected: no matches.

- [ ] **Step 6: Run lint + type-check.**

  ```bash
  npm run lint && npm run type-check
  ```

  Expected: success.

- [ ] **Step 7: Run the full test suite.**

  ```bash
  npm test
  ```

  Expected: all green. The chat tests should still pass since the behaviour is identical.

- [ ] **Step 8: Commit.**

  ```bash
  git add src/lib/response.ts src/tools/chat.ts __tests__/lib/response-schema-validation.test.ts
  git commit -m "$(cat <<'EOF'
  refactor: extract validateSchemaOutput / buildSchemaValidationWarnings to response.ts

  These helpers used to live in chat.ts but belong with the rest of the
  JSON-handling utilities in response.ts. Single consumer today (chat.ts);
  reusable from any tool that adopts responseSchemaJson in the future.

  Spec deferrals (per design doc):
  - persistToolEvent: only chat.ts persists to sessions. Single consumer →
    keep inline in chat.ts.
  - buildToolResponse: existing buildSuccessfulStructuredContent /
    buildStructuredResponse already cover the envelope. No new helper
    earns its place.
  EOF
  )"
  ```

---

## Phase 6 — Region headers in `tools/review.ts`, `tools/chat.ts`, `tools/research.ts`

**Prerequisite:** Phase 5 (the rewired chat.ts now uses the new helper).
**Enables:** Done.

This phase reorganises the three biggest tool files top-down with region headers in the same style as Phase 4. **No logic changes; no extracted helpers beyond what Phase 5 already produced; no new files.**

The verification gate is: tests still pass, all `registerXxxTool` exports unchanged.

### Task 6.1 — Reorganise `tools/review.ts`

**Files:**

- Modify: `src/tools/review.ts`

- [ ] **Step 1: Reorder declarations into the following sections.**

  ```ts
  // imports (already at top, no change)

  // ── Constants ────────────────────────────────────────────────────────────
  // - MAX_DIFF_CHARS, MAX_UNTRACKED_FILE_BYTES, TRUNCATED_DIFF_NOTICE
  // - EMPTY_DIFF_STATS, DIFF_HEADER_PATTERN
  // - UTF8_DECODER, UTF8_FATAL_DECODER
  // - SOURCE_FILE_EXTENSIONS, ASSET_FILE_EXTENSIONS
  // - HIGH_RISK_SEGMENTS, HIGH_RISK_BASENAMES, LOW_SIGNAL_SEGMENTS
  // - NOISY_EXACT_BASENAMES, NOISY_SUFFIXES, NOISY_EXCLUDE_PATHSPECS

  // ── Types ────────────────────────────────────────────────────────────────
  // - DiffStats, LocalDiffSnapshot, UntrackedPatchResult
  // - AnalyzePrStructuredContent, DiffUnit, BudgetedSnapshotDiff
  // - ReviewCompareWork, ReviewDiffInput, ReviewComparisonInput, ReviewFailureInput
  // - ReviewDiagnoseFailureWork, ReviewAnalyzePrWork
  // - AnalyzePrModelOutputSchema / AnalyzePrModelResponseSchema (zod + JSON schema for model)
  // - ReviewWorkDeps, GitDiffArgsOptions

  // ── Path classification ──────────────────────────────────────────────────
  // - high-risk vs low-signal heuristics for prioritising diff entries
  // - any helper that classifies a path as source/asset/sensitive

  // ── Git diff plumbing (uses injected GitReader) ──────────────────────────
  // - git diff arg builder
  // - untracked patch synthesis
  // - LocalDiffSnapshot collection

  // ── Diff budgeting & truncation ──────────────────────────────────────────
  // - DiffUnit collection
  // - BudgetedSnapshotDiff truncation policy

  // ── Sub-tool: diff review (analyzePrWork) ────────────────────────────────
  // - createAnalyzePrWork / analyzePrWork

  // ── Sub-tool: file comparison (compareFileWork) ──────────────────────────
  // - createCompareFileWork

  // ── Sub-tool: failure diagnosis (diagnoseFailureWork) ────────────────────
  // - diagnoseFailureWork

  // ── Tool registration ────────────────────────────────────────────────────
  export function registerReviewTool(...) { ... }
  ```

  Use the existing function/type names; do not rename anything. Preserve all `export` declarations.

- [ ] **Step 2: Run lint + type-check.**

  ```bash
  npm run lint && npm run type-check
  ```

  Expected: success.

- [ ] **Step 3: Run review-specific tests.**

  ```bash
  npm test -- __tests__/tools/review.test.ts
  ```

  Expected: pass.

- [ ] **Step 4: Run the full test suite.**

  ```bash
  npm test
  ```

  Expected: all green.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/tools/review.ts
  git commit -m "refactor: add region headers and reorganise tools/review.ts top-down"
  ```

### Task 6.2 — Reorganise `tools/chat.ts`

**Files:**

- Modify: `src/tools/chat.ts`

- [ ] **Step 1: Reorder declarations into the following sections.**

  ```ts
  // imports (already at top, no change)

  // ── Types ────────────────────────────────────────────────────────────────
  // - InternalAskArgs, AskArgs
  // - AskStructuredContent
  // - AskDependencies, AskExecutionResult
  // - PreparedAskRequest

  // ── Constants ────────────────────────────────────────────────────────────
  // - JSON_REPAIR_MAX_RETRIES, JSON_REPAIR_WARNING_TEXT_LIMIT

  // ── Validation ───────────────────────────────────────────────────────────
  // - validateAskConflict
  // - hasExpiredSession
  // - buildChatResolvedProfile
  // - validateAskRequest

  // ── Request building ─────────────────────────────────────────────────────
  // - buildAskPrompt
  // - any helpers that assemble Gemini PartListUnion

  // ── Streaming execution ──────────────────────────────────────────────────
  // - runWithoutSession
  // - runWithSession

  // ── Response shaping ─────────────────────────────────────────────────────
  // - isRetryableSchemaFailure
  // - buildReducedRepairPrompt
  // - appendAskWarnings
  // - buildAskStructuredContent
  // - formatStructuredResult
  // - getAskStructuredContent

  // ── Session persistence ──────────────────────────────────────────────────
  // - appendSessionStateForAsk
  // - prepareAskRequest

  // ── Tool registration ────────────────────────────────────────────────────
  export function registerChatTool(...) { ... }
  ```

  Use existing names; no renames.

- [ ] **Step 2: Run lint + type-check.**

  ```bash
  npm run lint && npm run type-check
  ```

  Expected: success.

- [ ] **Step 3: Run chat-specific tests.**

  ```bash
  npm test -- __tests__/sessions.test.ts __tests__/lib/streaming.test.ts
  ```

  Expected: pass.

- [ ] **Step 4: Run the full test suite.**

  ```bash
  npm test
  ```

  Expected: all green.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/tools/chat.ts
  git commit -m "refactor: add region headers and reorganise tools/chat.ts top-down"
  ```

### Task 6.3 — Reorganise `tools/research.ts`

**Files:**

- Modify: `src/tools/research.ts`

- [ ] **Step 1: Reorder declarations into the following sections.**

  ```ts
  // imports (already at top, no change)

  // ── Types ────────────────────────────────────────────────────────────────
  // - QuickResearchInput, DeepResearchInput, AnalyzeUrlInput

  // ── Constants ────────────────────────────────────────────────────────────
  // - MAX_DEEP_RESEARCH_TURNS

  // ── Sampling enrichment ──────────────────────────────────────────────────
  // - enrichTopicWithSampling

  // ── Quick research mode ──────────────────────────────────────────────────
  // - quickResearchWork (or its current name) and direct helpers

  // ── Deep research mode (interactions API + polling) ──────────────────────
  // - deep research interaction setup
  // - pollUntilComplete usage
  // - turn budgeting

  // ── URL analysis sub-tool ────────────────────────────────────────────────
  // - analyzeUrlWork

  // ── Response shaping ─────────────────────────────────────────────────────
  // - source-detail building specific to research
  // - finding derivation
  // - structured-content assembly

  // ── Tool registration ────────────────────────────────────────────────────
  export function registerResearchTool(...) { ... }
  ```

  Note that `analyzeUrlWork` is also imported by `tools/analyze.ts` — keep the export declaration intact during the reorder.

- [ ] **Step 2: Run lint + type-check.**

  ```bash
  npm run lint && npm run type-check
  ```

  Expected: success.

- [ ] **Step 3: Run research-specific tests.**

  ```bash
  npm test -- __tests__/lib/response.test.ts __tests__/lib/streaming.test.ts
  ```

  Expected: pass.

- [ ] **Step 4: Run the full task pipeline (final phase verification).**

  ```bash
  node scripts/tasks.mjs
  ```

  Expected: all green — format, lint, type-check, knip, test, build all pass.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/tools/research.ts
  git commit -m "refactor: add region headers and reorganise tools/research.ts top-down"
  ```

---

## Final verification

After all six phases, run a single end-to-end check to confirm the success criteria from the spec.

- [ ] **Step 1: File count went from 53 to 50.**

  ```bash
  git ls-files "src/*.ts" "src/**/*.ts" | wc -l
  ```

  Expected: 50.

- [ ] **Step 2: No file in `tools/` over 1100 lines.**

  ```bash
  wc -l src/tools/*.ts | sort -rn
  ```

  Expected: every file ≤ 1100 lines (only `chat.ts` had a chance of nudging up; helper extraction in Phase 5 should have reduced it).

- [ ] **Step 3: Knip reports no new dead code.**

  ```bash
  npm run knip
  ```

  Expected: no errors.

- [ ] **Step 4: All tests pass.**

  ```bash
  npm test
  ```

  Expected: all green.

- [ ] **Step 5: Build succeeds.**

  ```bash
  npm run build
  ```

  Expected: clean compilation, no errors.

- [ ] **Step 6: Public surface diff — confirm no MCP API change.**

  ```bash
  git diff master --stat src/public-contract.ts src/catalog.ts src/resources/discover.ts src/schemas/inputs.ts src/schemas/outputs.ts
  ```

  Expected: zero changes (these files define the public MCP surface and must not be touched).
