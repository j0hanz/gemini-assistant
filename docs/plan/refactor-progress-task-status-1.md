# Refactor progress + task status pipeline to fix bridging and duplicate terminal emissions

This plan addresses three related defects in the current progress reporting and task-status bridging implementation:

1. `sendProgress()` short-circuits task-status bridging when the client omits `_meta.progressToken`, so task `statusMessage` never advances for task-augmented calls without progress opt-in.
2. `registerTaskTool()` wraps work in `executor.run(...)`, but stream-backed tools (`chat`, `research`, `analyze`, `review`) internally call `executor.runStream(...)`. Both layers emit terminal progress, producing duplicate completion/failure notifications and overwriting specific messages (e.g. `"3 sources found"`) with generic `"completed"`.
3. `analyze.ts` diagram flow has off-by-one upload progress and inflates total-step math using `attachedParts.length` (2 parts per file: URI + label), making displayed progress inconsistent with actual file count.

Scope is limited to correctness fixes plus regression tests. Optional architectural refactors (#4–#6 from the review) are out of scope.

## 1. Requirements & Constraints

- **REQ-001**: Task-augmented tool calls MUST update `task.statusMessage` via the bridge regardless of whether the client sent `_meta.progressToken`.
- **REQ-002**: Progress notifications MUST continue to be emitted only when `progressToken` is present (MCP spec).
- **REQ-003**: Stream-backed task tools MUST emit exactly one terminal `reportCompletion` or `reportFailure` per invocation.
- **REQ-004**: The inner stream's `reportMessage` MUST be preserved as the final user-visible completion message (no generic `"completed"` overwrite from the outer wrapper).
- **REQ-005**: `analyze_diagram` upload progress MUST be monotonic from `1..N` where `N` is file count, and downstream `totalSteps` math MUST be based on uploaded file count, not `attachedParts.length`.
- **CON-001**: Existing public API surface (`executor.run`, `executor.runStream`, `sendProgress`) MUST remain backward-compatible. New behavior is opt-in via optional parameter.
- **CON-002**: No changes to Zod schemas, MCP tool registration surface, or output contract.
- **PAT-001**: Follow existing `ProgressReporter` / `ServerContext` patterns. No new global state.
- **GUD-001**: Keep error-normalization and tracing in `executeWithTracing`; only gate terminal progress emission.

## 2. Implementation Steps

### Implementation Phase 1: Decouple task-status bridge from progress token

- GOAL-001: Ensure `task.store.updateTaskStatus` is invoked from `sendProgress` even when `progressToken` is undefined, without sending unwanted `notifications/progress`.

| Task     | Description                                                                                                                                                                                                                                                                                                 | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In [src/lib/progress.ts](src/lib/progress.ts), refactor `sendProgress()` so the abort check runs first, then the `progressToken !== undefined` branch handles throttle + `notify` + `updateProgressStateAfterNotify`, and `bridgeProgressMessage(ctx, message, isTerminal)` runs unconditionally afterward. |           |      |
| TASK-002 | Verify `isTerminalProgress(progress, total)` is computed once before the branch so the task bridge still receives the correct `isTerminal` flag when no progress token is present.                                                                                                                          |           |      |
| TASK-003 | Confirm `reportCompletion` / `reportFailure` helpers still function correctly (they call `sendProgress` with `progress=100, total=100`, which must trigger the task-bridge `force: true` branch).                                                                                                           |           |      |

### Implementation Phase 2: Gate terminal progress emission in `ToolExecutor`

- GOAL-002: Prevent double terminal-progress emission when `executor.run` wraps a call that internally uses `executor.runStream`.

| Task     | Description                                                                                                                                                                                                                                                                                                                                               | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-004 | In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), add `interface ExecutionOptions { reportTerminalProgress?: boolean }` above `ToolExecutor`. Default behavior (`undefined` or `true`) MUST match current behavior.                                                                                                                                |           |      |
| TASK-005 | Thread `options: ExecutionOptions` through `executeWithTracing`, `run`, and `runStream`. Guard the `reportFailure` / `reportCompletion` calls inside `executeWithTracing` with `if (options.reportTerminalProgress !== false) { ... }`. The catch-block's `reportFailure` must be behind the same guard.                                                  |           |      |
| TASK-006 | In [src/lib/task-utils.ts](src/lib/task-utils.ts) `registerTaskTool`, pass `{ reportTerminalProgress: false }` as the final argument to `executor.run(...)`. This makes the inner `executor.runStream` inside each tool the sole terminal emitter.                                                                                                        |           |      |
| TASK-007 | Audit non-stream task tools (search for `executor.run(` outside of `runStream`) to confirm they do not rely on the outer wrapper for their terminal progress. Any sync-only task tool MUST emit its own `reportCompletion`/`reportFailure` (or accept the loss). If any such tool exists and needs the outer emission, expose a helper call site instead. |           |      |

