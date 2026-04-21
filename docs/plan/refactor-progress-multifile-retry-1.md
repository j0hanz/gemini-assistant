---
goal: Normalize multi-file analyze progress and make retry progress awaitable
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['refactor', 'progress', 'reliability']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan addresses two scoped progress-lifecycle gaps surfaced in `.github/report.md` (items D and E) that survived the `reportTerminalProgress` consolidation. Item D: `analyzeMultiFileWork` emits no pre-stream progress during file uploads, unlike the single-file and diagram paths. Item E: `withRetry`'s `onRetry` hook is typed synchronous and callers fire-and-forget `void sendProgress(...)`, creating a latent ordering race where retry notices can arrive after subsequent progress events.

Both changes are low-risk, additive, and preserve the current terminal-progress ownership model (outer `executor.run` with `reportTerminalProgress: false`; inner `executor.runStream` owns the terminal event).

## 1. Requirements & Constraints

- **REQ-001**: `analyzeMultiFileWork` MUST emit a `ProgressReporter.step(i, n, 'Uploading <filename>')` event for each file before upload starts, matching the cadence used in `analyzeFileWork` and `analyzeDiagramWork`.
- **REQ-002**: `analyzeMultiFileWork` MUST emit a final pre-stream step `(n, n+1, 'Analyzing content')` immediately before `executor.runStream` begins consuming the Gemini stream.
- **REQ-003**: `withRetry`'s `onRetry` callback signature MUST accept `(attempt, maxRetries, delayMs) => void | Promise<void>` and MUST be awaited inside the retry loop.
- **REQ-004**: All existing `onRetry` call sites in `src/lib/streaming.ts` and `src/tools/memory.ts` MUST drop the `void` prefix and await `sendProgress` / `progress.send`.
- **CON-001**: No change to the terminal-progress ownership model. `registerTaskTool` MUST continue to pass `{ reportTerminalProgress: false }` and inner `runStream` MUST remain the terminal owner for streaming tools.
- **CON-002**: Multi-file uploads MUST remain sequential (current behavior) so progress indexing stays deterministic. Parallelization is explicitly out of scope.
- **CON-003**: No public API, schema, or tool-output shape may change. The refactor must be internally observable only.
- **CON-004**: `deleteUploadedFiles` cleanup in the `finally` block MUST still run for every file whose `uploadedNames.push` executed, including partial failures.
- **GUD-001**: Follow the `ProgressReporter` pattern already used by `analyzeFileWork` (filename derived via `filePath.split(/[\\/]/).pop() ?? filePath`).
- **GUD-002**: Awaiting `onRetry` must not mask retry timing — the backoff delay runs after the hook resolves, as in the existing flow.
- **PAT-001**: Use `totalSteps = filePaths.length + 1` so the last pre-stream step is `(filePaths.length, totalSteps, 'Analyzing content')`.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Add per-file pre-stream progress to `analyzeMultiFileWork`.

