---
goal: Harden tool execution, diff cancellation, memory dispatch, and response schema parsing
version: 1.0
date_created: 2026-04-21
last_updated: 2026-04-21
owner: gemini-assistant maintainers
status: 'Completed'
tags: [bug, refactor, security, contract]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan addresses four discrete defects surfaced in the April 2026 code review of [src/lib/tool-executor.ts](src/lib/tool-executor.ts), [src/tools/review.ts](src/tools/review.ts), [src/tools/memory.ts](src/tools/memory.ts), [src/tools/chat.ts](src/tools/chat.ts), and [src/schemas/inputs.ts](src/schemas/inputs.ts): (1) `ToolExecutor.executeWithTracing` flattens `ProtocolError` into tool-result errors, breaking the JSON-RPC contract boundary; (2) the untracked-file branch of `buildLocalDiffSnapshot` ignores `AbortSignal` and follows symlinks via `stat()`; (3) `memoryWork()` fails open to `workspace.cache` for unrecognized actions; (4) `responseSchemaJson` is JSON-parsed twice (once validated, once re-cast), creating a drift point between schema and runtime.

## 1. Requirements & Constraints

- **REQ-001**: `ToolExecutor.executeWithTracing` MUST rethrow `ProtocolError` instances unchanged so the MCP SDK can emit JSON-RPC error responses.
- **REQ-002**: `buildLocalDiffSnapshot` MUST honor the caller-supplied `AbortSignal` throughout the untracked-file collection loop.
- **REQ-003**: `buildUntrackedPatch` MUST NOT follow symbolic links when probing filesystem entries; replace `stat()` with `lstat()`.
- **REQ-004**: `readFile()` calls in the untracked-file path MUST accept the `AbortSignal` via the options bag.
- **REQ-005**: `memoryWork()` MUST return an `AppError` tool result for any `MemoryInput['action']` that is not explicitly matched by the dispatch chain.
- **REQ-006**: `responseSchemaJson` MUST be parsed exactly once through a shared helper that returns a validated `GeminiResponseSchema` value.
- **SEC-001**: Protocol errors raised by validation, roots, or sampling wiring MUST NOT appear to callers as successful tool invocations with `isError: true`; they MUST surface as JSON-RPC `-32xxx` responses.
- **SEC-002**: Untracked diff collection MUST NOT follow symlinks out of the git root (prevents TOCTOU/symlink pivots during review).
- **CON-001**: Public `CallToolResult` shapes for non-protocol errors MUST remain unchanged.
- **CON-002**: Zod input/output schemas and their exported types MUST remain source-compatible with existing callers.
- **CON-003**: No new runtime dependencies.
- **GUD-001**: Use `AppError` for fail-closed tool results (matches [src/tools/memory.ts](src/tools/memory.ts) convention).
- **GUD-002**: Use `signal?.throwIfAborted()` at loop boundaries to keep cancellation semantics aligned with the existing git subprocess path in [src/tools/review.ts](src/tools/review.ts).
- **PAT-001**: Reuse the `ProtocolError` import already present in [src/resources.ts](src/resources.ts) when extending [src/lib/tool-executor.ts](src/lib/tool-executor.ts).
- **PAT-002**: Prefer `parsePayload.issues.push({ code: 'custom', ... })` with a single try/catch around the shared parser when wiring `parseResponseSchemaJsonValue` into `validateResponseSchemaJson`.

## 2. Implementation Steps

### Implementation Phase 1 — Protocol error passthrough in `ToolExecutor`

- GOAL-001: Ensure `ProtocolError` bubbles out of `executeWithTracing` untouched while preserving existing `AppError.toToolResult()` behavior for all other throws.

