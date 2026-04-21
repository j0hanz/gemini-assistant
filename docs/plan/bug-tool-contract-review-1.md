---
goal: Fix MCP tool contract issues surfaced by tool-definition review (must-fix + should-fix)
version: 1.1
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [bug, contract, mcp, tools]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan remediated the MCP tool-definition review findings for `analyze`, `memory`, and related tools. It covered three must-fix defects (silently dropped diagram content, incorrect destructive annotation on `memory`, unsafe `name: 'N/A'` cache fallback) and three should-fix hardening items (optimistic `idempotentHint` on `analyze`, unreachable `memory` fallthrough error, and incomplete `confirmationRequired` field on the cache-delete decline path). The implementation is complete, verified by lint, type-check, and full test-suite execution.

## 1. Requirements & Constraints

- **REQ-001**: The `analyze` diagram branch must surface the formatted fenced-diagram markdown as the primary `content` text block.
- **REQ-002**: The `memory` tool annotations must accurately reflect its destructive surface (`caches.delete`).
- **REQ-003**: `memory caches.create` must never emit a fabricated cache name that violates the `cachedContents/` regex in `CacheSummarySchema`.
- **REQ-004**: The `analyze` tool annotations must accurately reflect idempotency.
- **REQ-005**: The `memory` handler dispatch must not expose an unreachable user-facing error path for enum-validated actions.
- **REQ-006**: `deleteCacheWork` must emit an unambiguous `confirmationRequired` value on both the `declined` and `unsupported` branches.
- **CON-001**: All outputs must continue to validate against existing Zod output schemas without schema changes.
- **CON-002**: No behavior change permitted for successful non-diagram `analyze` calls.
- **CON-003**: Public tool names and schemas (`AnalyzeInputSchema`, `MemoryOutputSchema`, etc.) must remain backward compatible.
- **GUD-001**: Prefer minimal edits; reuse existing helpers (`AppError`, `validateStructuredContent`, `resultMod`).
- **PAT-001**: Stream result customization must use the `resultMod` channel in `ToolExecutor.runStream` ([src/lib/tool-executor.ts](src/lib/tool-executor.ts#L141-L147)).
- **PAT-002**: Runtime invariants that indicate a programming error (not user input) should throw, allowing `wrapTaskSafeWork` to convert to a tool-level error.

## 2. Implementation Steps

### Implementation Phase 1 — Must-fix defects

- GOAL-001: Restore correct `content`, annotations, and cache-name safety across `analyze` and `memory`.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                          | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In [src/tools/analyze.ts](src/tools/analyze.ts) `analyzeDiagramWork` responseBuilder, replace the returned `{ content, structuredContent }` object with `{ resultMod: () => ({ content: [{ type: 'text', text: formatAnalyzeDiagramMarkdown(diagram, diagramType, explanation) }] }), structuredContent: { diagram, diagramType, ...(explanation ? { explanation } : {}) } }`. Keep `extractDiagram` call identical. | Yes       | 2026-04-22 |
| TASK-002 | In [src/tools/memory.ts](src/tools/memory.ts) `registerMemoryTool`, change `annotations: MUTABLE_ANNOTATIONS` to `annotations: { ...MUTABLE_ANNOTATIONS, destructiveHint: true }`. Do not introduce a new exported constant.                                                                                                                                                                                         | Yes       | 2026-04-22 |
| TASK-003 | In [src/tools/memory.ts](src/tools/memory.ts) `buildCreateCacheResult`, remove the `'N/A'` fallback. When `cache.name` is falsy, `throw new AppError('memory', 'memory: Gemini returned a cache with no resource name.')`. Replace `const cacheName = cache.name ?? 'N/A'` with `const cacheName = cache.name`.                                                                                                      | Yes       | 2026-04-22 |
| TASK-004 | Update [`__tests__/mcp-tools.e2e.test.ts`](__tests__/mcp-tools.e2e.test.ts) `EXPECTED_TOOL_CONTRACTS.memory.annotations` to the new destructive-hint value (inline object `{ destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false }`).                                                                                                                                             | Yes       | 2026-04-22 |
| TASK-005 | Run `npm run lint` and `npm run type-check`; fix any surfaced issues without widening scope.                                                                                                                                                                                                                                                                                                                         | Yes       | 2026-04-22 |
| TASK-006 | Run `npm run test`; ensure all tests pass including updated `mcp-tools.e2e` contract assertions.                                                                                                                                                                                                                                                                                                                     | Yes       | 2026-04-22 |

### Implementation Phase 2 — Should-fix hardening

- GOAL-002: Sharpen annotation accuracy and eliminate dead/ambiguous handler paths.

| Task     | Description                                                                                                                                                                                                                                                                                                                                     | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-007 | In [src/lib/task-utils.ts](src/lib/task-utils.ts), add a new exported `READONLY_NON_IDEMPOTENT_ANNOTATIONS` constant: `{ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const`. Do not modify existing `READONLY_ANNOTATIONS` (still used by `research`, `review`).                                | Yes       | 2026-04-22 |
| TASK-008 | In [src/tools/analyze.ts](src/tools/analyze.ts) `registerAnalyzeTool`, replace `annotations: READONLY_ANNOTATIONS` with `annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS` and update the import accordingly.                                                                                                                                   | Yes       | 2026-04-22 |
| TASK-009 | Update [`__tests__/mcp-tools.e2e.test.ts`](__tests__/mcp-tools.e2e.test.ts) `EXPECTED_TOOL_CONTRACTS.analyze.annotations` to `{ destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: true }`.                                                                                                                      | Yes       | 2026-04-22 |
| TASK-010 | In [src/tools/memory.ts](src/tools/memory.ts) `memoryWork`, replace the terminal `else { result = new AppError(...).toToolResult(); }` fallthrough with `throw new Error(\`memory: Unhandled action '${String(args.action)}'. Enum validation failed upstream.\`);`. This converts an unreachable user-facing error into an explicit invariant. | Yes       | 2026-04-22 |
| TASK-011 | In [src/tools/memory.ts](src/tools/memory.ts) `memoryWork`, after the dispatch block remove the redundant `if (result.isError) return result;` guard (the trailing `return result;` is already equivalent). Leave a single `return result;`.                                                                                                    | Yes       | 2026-04-22 |
| TASK-012 | In [src/tools/memory.ts](src/tools/memory.ts) `deleteCacheWork`, update the `declined` branch to include `confirmationRequired: false` in `structuredContent`, matching the `unsupported` branch's shape for consistent client introspection. Schema already allows the optional field.                                                         | Yes       | 2026-04-22 |
| TASK-013 | Run `npm run lint`, `npm run type-check`, `npm run test` and resolve any regressions.                                                                                                                                                                                                                                                           | Yes       | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Keep `MUTABLE_ANNOTATIONS` unchanged and introduce a `DESTRUCTIVE_ANNOTATIONS` constant. Rejected — only `memory` needs this variant today; introducing a new constant for a single consumer adds surface without payoff.
- **ALT-002**: Split the `memory` tool into `memory.read` + `memory.mutate` to isolate the destructive surface. Rejected — breaks public tool contract and is out of scope for a bug-fix plan.
- **ALT-003**: Change `CacheSummarySchema.name` to accept arbitrary strings to tolerate `'N/A'`. Rejected — weakens the external contract to work around an upstream anomaly; the correct response is a tool-level error.
- **ALT-004**: Move the `analyze` diagram formatting into `buildAnalyzeStructuredContent` instead of `resultMod`. Rejected — `buildAnalyzeStructuredContent` only shapes `structuredContent`; the `content` channel is the appropriate surface for the rendered markdown.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` — `CallToolResult`, `ServerContext`, tool registration APIs (no version bump).
- **DEP-002**: `zod/v4` — existing `CacheSummarySchema`, `MemoryOutputSchema`, `AnalyzeOutputSchema` remain authoritative (no version bump).
- **DEP-003**: Existing `ToolExecutor.runStream` `resultMod` contract in [src/lib/tool-executor.ts](src/lib/tool-executor.ts).

## 5. Files

- **FILE-001**: [src/tools/analyze.ts](src/tools/analyze.ts) — diagram responseBuilder fix (TASK-001); annotations swap (TASK-008).
- **FILE-002**: [src/tools/memory.ts](src/tools/memory.ts) — destructive annotation (TASK-002), cache-name invariant (TASK-003), handler fallthrough (TASK-010/011), decline branch shape (TASK-012).
- **FILE-003**: [src/lib/task-utils.ts](src/lib/task-utils.ts) — new `READONLY_NON_IDEMPOTENT_ANNOTATIONS` constant (TASK-007).
- **FILE-004**: [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts) — updated contract expectations (TASK-004, TASK-009).

## 6. Testing

- **TEST-001**: `mcp-tools.e2e` contract test must assert `memory` advertises `destructiveHint: true`.
- **TEST-002**: `mcp-tools.e2e` contract test must assert `analyze` advertises `idempotentHint: false`.
- **TEST-003**: Add a unit test covering `analyzeDiagramWork` that confirms the first `content` text block equals the output of `formatAnalyzeDiagramMarkdown(...)` (regression for TASK-001). Suggested location: new case in [**tests**/tools/analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts).
- **TEST-004**: Add a unit test in [**tests**/tools/memory.test.ts](__tests__/tools/memory.test.ts) that simulates `getAI().caches.create` returning `{ name: undefined }` and asserts the returned `CallToolResult` has `isError: true` with a message containing `"no resource name"` (regression for TASK-003).
- **TEST-005**: Add a unit test in [**tests**/tools/memory.test.ts](__tests__/tools/memory.test.ts) asserting that `deleteCacheWork` with confirmation `declined` returns `structuredContent.confirmationRequired === false` (regression for TASK-012).
- **TEST-006**: Full `npm run test` suite must pass.

## 9. Completion Summary

- Implemented the diagram `content` fix in [src/tools/analyze.ts](src/tools/analyze.ts) using `resultMod`, so rendered diagram markdown now reaches the primary `content` channel.
- Corrected tool annotations for `memory` and `analyze`, including destructive and non-idempotent metadata, in [src/tools/memory.ts](src/tools/memory.ts), [src/tools/analyze.ts](src/tools/analyze.ts), and [src/lib/task-utils.ts](src/lib/task-utils.ts).
- Hardened `memory` cache creation and deletion flows in [src/tools/memory.ts](src/tools/memory.ts) by rejecting nameless caches, throwing on unreachable dispatch fallthrough, and returning `confirmationRequired: false` on declined deletion.
- Added regression coverage in [**tests**/tools/analyze-diagram-progress.test.ts](__tests__/tools/analyze-diagram-progress.test.ts), [**tests**/tools/memory.test.ts](__tests__/tools/memory.test.ts), and updated contract assertions in [**tests**/mcp-tools.e2e.test.ts](__tests__/mcp-tools.e2e.test.ts).
- Verified the completed work with `npm run lint`, `npm run type-check`, and `npm run test` on 2026-04-22.

## 7. Risks & Assumptions

- **RISK-001**: Clients that key off the existing `memory` annotation set (`destructiveHint: false`) may treat the tool as safer than it is; fixing the annotation is a deliberate contract correction, not a silent break.
- **RISK-002**: TASK-010 converts a path currently reachable only via schema bypass into a thrown error. Any test that exercised the fallthrough by constructing a raw `MemoryInput` with an unsupported action must be updated.
- **RISK-003**: TASK-003 changes a previously successful-but-malformed response into a tool-level error. This is the intended behavior but alters observable output for that edge case.
- **ASSUMPTION-001**: Zod `MemoryInputSchema` enum validation cannot be bypassed by normal MCP clients; the unreachable fallthrough is confirmed unreachable in production flows.
- **ASSUMPTION-002**: `ToolExecutor.runStream` semantics (only `resultMod`, `structuredContent`, `reportMessage` consumed from the builder return value) remain as implemented at [src/lib/tool-executor.ts](src/lib/tool-executor.ts#L141-L147).
- **ASSUMPTION-003**: The Gemini SDK's `caches.create` return shape includes `name` on success under normal conditions; a missing name is exceptional and warrants a hard error.

## 8. Related Specifications / Further Reading

- [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — stream response builder contract
- [src/lib/task-utils.ts](src/lib/task-utils.ts) — annotation constants and `registerTaskTool`
- [src/schemas/outputs.ts](src/schemas/outputs.ts) — `AnalyzeOutputSchema`, `MemoryOutputSchema`
- [src/schemas/fragments.ts](src/schemas/fragments.ts) — `cacheSummaryFields`
- MCP specification: tool annotations (`destructiveHint`, `idempotentHint`, `readOnlyHint`, `openWorldHint`)