| Task     | Description                                                                                                                                                                                                                                                                                   | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/tools/analyze.ts`, inside `analyzeMultiFileWork` (around line 195), construct `const progress = new ProgressReporter(ctx, ANALYZE_TOOL_LABEL);` and `const totalSteps = filePaths.length + 1;` before the `try` block.                                                                | ✅        | 2026-04-22 |
| TASK-002 | Hoist the upload loop out of the `executor.runStream` `streamGenerator` callback. Iterate `filePaths` with `entries()`; for each `[index, filePath]`, call `await progress.step(index, totalSteps, \`Uploading ${filePath.split(/[\\/]/).pop() ?? filePath}\`)`before`await uploadFile(...)`. | ✅        | 2026-04-22 |
| TASK-003 | Collect the built `contents` array (text + `createPartFromUri(...)` parts) outside the stream generator so the generator only constructs the prompt and issues `generateContentStream`.                                                                                                       | ✅        | 2026-04-22 |
| TASK-004 | Emit `await progress.step(filePaths.length, totalSteps, 'Analyzing content');` immediately before `return await executor.runStream(...)`.                                                                                                                                                     | ✅        | 2026-04-22 |
| TASK-005 | Confirm the existing `finally { await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx)); }` block is unchanged and still observes `uploadedNames` populated inside the hoisted loop.                                                                                                | ✅        | 2026-04-22 |
| TASK-006 | Run `npm run lint` and `npm run type-check`; fix any issues (e.g., unused imports).                                                                                                                                                                                                           | ✅        | 2026-04-22 |

### Implementation Phase 2

- GOAL-002: Make `withRetry` `onRetry` awaitable and fix all call sites.

| Task     | Description                                                                                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-007 | In `src/lib/errors.ts` around line 220, change the `onRetry` type to `onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void \| Promise<void>;`.                                                                                                                                                                                      | ✅        | 2026-04-22 |
| TASK-008 | In the same function (line ~233), change `options?.onRetry?.(attempt + 1, maxRetries, Math.round(delay));` to `await options?.onRetry?.(attempt + 1, maxRetries, Math.round(delay));`.                                                                                                                                                                  | ✅        | 2026-04-22 |
| TASK-009 | In `src/lib/streaming.ts` inside `executeToolStream` (line ~686), change the `onRetry` body from `void sendProgress(...)` to `await sendProgress(...)`. The callback becomes `async (attempt, max, delayMs) => { await sendProgress(ctx, 0, undefined, \`${toolLabel}: Retrying (${attempt}/${max}, ~${Math.round(delayMs / 1000)}s)\`); }`.            | ✅        | 2026-04-22 |
| TASK-010 | In `src/tools/memory.ts` inside `createCacheWithRetry` (line ~220), change the `onRetry` body from `void progress.send(...)` to `await progress.send(...)`. Callback becomes `async (attempt, max, delayMs) => { await progress.send(totalSteps - 1, totalSteps, \`Retrying cache creation (${attempt}/${max}, ~${Math.round(delayMs / 1000)}s)\`); }`. | ✅        | 2026-04-22 |
| TASK-011 | `grep` `src/` for any other `onRetry` usages; if found, apply the same `await` treatment.                                                                                                                                                                                                                                                               | ✅        | 2026-04-22 |
| TASK-012 | Run `npm run lint`, `npm run type-check`, and `npm run test`; address any regressions.                                                                                                                                                                                                                                                                  | ✅        | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Parallelize multi-file uploads with `Promise.all` and report completion-ordered progress. Rejected: non-deterministic ordering complicates tests and UX (matches the `memory.ts` critique in the source report).
- **ALT-002**: Keep `onRetry` synchronous and use an internal micro-queue inside `sendProgress` to serialize. Rejected: adds hidden state to a shared module to work around a caller bug; awaiting the hook is simpler and local.
- **ALT-003**: Emit only a single "Uploading N files" progress line before the batch. Rejected: fails GUD-001 (inconsistent with `analyzeFileWork`) and provides no visibility for slow individual uploads.

## 4. Dependencies

- **DEP-001**: No new runtime dependencies.
- **DEP-002**: Existing `ProgressReporter` API in `src/lib/progress.ts` (unchanged).
- **DEP-003**: Existing `executor.runStream` contract in `src/lib/tool-executor.ts` (unchanged).

## 5. Files

- **FILE-001**: `src/tools/analyze.ts` — refactor `analyzeMultiFileWork` (Phase 1).
- **FILE-002**: `src/lib/errors.ts` — widen `onRetry` signature and await it (Phase 2, TASK-007/008).
- **FILE-003**: `src/lib/streaming.ts` — await `sendProgress` in retry callback (Phase 2, TASK-009).
- **FILE-004**: `src/tools/memory.ts` — await `progress.send` in retry callback (Phase 2, TASK-010).
- **FILE-005**: `__tests__/tools/analyze*.test.ts` and `__tests__/lib/streaming.test.ts` — may need new assertions (see §6).

## 6. Testing

- **TEST-001**: Extend or add an `analyze` multi-file test that captures progress notifications via the mock MCP transport and asserts the sequence `Uploading <file1>`, `Uploading <file2>`, …, `Analyzing content`, `Analyze: completed` in order. Matches existing patterns in `__tests__/tools/analyze-diagram-progress.test.ts`.
- **TEST-002**: In `__tests__/lib/streaming.test.ts` (or a new retry-specific test), mock a retryable failure and assert that the retry progress message is observed **before** any subsequent success progress event. Use an `async` `onRetry` that resolves on a queued microtask to prove the `await` is honored.
- **TEST-003**: Add a unit test for `withRetry` in `__tests__/lib/errors.test.ts` that supplies an `async` `onRetry` returning a delayed promise and asserts the delay elapses before the next `fn()` attempt.
- **TEST-004**: Run full `npm run test` suite; all existing contract, e2e, and tool tests must remain green.

## 7. Risks & Assumptions

- **RISK-001**: Awaiting `onRetry` extends total retry wall-time by the callback's latency. Mitigation: callbacks only call `sendProgress`, which is throttled and returns quickly; worst-case adds single-digit milliseconds.
- **RISK-002**: Hoisting uploads out of the stream generator changes the exception call-site for `uploadFile` failures. The existing `executor.run` outer wrapper (via `registerTaskTool`'s `wrapTaskSafeWork`) still converts thrown errors into `AppError` results, so user-visible error shape is preserved. Verify with TEST-004.
- **RISK-003**: If a future caller passes a long-running `onRetry`, the retry loop could appear to stall. Accepted: current callers are constrained to progress emission.
- **ASSUMPTION-001**: Multi-file inputs are bounded (user-supplied file list), so sequential uploads remain acceptable.
- **ASSUMPTION-002**: `ProgressReporter` throttling in `sendProgress` will coalesce rapid per-file steps if uploads are sub-250 ms; this is the existing behavior and acceptable.

## 8. Related Specifications / Further Reading

- `.github/report.md` — original review (items D and E).
- [src/lib/progress.ts](../../src/lib/progress.ts) — `ProgressReporter`, `sendProgress`, throttling.
- [src/lib/tool-executor.ts](../../src/lib/tool-executor.ts) — `reportTerminalProgress` flag and terminal ownership.
- [src/lib/task-utils.ts](../../src/lib/task-utils.ts) — `registerTaskTool` passing `{ reportTerminalProgress: false }`.
- `docs/plan/refactor-progress-task-status-1.md` — prior progress-lifecycle refactor that introduced the current ownership model.
