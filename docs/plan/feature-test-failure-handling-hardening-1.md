---
goal: Harden MCP test suite & failure-handling invariants
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['feature', 'testing', 'mcp', 'quality']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Close the gaps identified in the test & failure-handling audit of the `gemini-assistant` MCP server. The plan adds targeted tests that enforce the six contract rules (content always present, `structuredContent` only when it matches `outputSchema`, runtime failures surface as `isError:true`, protocol failures surface as JSON-RPC errors, progress gated by `progressToken`, stdio stdout clean) and removes the existing lenient protocol/tool-error assertion that currently hides regressions.

## 1. Requirements & Constraints

- **REQ-001**: Every tool result MUST include a non-empty `content` array (assert in each new failure test).
- **REQ-002**: `structuredContent` MUST be present only when `isError !== true` AND it validates against the advertised `outputSchema`.
- **REQ-003**: Ordinary runtime failures MUST return `CallToolResult` with `isError: true`, not JSON-RPC errors.
- **REQ-004**: Request-boundary validation failures (invalid `tools/call` args) MUST surface as JSON-RPC `-32602`, never as a synthetic tool result.
- **REQ-005**: `notifications/progress` MUST only be emitted when the incoming request carries `_meta.progressToken`.
- **REQ-006**: Stdio transport MUST write only framed JSON-RPC messages to `process.stdout`; logs MUST go to `logs/app.log`.
- **SEC-001**: No test may leak real API keys; all tests MUST use `MockGeminiEnvironment` and `process.env.API_KEY ??= 'test-key-...'`.
- **CON-001**: Runtime is Node.js `>=24`; tests use `node:test` + `tsx/esm` as wired in `package.json` (`npm run test`).
- **CON-002**: MCP SDK is `@modelcontextprotocol/server` v2 alpha. Known behavior: tool-body schema failures become `isError:true`; only request-boundary failures are `-32602`. Tests must distinguish the two.
- **CON-003**: Zod v4 + `z.toJSONSchema()` is the source of truth for advertised schemas.
- **GUD-001**: Colocate new tests under the existing `__tests__/` layout (top-level for e2e, `__tests__/lib/` for unit).
- **GUD-002**: Prefer the existing harness in [**tests**/lib/mcp-contract-client.ts](__tests__/lib/mcp-contract-client.ts) and [**tests**/lib/mcp-contract-assertions.ts](__tests__/lib/mcp-contract-assertions.ts) over ad-hoc transports.
- **PAT-001**: One assertion helper per invariant — `assertProtocolError`, `assertToolExecutionError`, `assertNoStructuredContentOnError`.
- **PAT-002**: Negative tests for progress MUST assert `notify` call-count `=== 0`, not merely "did not throw".

## 2. Implementation Steps

### Implementation Phase 1 — Contract-assertion refactor

- GOAL-001: Split the current lenient `assertRequestValidationFailure` helper into strict, single-purpose assertions and wire callers to them.

| Task     | Description                                                                                                                                                                                                                                                                                               | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In [**tests**/lib/mcp-contract-assertions.ts](__tests__/lib/mcp-contract-assertions.ts) add `assertProtocolError(response, code, pattern)` that asserts `isJsonRpcFailure(response) === true`, `response.result === undefined`, `response.error.code === code`, `response.error.message` matches pattern. | ✓         | 2026-04-22 |
| TASK-002 | In the same file add `assertNoStructuredContentOnError(result: ToolCallResult)` that asserts `result.isError === true`, `result.content.length >= 1`, and `(result as any).structuredContent === undefined`.                                                                                              | ✓         | 2026-04-22 |
| TASK-003 | Deprecate `assertRequestValidationFailure` by narrowing it: remove the fallback to `assertToolExecutionError`; keep the name for source compatibility but have it call `assertProtocolError`.                                                                                                             | ✓         | 2026-04-22 |
| TASK-004 | Update [**tests**/contract-errors.e2e.test.ts](__tests__/contract-errors.e2e.test.ts) line ~42 to use `assertProtocolError` directly for the missing-`filePath` case.                                                                                                                                     | ✓         | 2026-04-22 |
| TASK-005 | Grep for remaining usages of `assertRequestValidationFailure` in `__tests__/` and migrate each to the correct helper.                                                                                                                                                                                     | ✓         | 2026-04-22 |

### Implementation Phase 2 — Public-surface failure invariants

