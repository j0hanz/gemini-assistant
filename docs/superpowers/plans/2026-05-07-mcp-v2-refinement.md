# MCP v2 Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the MCP v2 refinement design: add `completable` annotations to all tool file path schema fields, and adopt `createMcpExpressApp` for the HTTP transport.

**Architecture:** The codebase already uses native v2 SDK primitives (`NodeStreamableHTTPServerTransport`, `InMemoryTaskStore`, `server.experimental.tasks.registerToolTask`). These tasks target the remaining gaps. Task 1–3 add `completable()` wrappers to file path fields in tool input schemas (`analyze`, `review`, `ingest`), using a static `() => []` completer to mark the field as completable without requiring schema factory refactoring. Task 4 investigates and adopts `createMcpExpressApp`.

**Tech Stack:** `@modelcontextprotocol/server` (`completable`), `@modelcontextprotocol/express` (`createMcpExpressApp`), Zod v4, existing `workspacePath` helpers in `src/schemas/fields.ts`.

---

## Context: What's Already v2-Native

Before starting, note that the following are **already implemented** and require no changes:

- `NodeStreamableHTTPServerTransport` / `WebStandardStreamableHTTPServerTransport` in `src/transport.ts`
- `InMemoryTaskStore` + `ObservableTaskStore` wrapper in `src/lib/tasks.ts`
- `server.experimental.tasks.registerToolTask()` used by all long-running tools via `registerWorkTool`
- `onsessionclosed` / `onsessioninitialized` hooks in `buildBaseTransportOptions` (line ~517, logs only — cleanup is handled by `finalizeManagedPair`)
- `completable` used on `sessionId` in `createChatInputSchema` (`src/schemas/inputs.ts`) and on enum fields in `src/prompts.ts`

---

## Task 1: Add `completable` to `filePath` in Analyze input schema

**Files:**

- Modify: `src/schemas/inputs.ts`
- Test: `__tests__/schemas/inputs.test.ts`

- [ ] **Step 1.1: Verify `completable` import is present in `src/schemas/inputs.ts`**

  Open `src/schemas/inputs.ts`. Confirm line 1 is:

  ```ts
  import { completable } from '@modelcontextprotocol/server';
  ```

  It already exists — no import change needed.

- [ ] **Step 1.2: Write a failing test**

  Add to `__tests__/schemas/inputs.test.ts`:

  ```ts
  test('AnalyzeInputSchema — filePath still parses after completable wrapping', () => {
    // This test verifies that adding completable to filePath does not break validation.
    const result = AnalyzeInputSchema.safeParse({
      targetKind: 'file',
      goal: 'Summarize the module',
      filePath: '/workspace/src/index.ts',
    });
    assert.ok(result.success, 'Expected success but got: ' + JSON.stringify(result));
    assert.equal(result.data?.filePath, '/workspace/src/index.ts');
  });
  ```

  Run:

  ```
  node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
  ```

  Expected: The test already passes (parse works) — this is your baseline before the schema edit.

- [ ] **Step 1.3: Wrap `filePath` in `AnalyzeInputBaseSchema` with `completable`**

  In `src/schemas/inputs.ts`, locate the line inside `const AnalyzeInputBaseSchema = z.strictObject({...})` that reads:

  ```ts
  filePath: optionalField(workspacePath('File path to analyze.')),
  ```

  Replace it with:

  ```ts
  filePath: optionalField(
    completable(workspacePath('File path to analyze.'), () => []),
  ),
  ```

- [ ] **Step 1.4: Wrap `filePath` in `AnalyzeFileSchema` with `completable`**

  In `src/schemas/inputs.ts`, locate the line inside `const AnalyzeFileSchema = z.strictObject({...})` that reads:

  ```ts
  filePath: workspacePath('Workspace-relative or absolute path to analyze when targetKind=file'),
  ```

  Replace it with:

  ```ts
  filePath: completable(
    workspacePath('Workspace-relative or absolute path to analyze when targetKind=file'),
    () => [],
  ),
  ```

- [ ] **Step 1.5: Wrap `filePaths` array items in the multi-file variant**

  In `src/schemas/inputs.ts`, locate the `AnalyzeInputBaseSchema` definition and find the `filePaths` field using `workspacePathArray(...)`. The `workspacePathArray` helper creates an array schema — `completable` applies to the overall array field, not individual items. Wrap it:

  ```ts
  filePaths: completable(
    workspacePathArray({
      description: 'Local files to analyze.',
      itemDescription: 'Workspace-relative or absolute path to a local file',
      min: 2,
      max: 5,
      optional: true,
    }),
    () => [],
  ),
  ```