### Implementation Phase 3: Fix analyze diagram progress math

- GOAL-003: Make `analyze_diagram` upload progress monotonic and downstream step totals reflect file count, not part count.

| Task     | Description                                                                                                                                                                                                                                                                      | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-008 | In [src/tools/analyze.ts](src/tools/analyze.ts), change `uploadDiagramSourceFiles` return type to `Promise<{ parts: Part[]; uploadedCount: number }>`. Move `progress.step(...)` to AFTER the `uploadFile` call and report `index + 1` with message `"Uploaded <name> (i+1/N)"`. |           |      |
| TASK-009 | Update `analyzeDiagramWork` to destructure `{ parts, uploadedCount }` from `uploadDiagramSourceFiles`. Assign `attachedParts = parts`.                                                                                                                                           |           |      |
| TASK-010 | In `analyzeDiagramWork`, compute `totalSteps = uploadedCount > 0 ? uploadedCount + 1 : 1` and call `progress.send(uploadedCount, totalSteps, \`Generating ${args.diagramType} diagram\`)`.                                                                                       |           |      |
| TASK-011 | Preserve URL branch behavior: when `targetKind === 'url'`, `uploadedCount` stays `0` so `totalSteps = 1` and the single `"Generating"` step reports `progress.send(0, 1, ...)` (unchanged user-facing behavior for URL flow).                                                    |           |      |

### Implementation Phase 4: Regression tests

- GOAL-004: Lock in the three fixes with deterministic tests.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                     | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-012 | Add test in `__tests__/lib/` (e.g. extend `__tests__/lib/task-utils.test.ts` or add a new `progress-bridge.test.ts`) that invokes `sendProgress(ctx, 50, 100, 'msg')` with a `ctx` that has `ctx.task` populated but NO `_meta.progressToken`, and asserts `ctx.task.store.updateTaskStatus` was called with `'working', 'msg'`.                                |           |      |
| TASK-013 | Add test that invokes `sendProgress(ctx, 100, 100, 'final')` (terminal) without `progressToken` and asserts the task bridge is called with `force: true` semantics (i.e. the `updateTaskStatus` call happens even when within the `TASK_STATUS_INTERVAL_MS` throttle window).                                                                                   |           |      |
| TASK-014 | Add test in `__tests__/lib/tool-executor.test.ts` that spies on `reportCompletion`/`reportFailure`, invokes a stub stream-backed task tool through the `registerTaskTool` → `executor.run` → `executor.runStream` path, and asserts terminal progress is emitted exactly once per success and once per failure.                                                 |           |      |
| TASK-015 | Add test in `__tests__/tools/` (new file `analyze-diagram-progress.test.ts` or extend existing analyze tests) that mocks `uploadFile` for 3 source files, captures all `sendProgress` calls, and asserts: (a) upload step values are `1, 2, 3` (not `0, 1, 2`); (b) final "Generating" step reports `progress=3, total=4`; (c) no duplicate terminal emissions. |           |      |
| TASK-016 | Run full gate: `npm run format; npm run lint; npm run type-check; npm run build; npm run test`. All MUST pass.                                                                                                                                                                                                                                                  |           |      |

## 3. Alternatives