| Task     | Description                                                                                                                                                                                                                                              | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), change the type-only import of `@modelcontextprotocol/server` to add a value import of `ProtocolError` alongside the existing `CallToolResult` and `ServerContext` type imports.                | Yes       | 2026-04-21 |
| TASK-002 | At the top of the `catch (err)` block inside `executeWithTracing` (currently at [src/lib/tool-executor.ts](src/lib/tool-executor.ts#L67)), add `if (err instanceof ProtocolError) { throw err; }` before any logging, progress, or `AppError.from` call. | Yes       | 2026-04-21 |
| TASK-003 | Add a unit test in `__tests__/lib/` that instantiates `ToolExecutor`, has `work()` throw `new ProtocolError(INVALID_PARAMS, 'bad')`, and asserts the error propagates (does not resolve to a `CallToolResult`).                                          | Yes       | 2026-04-21 |
| TASK-004 | Add a unit test asserting that a plain `Error` still resolves to `{ isError: true, content: [...] }` via `AppError.from`.                                                                                                                                | Yes       | 2026-04-21 |

### Implementation Phase 2 — Review cancellation & symlink hardening

- GOAL-002: Propagate `AbortSignal` through `collectUntrackedResults` / `buildUntrackedPatch` and replace `stat()` with `lstat()` so cancellation and symlink safety match the git subprocess path.

| Task     | Description                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-005 | In [src/tools/review.ts](src/tools/review.ts), change `import { readFile, stat } from 'node:fs/promises';` to `import { lstat, readFile } from 'node:fs/promises';`.                                                                                   | Yes       | 2026-04-21 |
| TASK-006 | Extend `collectUntrackedResults(gitRoot, untrackedPaths)` to accept an optional `signal?: AbortSignal` parameter. Call `signal?.throwIfAborted()` at the top of each loop iteration before invoking `buildUntrackedPatch`.                             | Yes       | 2026-04-21 |
| TASK-007 | Extend `buildUntrackedPatch(gitRoot, relativePath)` to accept an optional `signal?: AbortSignal` parameter. Call `signal?.throwIfAborted()` at function entry.                                                                                         | Yes       | 2026-04-21 |
| TASK-008 | Replace `await stat(absolutePath).catch(() => null)` with `await lstat(absolutePath).catch(() => null)` in `buildUntrackedPatch`. Retain the existing `fileStats?.isFile()` check (lstat returns `false` on symlinks, correctly skipping them).        | Yes       | 2026-04-21 |
| TASK-009 | Replace `await readFile(absolutePath)` with `await readFile(absolutePath, { signal })` inside `buildUntrackedPatch`.                                                                                                                                   | Yes       | 2026-04-21 |
| TASK-010 | In `buildLocalDiffSnapshot` (near [src/tools/review.ts](src/tools/review.ts#L899)), pass the existing `signal` argument to `collectUntrackedResults(gitRoot, untrackedPaths, signal)`.                                                                 | Yes       | 2026-04-21 |
| TASK-011 | Add a test in [**tests**/tools/](__tests__/tools/) (new file `review.test.ts` or extend an existing review test) that aborts the signal mid-collection and asserts `buildLocalDiffSnapshot` rejects with an `AbortError`/`DOMException('AbortError')`. | Yes       | 2026-04-21 |
| TASK-012 | Add a test that creates a symlink inside a temp git root pointing at a regular file and asserts the symlink is skipped (returned with no `patch` and no `skipReason`, same shape as non-file entries).                                                 | Yes       | 2026-04-21 |

### Implementation Phase 3 — Fail-closed memory dispatch

- GOAL-003: Reject unknown memory actions with an `AppError` tool result instead of silently routing to `workspace.cache`.

| Task     | Description                                                                                                                                                                                                                                                                                                   | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-013 | In [src/tools/memory.ts](src/tools/memory.ts) `memoryWork()` (around [src/tools/memory.ts](src/tools/memory.ts#L735)), replace the terminal `} else {` branch with `} else if (isMemoryAction(args, 'workspace.cache')) {` to preserve existing behavior for the documented cache action.                     | Yes       | 2026-04-21 |
| TASK-014 | Append a new terminal `else` branch that returns `new AppError('memory', \`memory: Unsupported action '${String(args.action)}'.\`).toToolResult();`. Ensure`AppError`is already imported (it is, via`../lib/errors.js`).                                                                                      | Yes       | 2026-04-21 |
| TASK-015 | Add a test in [**tests**/tools/](__tests__/tools/) (extend existing memory tests, or create if absent) that bypasses Zod by calling `memoryWork` directly with `{ action: 'unknown.action' }` cast as `MemoryInput` and asserts the result has `isError: true` and content containing `'Unsupported action'`. | Yes       | 2026-04-21 |

### Implementation Phase 4 — Single-source `responseSchemaJson` parser

- GOAL-004: Share one `JSON.parse` + Zod validation path between input validation and chat execution.

| Task     | Description                                                                                                                                                                                                                                                                                                                               | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-016 | In [src/schemas/inputs.ts](src/schemas/inputs.ts), add and export `function parseResponseSchemaJsonValue(raw: string): GeminiResponseSchema { const parsed = JSON.parse(raw) as unknown; return GeminiResponseSchema.parse(parsed); }` directly above `validateResponseSchemaJson`.                                                       | Yes       | 2026-04-21 |
| TASK-017 | Rewrite `validateResponseSchemaJson` to call `parseResponseSchemaJsonValue(payload.value)` inside a single `try`/`catch`. On catch, push a `custom` issue whose message is `error instanceof z.ZodError ? \`responseSchemaJson must match the supported schema.\n${z.prettifyError(error)}\` : 'responseSchemaJson must be valid JSON.'`. | Yes       | 2026-04-21 |
| TASK-018 | In [src/tools/chat.ts](src/tools/chat.ts), remove the local `parseResponseSchemaJson(responseSchemaJson)` helper (around [src/tools/chat.ts](src/tools/chat.ts#L85)).                                                                                                                                                                     | Yes       | 2026-04-21 |
| TASK-019 | Update the `responseSchema:` assignment near [src/tools/chat.ts](src/tools/chat.ts#L864) to `args.responseSchemaJson !== undefined ? parseResponseSchemaJsonValue(args.responseSchemaJson) : undefined`. Import `parseResponseSchemaJsonValue` from `../schemas/inputs.js`.                                                               | Yes       | 2026-04-21 |
| TASK-020 | Extend [**tests**/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) with a case asserting `parseResponseSchemaJsonValue` throws `ZodError` for a JSON payload that parses but violates `GeminiResponseSchema` (e.g. `{"type":"unknown"}`).                                                                                        | Yes       | 2026-04-21 |
| TASK-021 | Extend [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts) (or appropriate chat test) to assert that providing a well-formed `responseSchemaJson` produces a single parse (e.g. spy on `GeminiResponseSchema.parse` or assert equivalent behavior via structural output).                                                          | Yes       | 2026-04-21 |

### Implementation Phase 5 — Verification gate

- GOAL-005: Run the repository's mandatory quality gates before marking the plan complete.

| Task     | Description                                                                               | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-022 | Run `npm run format`.                                                                     | Yes       | 2026-04-21 |
| TASK-023 | Run `npm run lint` and ensure zero new warnings or errors.                                | Yes       | 2026-04-21 |
| TASK-024 | Run `npm run type-check` and ensure no new diagnostics.                                   | Yes       | 2026-04-21 |
| TASK-025 | Run `npm run test` and confirm all suites (including new tests added in Phases 1–4) pass. | Yes       | 2026-04-21 |

## 3. Alternatives

- **ALT-001**: Narrow the `ToolExecutor` catch to only known error subtypes instead of rethrowing `ProtocolError`. Rejected: broader refactor, greater risk, and leaves the specific protocol-boundary bug unresolved longer.
- **ALT-002**: Replace `MemoryInputSchema` with a `z.discriminatedUnion('action', ...)` in this plan to eliminate the dispatch guard chain entirely. Rejected here: tracked separately as a larger refactor ([docs/plan/refactor-zod-schemas-1.md](docs/plan/refactor-zod-schemas-1.md)) to keep this plan scoped to safety fixes.
- **ALT-003**: Stop accepting `responseSchemaJson` as a string and require callers to send a structured object. Rejected: breaks public input contract (CON-002).
- **ALT-004**: Walk the untracked-file set with `fs.opendir({ signal })` for native cancellation. Rejected: adds complexity for negligible gain; `throwIfAborted()` at loop boundaries is sufficient and matches existing patterns.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` must export `ProtocolError` as a runtime value (confirmed — already imported in [src/resources.ts](src/resources.ts) and [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts)).
- **DEP-002**: `node:fs/promises` `readFile` must accept `{ signal }` (Node.js `>=24`, matches `package.json` engines).
- **DEP-003**: `zod/v4` `z.prettifyError` and `ZodError` (already in use in [src/schemas/inputs.ts](src/schemas/inputs.ts)).

## 5. Files

- **FILE-001**: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — add `ProtocolError` import and early rethrow in `executeWithTracing`.
- **FILE-002**: [src/tools/review.ts](src/tools/review.ts) — signal plumbing, `stat → lstat`, `readFile` signal option.
- **FILE-003**: [src/tools/memory.ts](src/tools/memory.ts) — tighten `memoryWork` dispatch to fail closed.
- **FILE-004**: [src/schemas/inputs.ts](src/schemas/inputs.ts) — add/export `parseResponseSchemaJsonValue`; refactor `validateResponseSchemaJson` to reuse it.
- **FILE-005**: [src/tools/chat.ts](src/tools/chat.ts) — remove local `parseResponseSchemaJson`; import and use the shared helper.
- **FILE-006**: [**tests**/lib/tool-executor.test.ts](__tests__/lib/tool-executor.test.ts) (new or extended) — protocol-error passthrough tests.
- **FILE-007**: [**tests**/tools/review.test.ts](__tests__/tools/review.test.ts) (new or extended) — abort + symlink tests.
- **FILE-008**: [**tests**/tools/memory.test.ts](__tests__/tools/memory.test.ts) (new or extended) — unknown-action fail-closed test.
- **FILE-009**: [**tests**/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) — shared-parser coverage.
- **FILE-010**: [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts) — chat execution coverage for shared parser.

## 6. Testing

- **TEST-001**: `ProtocolError` thrown inside a `ToolExecutor.run` `work()` rejects the promise; a plain `Error` still resolves to `{ isError: true }`.
- **TEST-002**: `buildLocalDiffSnapshot` rejects with `AbortError` when the signal is aborted during untracked-file iteration.
- **TEST-003**: `buildUntrackedPatch` returns `{ path }` (no `patch`, no `skipReason`) for a symlink target.
- **TEST-004**: `memoryWork` with `{ action: 'unknown.action' }` returns `{ isError: true, content: [{ text: /Unsupported action/ }] }`.
- **TEST-005**: `parseResponseSchemaJsonValue` throws `ZodError` for schema-valid JSON that violates `GeminiResponseSchema`.
- **TEST-006**: `validateResponseSchemaJson` emits one `custom` issue with the prettified Zod error message for schema violations and a plain message for JSON syntax errors.
- **TEST-007**: Chat tool execution with a valid `responseSchemaJson` succeeds and sets `responseSchema` on the generate-content config (behavioral check via existing test harness).

## 7. Risks & Assumptions

- **RISK-001**: Rethrowing `ProtocolError` from `ToolExecutor` could surface previously-masked protocol faults to clients. Mitigation: intended behavior; callers that depended on flattened protocol errors were already broken per MCP guidance.
- **RISK-002**: `lstat` returning `false` for `isFile()` on symlinks may change how symlinked files are reported. Mitigation: existing code already returns `{ path }` for non-files; documented as a deliberate SEC-002 tightening.
- **RISK-003**: `readFile(..., { signal })` rejects with `AbortError` mid-collection. Mitigation: callers already propagate `AbortError` through `ctx.mcpReq.signal`; existing git path uses the same pattern.
- **ASSUMPTION-001**: No current caller relies on `memoryWork` routing unknown actions to `workspace.cache`; Zod validation rejects such inputs at the MCP boundary.
- **ASSUMPTION-002**: `GeminiResponseSchema.parse` performance cost is negligible per-call; running it once in `chat.ts` instead of a bare `JSON.parse` adds a microsecond-scale validation pass.

## 8. Related Specifications / Further Reading

- [.github/plan.md](.github/plan.md) — upstream review that enumerated these findings.
- [docs/plan/refactor-zod-schemas-1.md](docs/plan/refactor-zod-schemas-1.md) — separate discriminated-union refactor for `memory`/`review`/`analyze` inputs.
- [docs/plan/refactor-task-error-surface-1.md](docs/plan/refactor-task-error-surface-1.md) — related task/error contract work.
- [AGENTS.md](AGENTS.md) — repository safety boundaries and change checklist.