- [ ] **Step 1.6: Run tests to verify no regressions**

  Run:

  ```
  node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
  ```

  Expected: All tests pass including the new baseline test added in Step 1.2.

- [ ] **Step 1.7: Commit**

  ```bash
  git add src/schemas/inputs.ts __tests__/schemas/inputs.test.ts
  git commit -m "feat(schemas): add completable to analyze filePath and filePaths fields"
  ```

---

## Task 2: Add `completable` to `filePathA` and `filePathB` in Review input schema

**Files:**

- Modify: `src/schemas/inputs.ts`
- Test: `__tests__/schemas/inputs.test.ts`

- [ ] **Step 2.1: Write a failing test**

  Add to `__tests__/schemas/inputs.test.ts`:

  ```ts
  test('ReviewInputSchema — filePathA / filePathB still parse after completable wrapping', () => {
    const result = ReviewInputSchema.safeParse({
      subjectKind: 'comparison',
      filePathA: '/workspace/src/old.ts',
      filePathB: '/workspace/src/new.ts',
    });
    assert.ok(result.success, 'Expected success but got: ' + JSON.stringify(result));
    assert.equal(result.data?.filePathA, '/workspace/src/old.ts');
    assert.equal(result.data?.filePathB, '/workspace/src/new.ts');
  });
  ```

  Run:

  ```
  node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
  ```

  Expected: Test passes (baseline).

- [ ] **Step 2.2: Wrap `filePathA` in `ReviewComparisonSchema` with `completable`**

  In `src/schemas/inputs.ts`, locate `const ReviewComparisonSchema = z.strictObject({...})`. Find:

  ```ts
  filePathA: workspacePath('First file to compare.'),
  ```

  Replace with:

  ```ts
  filePathA: completable(workspacePath('First file to compare.'), () => []),
  ```

- [ ] **Step 2.3: Wrap `filePathB` in `ReviewComparisonSchema` with `completable`**

  In the same `ReviewComparisonSchema`, find:

  ```ts
  filePathB: workspacePath('Second file to compare.'),
  ```

  Replace with:

  ```ts
  filePathB: completable(workspacePath('Second file to compare.'), () => []),
  ```

- [ ] **Step 2.4: Run tests**

  Run:

  ```
  node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
  ```

  Expected: All tests pass.

- [ ] **Step 2.5: Commit**

  ```bash
  git add src/schemas/inputs.ts __tests__/schemas/inputs.test.ts
  git commit -m "feat(schemas): add completable to review filePathA and filePathB fields"
  ```

---

## Task 3: Add `completable` to `filePath` in Ingest input schema

**Files:**

- Modify: `src/schemas/ingest.ts`
- Test: `__tests__/schemas/ingest-input.test.ts`

- [ ] **Step 3.1: Write a failing test**

  Add to `__tests__/schemas/ingest-input.test.ts` (or create it if absent):

  ```ts
  import assert from 'node:assert/strict';

  import { describe, test } from 'node:test';

  import { IngestInputSchema } from '../../src/schemas/ingest.js';

  test('IngestInputSchema — filePath still parses after completable wrapping', () => {
    const result = IngestInputSchema.safeParse({
      operation: 'upload',
      storeName: 'my-store',
      filePath: 'src',
    });
    assert.ok(result.success, 'Expected success but got: ' + JSON.stringify(result));
    assert.equal(result.data?.filePath, 'src');
  });
  ```

  Run:

  ```
  node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/ingest-input.test.ts
  ```

  Expected: Test passes (baseline).

- [ ] **Step 3.2: Add `completable` import to `src/schemas/ingest.ts`**

  Open `src/schemas/ingest.ts`. Add `completable` to the import from `@modelcontextprotocol/server`:

  ```ts
  import { completable } from '@modelcontextprotocol/server';
  ```

  Place this import at the top of the file, before the `zod/v4` import.

- [ ] **Step 3.3: Wrap `filePath` in `RawIngestInputSchema` with `completable`**

  In `src/schemas/ingest.ts`, locate the `RawIngestInputSchema` definition. Find the `filePath` field:

  ```ts
  filePath: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .describe(
      "Path to a file or directory (required for 'upload'). Absolute or workspace-relative (e.g. 'src').",
    ),
  ```

  Replace with:

  ```ts
  filePath: completable(
    z
      .string()
      .trim()
      .max(4096)
      .optional()
      .describe(
        "Path to a file or directory (required for 'upload'). Absolute or workspace-relative (e.g. 'src').",
      ),
    () => [],
  ),
  ```

- [ ] **Step 3.4: Run tests**

  Run:

  ```
  node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/ingest-input.test.ts
  ```

  Expected: All tests pass.

- [ ] **Step 3.5: Run full type-check**

  Run:

  ```
  npm run type-check
  ```

  Expected: No type errors.