- **ALT-001**: Remove the outer `executor.run(...)` wrapper from `registerTaskTool` entirely and let stream-backed tools emit their own terminal progress. Rejected: would lose tracing, `AppError.toToolResult` normalization, and structured-result validation at the wrapper boundary for sync-only task tools.
- **ALT-002**: Detect nested executor calls via an AsyncLocalStorage marker and auto-skip terminal emission in the outer layer. Rejected: implicit behavior is harder to audit; explicit `reportTerminalProgress: false` option is clearer.
- **ALT-003**: Split `sendProgress` into `emitProgressNotification` and `emitTaskStatus` and call them independently from helpers. Rejected: larger API surface change; inline conditional keeps one entry point per the existing design.
- **ALT-004**: Count parts instead of files in `analyze.ts`. Rejected: user-facing progress should reflect logical work units (files), not protocol representation (parts).

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server@2.0.0-alpha.2` — `ServerContext`, `reportCompletion` signatures unchanged.
- **DEP-002**: Node test runner (`node --test` via `tsx/esm`) for new regression tests.
- **DEP-003**: No new runtime dependencies. No package.json changes.

## 5. Files

- **FILE-001**: [src/lib/progress.ts](src/lib/progress.ts) — refactor `sendProgress` branching (Phase 1).
- **FILE-002**: [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — add `ExecutionOptions`, gate terminal emissions (Phase 2).
- **FILE-003**: [src/lib/task-utils.ts](src/lib/task-utils.ts) — pass `{ reportTerminalProgress: false }` in `registerTaskTool` (Phase 2).
- **FILE-004**: [src/tools/analyze.ts](src/tools/analyze.ts) — fix diagram upload progress math (Phase 3).
- **FILE-005**: `__tests__/lib/task-utils.test.ts` or new `__tests__/lib/progress-bridge.test.ts` — Phase 1/2 regression tests.
- **FILE-006**: `__tests__/lib/tool-executor.test.ts` — single terminal emission test (Phase 2).
- **FILE-007**: New test file under `__tests__/tools/` — analyze diagram progress regression (Phase 3).

## 6. Testing

- **TEST-001**: Task-status bridge runs when `progressToken` is `undefined` but `ctx.task` is populated (non-terminal).
- **TEST-002**: Task-status bridge runs on terminal progress with `force: true` semantics when `progressToken` is `undefined`.
- **TEST-003**: When `progressToken` IS present, `ctx.mcpReq.notify` is called AND task-status bridge still runs (existing behavior preserved).
- **TEST-004**: Stream-backed task tool emits exactly one `reportCompletion` on success (from inner `runStream`) and one `reportFailure` on error — never two.
- **TEST-005**: Inner stream's `reportMessage` reaches the wire; outer generic `"completed"` is not emitted.
- **TEST-006**: `executor.run(...)` without `reportTerminalProgress: false` option keeps existing behavior for non-task/non-stream call sites (backward compat).
- **TEST-007**: `analyze_diagram` with 3 files emits upload progress `(1,4), (2,4), (3,4)` then `(3,4)` "Generating".
- **TEST-008**: `analyze_diagram` URL branch emits `(0,1)` "Generating" (unchanged).
- **TEST-009**: Full existing suite (`npm run test`) passes with no new failures.

## 7. Risks & Assumptions

- **RISK-001**: A sync-only task tool relying on outer terminal progress would silently lose its completion message after TASK-006. Mitigated by TASK-007 audit.
- **RISK-002**: Tests that previously asserted duplicate or generic `"completed"` messages may need updates. Verify during TASK-016.
- **RISK-003**: Throttle state (`lastTaskStatusTime`) may need an additional `resetProgressThrottle()` call in test setup for deterministic bridging assertions.
- **ASSUMPTION-001**: All current task-registered tools use `executor.runStream` internally OR are acceptable to lose the outer completion emission. Validated in TASK-007.
- **ASSUMPTION-002**: MCP SDK v2 alpha does not itself emit synthetic terminal progress from the task lifecycle that would conflict with our single-emitter model.
- **ASSUMPTION-003**: `ctx.task.store.updateTaskStatus` is safe to call on a task already in a terminal state (error is swallowed inside `bridgeProgressToTask`).

## 8. Related Specifications / Further Reading

- [src/lib/progress.ts](src/lib/progress.ts)
- [src/lib/tool-executor.ts](src/lib/tool-executor.ts)
- [src/lib/task-utils.ts](src/lib/task-utils.ts)
- [src/tools/analyze.ts](src/tools/analyze.ts)
- MCP spec: progress notifications and task lifecycle (separate surfaces).
