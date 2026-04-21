---
goal: Patch Gemini Assistant observability, contract issues, and add regression tests
version: 1.0
date_created: 2026-04-21
status: 'Completed'
tags: ['bug', 'refactor', 'observability']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This implementation plan outlines the steps required to apply the fixes identified in `.github/plan.md`. The goal is to patch observability pollution, align internal tool telemetry with public MCP contract names, stop fabricating `structuredContent` on stream results, and appropriately downgrade expected configuration warnings.

## 1. Requirements & Constraints

- **REQ-001**: Operational log `app.log` must not contain test-run pollution. Test runs must write to `test-app.log`.
- **REQ-002**: The tracked `toolName` for the `research` tool telemetry must strictly be `'research'` instead of `'search'` or `'agentic_search'`.
- **REQ-003**: The streaming tool executor must not synthesize a generic `structuredContent: { answer: text }` payload by default. It must only emit `structuredContent` when the tool specifically provides one.
- **REQ-004**: The web-standard transport auto-serve missing warning must be downgraded to an `info` log.
- **PAT-001**: Adhere to the Model Context Protocol (MCP) specification which dictates that `structuredContent` must map exactly to the tool's declared `outputSchema`.

## 2. Implementation Steps

### Implementation Phase 1: Observability & Logging Fixes

- GOAL-001: Clean up logs by separating test output and downgrading normal workflow warnings.

| Task     | Description                                                                                                                                       | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Modify `src/lib/logger.ts` to check `process.execArgv.includes('--test')` and write logs to `test-app.log` during test runs instead of `app.log`. | ✅        | 2026-04-21 |
| TASK-002 | Modify `src/transport.ts` `startWebStandardTransport` to use `log.info` instead of `log.warn` for the missing auto-serve runtime message.         | ✅        | 2026-04-21 |

### Implementation Phase 2: Protocol Contract & Telemetry Fixes

- GOAL-002: Ensure strict MCP protocol compliance and telemetry tracing.

| Task     | Description                                                                                                                                                                         | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-003 | Update `src/tools/research.ts` to use `'research'` as the tool key for both standard and agentic search `runToolStream` invocations.                                                | ✅        | 2026-04-21 |
| TASK-004 | Update `src/lib/tool-executor.ts` `runStream` method to stop synthesizing `{ answer: text }` as `structuredContent`. Merge metadata only if real structured content already exists. | ✅        | 2026-04-21 |

### Implementation Phase 3: Testing & Validation

- GOAL-003: Prevent future regression of the `structuredContent` contract.

| Task     | Description                                                                                                                                            | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-005 | Add a test in `__tests__/lib/tool-executor.test.ts` to verify `runStream` does not synthesize `structuredContent` when the caller does not provide it. | ✅        | 2026-04-21 |

## 3. Alternatives

- **ALT-001**: Introduce a complex configuration-based logging override instead of using `process.execArgv.includes('--test')`. Not chosen because `process.execArgv` is highly effective, native to the node test runner, and requires zero external configuration overhead.
- **ALT-002**: Convert `memory` schema to a discriminated union. Not chosen currently to limit the scope to immediate contract/telemetry bugs and avoid major external-contract edits.

## 4. Dependencies

- **DEP-001**: Node.js `process` global and `execArgv` array for identifying test environments.

## 5. Files

- **FILE-001**: `src/lib/logger.ts` (Log splitting logic)
- **FILE-002**: `src/transport.ts` (Log warning downgrade)
- **FILE-003**: `src/tools/research.ts` (Telemetry tool name unification)
- **FILE-004**: `src/lib/tool-executor.ts` (Stop fabricating `structuredContent`)
- **FILE-005**: `__tests__/lib/tool-executor.test.ts` (Regression tests)

## 6. Testing

- **TEST-001**: Verify that running tests (e.g. `npm run test`) routes log output to `logs/test-app.log`.
- **TEST-002**: Verify that starting the server normally outputs logs to `logs/app.log`.
- **TEST-003**: Run the new unit test in `__tests__/lib/tool-executor.test.ts` to ensure `structuredContent` is undefined if the stream does not supply it.

## 7. Risks & Assumptions

- **RISK-001**: Changing `structuredContent` generation in `runStream` could impact downstream clients that currently depend on the fabricated `{ answer: text }` payload despite it being non-compliant.
- **ASSUMPTION-001**: The node test runner explicitly passes `--test` in `process.execArgv`.

## 8. Related Specifications / Further Reading

- `.github/plan.md`