- [ ] **Step 3.6: Commit**

  ```bash
  git add src/schemas/ingest.ts __tests__/schemas/ingest-input.test.ts
  git commit -m "feat(schemas): add completable to ingest filePath field"
  ```

---

## Task 4: Investigate and adopt `createMcpExpressApp`

**Context:**
The current `startHttpTransport` in `src/transport.ts` deliberately uses a bare `express()` app (not `createMcpExpressApp`) due to a CORS ordering concern documented in the code comment around line 914:

> "Build the express app directly so applyCors runs before any host-validation middleware. CORS headers must be present on 403 responses so browsers surface the real status. The SDK's createMcpExpressApp auto-installs localhost-rebinding protection ahead of any user middleware, which would strip CORS from those 403s."

`createMcpExpressApp` from `@modelcontextprotocol/express` handles host validation and DNS rebinding protection natively. Adopting it would remove ~40 lines of custom middleware from the transport.

**Files:**

- Modify: `src/transport.ts`
- Test: `__tests__/server.test.ts` (if HTTP transport tests exist)

- [ ] **Step 4.1: Inspect `createMcpExpressApp` source for pre-validation hooks**

  Run:

  ```
  node -e "import('@modelcontextprotocol/express').then(m => console.log(Object.keys(m)))"
  ```

  Then inspect its source to understand if it supports registering custom middleware BEFORE its internal host validation.

  Check the package source:

  ```
  Get-Content node_modules\@modelcontextprotocol\express\dist\index.js | Select-String "hostValidation|validation|cors|before"
  ```

- [ ] **Step 4.2: Determine feasibility**

  After inspection, choose one of:

  **Option A — Feasible (SDK supports pre-validation middleware order):**
  If `createMcpExpressApp` exposes a way to register middleware before its host validation (e.g., returns an Express app before mounting the host guard), proceed to Step 4.3.

  **Option B — Not feasible (CORS concern confirmed):**
  If the SDK installs host validation before any user middleware, update the comment in `src/transport.ts` around line 914 to explicitly state:

  ```ts
  // NOTE: createMcpExpressApp from @modelcontextprotocol/express is intentionally not used.
  // It installs DNS-rebinding protection before any user middleware, which strips CORS headers
  // from 403 responses. Browsers need CORS headers on 403s to surface the correct status.
  // Tracked as: https://github.com/modelcontextprotocol/typescript-sdk/issues/<N>
  // When the SDK supports pre-validation CORS hooks, this can be simplified.
  ```

  Commit the clarified comment and end this task:

  ```bash
  git add src/transport.ts
  git commit -m "docs(transport): clarify why createMcpExpressApp is not used (CORS ordering)"
  ```

- [ ] **Step 4.3: (Only if Option A) Replace bare express() with `createMcpExpressApp`**

  In `src/transport.ts`, add the import:

  ```ts
  import { createMcpExpressApp } from '@modelcontextprotocol/express';
  ```

  In `startHttpTransport`, replace the manual CORS + host validation middleware block:

  ```ts
  // Current: bare express() + custom applyCors + custom validateHostHeader middleware
  const app = express();
  applyCors(app, corsOrigin);
  if (allowedHosts) {
    app.use((req, res, next) => { ... validateHostHeader ... });
  }
  ```

  With:

  ```ts
  const app = createMcpExpressApp({
    host,
    allowedHosts: allowedHosts ?? [host],
    cors: corsOrigin ? { origin: corsOrigin, ... } : undefined,
  });
  ```

  Keep rate limiting, auth, and session management middleware unchanged (they live after host validation in the Express chain).

- [ ] **Step 4.4: (Only if Option A) Run full test suite**

  ```
  node scripts/tasks.mjs
  ```

  Expected: format → lint → type-check → tests all pass.

- [ ] **Step 4.5: (Only if Option A) Commit**

  ```bash
  git add src/transport.ts
  git commit -m "refactor(transport): adopt createMcpExpressApp for host validation and DNS rebinding"
  ```

---

## Final Verification

After all tasks are complete:

- [ ] **Run the full task orchestrator**

  ```
  node scripts/tasks.mjs
  ```

  Expected: format → [lint, type-check, knip] → [test, rebuild] all pass.

- [ ] **Manual smoke test via MCP inspector**

  ```
  npm run inspector
  ```

  Verify that `analyze`, `review`, and `ingest` tools show file path fields as completable in the inspector UI. Submit a `completions/complete` request for `analyze`'s `filePath` field and confirm the server returns an empty array (not an error).

- [ ] **Commit any remaining changes**

  ```bash
  git add -A
  git commit -m "chore: mcp v2 refinement complete"
  ```