- GOAL-002: Prove on the e2e surface (not only via internal helpers) that every tool failure shape satisfies REQ-001, REQ-002, REQ-003, REQ-004.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                            | Completed                           | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------- |
| TASK-006 | Add test `invalid tools/call args surface as -32602, not a fake tool result` to [**tests**/contract-errors.e2e.test.ts](__tests__/contract-errors.e2e.test.ts) using `harness.client.requestRaw('tools/call', { name: 'analyze', arguments: { goal: 'x' } })` and `assertProtocolError(response, -32602, /filePath/i)`.                                                                                                                | ✓                                   | 2026-04-22 |
| TASK-007 | Add test `failed tool calls never return structuredContent` to the same file, using the `memory` tool with `action: 'caches.get', cacheName: 'cachedContents/missing-cache'`, then `assertNoStructuredContentOnError(response.result)`.                                                                                                                                                                                                | ✓                                   | 2026-04-22 |
| TASK-008 | Add parametric test `every tool failure result has non-empty content[] and isError:true` iterating over all 5 tool names from `harness.client.request('tools/list')`, each invoked with deliberately invalid but schema-valid business args that force `MockGeminiEnvironment` to reject, then asserting REQ-001 + REQ-003.                                                                                                            | ✓                                   | 2026-04-22 |
| TASK-009 | Add round-trip test `advertised outputSchema validates a real success payload for every tool` in [**tests**/contract-surface.test.ts](__tests__/contract-surface.test.ts): iterate `tools/list`, queue a success fixture per tool in `MockGeminiEnvironment`, call the tool, run `assertAdvertisedOutputSchema(toolInfo, result)` (already defined in [mcp-contract-assertions.ts#L55](__tests__/lib/mcp-contract-assertions.ts#L55)). | ✓ (already covered inline per-tool) | 2026-04-22 |

### Implementation Phase 3 — Progress gating

- GOAL-003: Guarantee REQ-005 (no `notifications/progress` without `progressToken`).

| Task     | Description                                                                                                                                                                                                                                                                                                                                        | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-010 | Replace [**tests**/lib/errors.test.ts#L167-L172](__tests__/lib/errors.test.ts#L167-L172) "is a no-op without progressToken" with a strict version that installs `ctx.mcpReq.notify = (...args) => calls.push(args)` and asserts `calls.length === 0` after multiple `sendProgress` invocations covering start, mid, terminal (progress === total). | ✓         | 2026-04-22 |
| TASK-011 | Add a sibling test in [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts) that sets a `task` object without a `progressToken` and asserts `notify` is not called even though the task bridge is exercised.                                                                                                                                | ✓         | 2026-04-22 |
| TASK-012 | Add an e2e test in [**tests**/notifications.e2e.test.ts](__tests__/notifications.e2e.test.ts): invoke a tool via `tools/call` WITHOUT `_meta.progressToken`, collect notifications for the session, and assert zero `notifications/progress` frames were received.                                                                                 | ✓         | 2026-04-22 |

### Implementation Phase 4 — Stdio stdout cleanliness

- GOAL-004: Guarantee REQ-006 with a dedicated transport test.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                  | Completed   | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| TASK-013 | Create `__tests__/transport-stdio.test.ts`. Use `node:stream.PassThrough` for stdin/stdout, call `createStdioTransport` from [src/transport.ts](src/transport.ts) (adapting to whatever constructor signature accepts custom streams — inspect source first; if the factory is hard-coded to `process.std{in,out}`, add a minimal DI parameter in the source or expose a test-only factory). | ✓           | 2026-04-22 |
| TASK-014 | In the same file, drive an `initialize` → `tools/list` → `tools/call` sequence, capture all stdout bytes, split on `\n`, and assert every non-empty line parses as JSON with `jsonrpc === '2.0'`.                                                                                                                                                                                            | ✓           | 2026-04-22 |
| TASK-015 | Replaced with Logger unit test using injected `logStream` spy sink (process-level patching not viable under `node:test` runner which writes binary frames to stdout). Logger writes only to its configured sink, never to stdout by construction.                                                                                                                                            | ✓ (adapted) | 2026-04-22 |
| TASK-016 | Confirmed [src/lib/logger.ts](src/lib/logger.ts) default sink is `logs/test-app.log`/`logs/app.log` with `process.stderr` fallback — never `stdout`. No source change required.                                                                                                                                                                                                              | ✓           | 2026-04-22 |

### Implementation Phase 5 — Tasks, prompts, resources gap-fill

- GOAL-005: Close the remaining should-have gaps.

| Task     | Description                                                                                                                                                                                                                                                                        | Completed                | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- |
| TASK-017 | Skipped — `@modelcontextprotocol/server` v2 alpha does not expose `tasks/delete` as a JSON-RPC method (only `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` per SDK surface inspection). Revisit when SDK exposes the endpoint.                                          | ⨯ (not supported by SDK) | 2026-04-22 |
| TASK-018 | Already covered by existing test `cancels an in-flight task and leaves no terminal task result stored` in [**tests**/tasks.e2e.test.ts](__tests__/tasks.e2e.test.ts) — uses `createDeferredStream`, asserts status `cancelled`, and `tasks/result` returns a JSON-RPC error.       | ✓ (pre-existing)         | 2026-04-22 |
| TASK-019 | Added `surfaces an unknown resources/read URI through the protocol boundary` in [**tests**/e2e.test.ts](__tests__/e2e.test.ts) asserting JSON-RPC `-32002` (Resource Not Found) via `assertProtocolError`.                                                                         | ✓                        | 2026-04-22 |
| TASK-020 | Adapted: all prompt args are optional in `src/prompts.ts`, so added `surfaces prompts/get with invalid argument shape through the protocol boundary` in [**tests**/e2e.test.ts](__tests__/e2e.test.ts) using `research` prompt with invalid `mode` enum and `assertProtocolError`. | ✓ (adapted)              | 2026-04-22 |
| TASK-021 | Skipped — no prompt in `src/prompts.ts` uses `completable()`; no advertised completions to assert. Revisit if a prompt adopts `completable()`.                                                                                                                                     | ⨯ (not applicable)       | 2026-04-22 |

### Implementation Phase 6 — Validation & CI

- GOAL-006: Ensure the new suite is green and wired into the normal pipeline.

| Task     | Description                                                                                                                                                                                                                                                           | Completed                 | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------- |
| TASK-022 | Run `npm run format` and fix any formatting drift introduced by new files.                                                                                                                                                                                            | ✓                         | 2026-04-22 |
| TASK-023 | Run `npm run lint` and resolve any eslint findings (expected hotspots: `@typescript-eslint/unbound-method` on `process.stdout.write`, `@typescript-eslint/no-explicit-any` in helpers — mitigate with `Object.getOwnPropertyDescriptor(...).value` and narrow types). | ✓                         | 2026-04-22 |
| TASK-024 | Run `npm run type-check`. Ensure new helpers in `mcp-contract-assertions.ts` have precise types (no `any` in public signatures).                                                                                                                                      | ✓                         | 2026-04-22 |
| TASK-025 | Run `npm run test` and confirm every new test passes; total test-file count should go from 30 → 31+ and all assertions green.                                                                                                                                         | ✓ (713 passing, 31 files) | 2026-04-22 |
| TASK-026 | Update [AGENTS.md](AGENTS.md) "Testing Strategy" count if it still cites `30 test files`.                                                                                                                                                                             | ✓                         | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Enforce `structuredContent` stripping on error via a runtime guard only and skip a public-surface test. Rejected: without an e2e test the guard can regress unnoticed.
- **ALT-002**: Detect stdout leaks via a CI-level grep rather than an in-process test. Rejected: would not catch leaks that occur only on specific request paths.
- **ALT-003**: Keep `assertRequestValidationFailure` with its fallback and only add new tests. Rejected: the fallback is the root cause of the boundary-blindness, must be removed.
- **ALT-004**: Spawn a real stdio child process to test stdout cleanliness. Rejected initially because in-process PassThrough is faster and deterministic; if DI isn't feasible in `src/transport.ts`, fall back to child-process spawn in TASK-013.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` v2 alpha — current pinned version in `package.json`.
- **DEP-002**: `@cfworker/json-schema` — already used by `assertAdvertisedOutputSchema`; reused in TASK-009.
- **DEP-003**: `node:test`, `node:assert/strict`, `node:stream` — stdlib, no install needed.
- **DEP-004**: Existing helpers [**tests**/lib/mock-gemini-environment.ts](__tests__/lib/mock-gemini-environment.ts), [**tests**/lib/mcp-contract-client.ts](__tests__/lib/mcp-contract-client.ts).

## 5. Files

- **FILE-001**: [**tests**/lib/mcp-contract-assertions.ts](__tests__/lib/mcp-contract-assertions.ts) — add `assertProtocolError`, `assertNoStructuredContentOnError`; tighten `assertRequestValidationFailure`.
- **FILE-002**: [**tests**/contract-errors.e2e.test.ts](__tests__/contract-errors.e2e.test.ts) — strict protocol error test + no-structuredContent-on-error test + per-tool failure iteration.
- **FILE-003**: [**tests**/contract-surface.test.ts](__tests__/contract-surface.test.ts) — advertised-schema round-trip per tool.
- **FILE-004**: [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts) — tighten no-token test, add task-without-token test.
- **FILE-005**: [**tests**/notifications.e2e.test.ts](__tests__/notifications.e2e.test.ts) — e2e negative test for progress without token.
- **FILE-006**: `__tests__/transport-stdio.test.ts` — NEW; stdio stdout cleanliness + logger-to-stdout guard.
- **FILE-007**: [**tests**/tasks.e2e.test.ts](__tests__/tasks.e2e.test.ts) — `tasks/delete`, `tasks/cancel` mid-run.
- **FILE-008**: [**tests**/resources.test.ts](__tests__/resources.test.ts) — unknown-URI error case.
- **FILE-009**: [**tests**/prompts.test.ts](__tests__/prompts.test.ts) — missing-arg error + `completable()`.
- **FILE-010**: [src/transport.ts](src/transport.ts) — potentially add stream-injection parameter for stdio tests (only if required by TASK-013).
- **FILE-011**: [src/lib/logger.ts](src/lib/logger.ts) — audit/add explicit stdio-mode stdout suppression if missing.
- **FILE-012**: [AGENTS.md](AGENTS.md) — update test-file count note.

## 6. Testing

- **TEST-001**: `assertProtocolError` rejects responses that contain a `result` field (unit test inside new helper file or `__tests__/lib/mcp-contract-assertions.test.ts`).
- **TEST-002**: Invalid `tools/call` args → JSON-RPC `-32602`, no `result` (TASK-006).
- **TEST-003**: Runtime failure for `memory` tool → `isError:true`, non-empty `content[]`, `structuredContent === undefined` (TASK-007).
- **TEST-004**: Iteration over every tool, failure path satisfies REQ-001 + REQ-003 (TASK-008).
- **TEST-005**: Iteration over every tool, success path validates advertised JSON Schema (TASK-009).
- **TEST-006**: `sendProgress` without `progressToken` → `notify.calls.length === 0` across start/mid/terminal (TASK-010).
- **TEST-007**: `sendProgress` with task but without `progressToken` → task bridge runs, `notify` still uncalled (TASK-011).
- **TEST-008**: E2E `tools/call` without `_meta.progressToken` → zero `notifications/progress` frames captured (TASK-012).
- **TEST-009**: Stdio transport: every stdout byte parses as JSON-RPC (TASK-014).
- **TEST-010**: Stdio transport: logger calls do not write non-JSON-RPC bytes to stdout (TASK-015).
- **TEST-011**: `tasks/delete` + later `tasks/result` → JSON-RPC error (TASK-017).
- **TEST-012**: `tasks/cancel` mid-run → status `cancelled`, related-task metadata present (TASK-018).
- **TEST-013**: `resources/read` unknown URI → JSON-RPC error (TASK-019).
- **TEST-014**: `prompts/get` missing required arg → JSON-RPC error (TASK-020).
- **TEST-015**: `completion/complete` returns advertised `completable()` values (TASK-021).

## 7. Risks & Assumptions

- **RISK-001**: `src/transport.ts` may hard-wire `process.stdin`/`process.stdout`; injecting streams could require a small source change. Mitigation: add a test-only factory parameter, not a public API change.
- **RISK-002**: Narrowing `assertRequestValidationFailure` may break other tests that relied on the fallback. Mitigation: TASK-005 migrates all callers; CI will surface any leftover usage.
- **RISK-003**: `MockGeminiEnvironment` may not expose a deterministic way to force per-tool failure fixtures. Mitigation: inspect the mock helper during TASK-008 and add a minimal `queueFailure(toolName, error)` if absent.
- **RISK-004**: SDK alpha may batch or reorder notifications, complicating TASK-012. Mitigation: use the existing notification collector in `notifications.e2e.test.ts` and wait for `tools/call` completion before asserting.
- **ASSUMPTION-001**: `getLogger()` is a singleton and has a settable or env-driven sink; if not, TASK-015 wraps `process.stdout.write` globally regardless of sink.
- **ASSUMPTION-002**: Every advertised `outputSchema` exposed via `tools/list` is a JSON Schema 2020-12 document (matches `@cfworker/json-schema` default used in existing helper).
- **ASSUMPTION-003**: No current test relies on `notifications/progress` firing without a token; removing any such reliance is correct per MCP spec.

## 8. Related Specifications / Further Reading

- MCP specification — `tools/call`, `notifications/progress`, `_meta.progressToken`, task lifecycle.
- [**tests**/lib/mcp-contract-assertions.ts](__tests__/lib/mcp-contract-assertions.ts)
- [**tests**/lib/mcp-contract-client.ts](__tests__/lib/mcp-contract-client.ts)
- [src/lib/progress.ts](src/lib/progress.ts)
- [src/lib/response.ts](src/lib/response.ts)
- [src/transport.ts](src/transport.ts)
- [AGENTS.md](AGENTS.md)
- Audit findings (previous assistant turn in this conversation)
