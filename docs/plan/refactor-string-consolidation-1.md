---
goal: Consolidate duplicated string literals in-place across existing modules
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant
status: 'Completed'
tags: ['refactor', 'maintainability', 'chore']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Reduce drift risk and duplication for hardcoded strings (MIME types, error
messages, JSON-RPC error code, `AnalyzeInput` validation throws) by hoisting
them to module-local constants/helpers **inside the existing files where they
are already used**. No new files are created. No public contract changes.

## 1. Requirements & Constraints

- **REQ-001**: All consolidations must occur in-place; no new source files may be created under `src/`.
- **REQ-002**: Public tool/prompt/resource contracts in [src/public-contract.ts](../../src/public-contract.ts) MUST NOT change.
- **REQ-003**: Existing test suite (`npm run test`, 31 test files) MUST pass without modification, except where a test asserts on a string that this refactor intentionally preserves character-for-character.
- **CON-001**: Default model `gemini-3-flash-preview` MUST remain unchanged. `gemini-2.5-flash` is forbidden.
- **CON-002**: No reorganization of `src/lib/`. Helpers added in this plan live in the file that already throws/uses the string.
- **GUD-001**: Constants are declared at the top of their host file using `as const` where applicable.
- **GUD-002**: Run `npm run format`, `npm run lint`, `npm run type-check`, `npm run test` after every phase per [AGENTS.md](../../AGENTS.md).
- **PAT-001**: Follow existing patterns in [src/lib/errors.ts](../../src/lib/errors.ts): private static `Record` (e.g. `HTTP_STATUS_MESSAGES`) and module-level `Map` (e.g. `FINISH_REASON_ERRORS`).

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Replace inline JSON-RPC error code `-32_603` and bare strings in [src/transport.ts](../../src/transport.ts) with SDK-provided `ProtocolErrorCode.InternalError` and module-local constants.

| Task     | Description                                                                                                                                                                                                        | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-001 | In [src/transport.ts](../../src/transport.ts), add to existing `import { ... } from '@modelcontextprotocol/server'` the symbol `ProtocolErrorCode`.                                                                | ✅        | 2026-04-26 |
| TASK-002 | At top of [src/transport.ts](../../src/transport.ts) (alongside other module-level consts), add `const JSONRPC_VERSION = '2.0' as const;` and `const APPLICATION_JSON = 'application/json' as const;`.             | ✅        | 2026-04-26 |
| TASK-003 | Update `rpcErrorPayload` (line ~302) to use `jsonrpc: JSONRPC_VERSION` and `code: ProtocolErrorCode.InternalError`.                                                                                                | ✅        | 2026-04-26 |
| TASK-004 | Replace all 6 occurrences of the literal `'application/json'` and `'content-type': 'application/json'` in [src/transport.ts](../../src/transport.ts) (lines 213, 221, 229, 239, 313, 320) with `APPLICATION_JSON`. | ✅        | 2026-04-26 |
| TASK-005 | Run `npm run type-check` and `npm run test`; verify zero changes in test output.                                                                                                                                   | ✅        | 2026-04-26 |

### Implementation Phase 2

- GOAL-002: Collapse duplicated MIME literals and the repeated `'Served as application/json with a secondary text/markdown rendering.'` description in [src/resources.ts](../../src/resources.ts).

| Task     | Description                                                                                                                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | At top of [src/resources.ts](../../src/resources.ts) (after imports, before `DISCOVER_CATALOG_URI`), add `const MIME_JSON = 'application/json' as const;` and `const MIME_MARKDOWN = 'text/markdown' as const;` and `const JSON_WITH_MARKDOWN_ALT_DESC = 'Served as application/json with a secondary text/markdown rendering.' as const;`. | ✅        | 2026-04-26 |
| TASK-007 | Replace all 12 `mimeType: 'application/json'` occurrences in [src/resources.ts](../../src/resources.ts) with `mimeType: MIME_JSON`.                                                                                                                                                                                                         | ✅        | 2026-04-26 |
| TASK-008 | Replace both `mimeType: 'text/markdown'` occurrences (lines 113, 763) and the `'text/markdown'` argument on line 195 with `MIME_MARKDOWN`.                                                                                                                                                                                                  | ✅        | 2026-04-26 |
| TASK-009 | Replace all 6 occurrences of the description string with `JSON_WITH_MARKDOWN_ALT_DESC`.                                                                                                                                                                                                                                                     | ✅        | 2026-04-26 |
| TASK-010 | Run `npm run type-check` and `npm run test`.                                                                                                                                                                                                                                                                                                | ✅        | 2026-04-26 |

### Implementation Phase 3

- GOAL-003: Centralize repeated session validation messages in [src/resources.ts](../../src/resources.ts) using existing `ProtocolError` flow.

| Task     | Description                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-011 | At top of [src/resources.ts](../../src/resources.ts), add module-local helpers: `const SESSION_ID_REQUIRED_MSG = 'Session ID required' as const;` and `const sessionNotFoundMsg = (id: string) => \`Session '${id}' not found\` as const;`. | ✅        | 2026-04-26 |
| TASK-012 | Replace 3 occurrences of `'Session ID required'` (lines 416, 431, 447) with `SESSION_ID_REQUIRED_MSG`.                                                                                                                                      | ✅        | 2026-04-26 |
| TASK-013 | Replace 3 occurrences of `` `Session '${sessionId}' not found` `` (lines 421, 436, 452) and the one on line 598 (`` `Session '${id}' not found` ``) with `sessionNotFoundMsg(sessionId)` / `sessionNotFoundMsg(id)`.                        | ✅        | 2026-04-26 |
| TASK-014 | Run `npm run type-check` and `npm run test`.                                                                                                                                                                                                | ✅        | 2026-04-26 |

### Implementation Phase 4

- GOAL-004: Collapse 4 near-identical `requireAnalyze*` throws in [src/tools/analyze.ts](../../src/tools/analyze.ts) into a single local helper.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                     | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-015 | In [src/tools/analyze.ts](../../src/tools/analyze.ts), add a private helper directly above `requireAnalyzeFilePath`: `function requireAnalyzeField<T>(value: T \| undefined, field: string, discriminator: string, kind: string): T { if (value === undefined) throw new Error(\`AnalyzeInput validation requires ${field} when ${discriminator}=${kind}.\`); return value; }`. | ✅        | 2026-04-26 |
| TASK-016 | Rewrite `requireAnalyzeFilePath`, `requireAnalyzeUrls`, `requireAnalyzeFilePaths`, `requireAnalyzeDiagramType` (lines 58–88) as one-line wrappers around `requireAnalyzeField`.                                                                                                                                                                                                 | ✅        | 2026-04-26 |
| TASK-017 | Run `npm run type-check` and `npm run test`.                                                                                                                                                                                                                                                                                                                                    | ✅        | 2026-04-26 |

### Implementation Phase 5

- GOAL-005: Validation and final checks.

| Task     | Description                                                                                                                                | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-018 | Run `npm run format`.                                                                                                                      | ✅        | 2026-04-26 |
| TASK-019 | Run `npm run lint`.                                                                                                                        | ✅        | 2026-04-26 |
| TASK-020 | Run `npm run type-check`.                                                                                                                  | ✅        | 2026-04-26 |
| TASK-021 | Run `npm run test` and confirm 31 test files all pass.                                                                                     | ✅        | 2026-04-26 |
| TASK-022 | Manual diff review: confirm zero new files were created under `src/` and zero behavior changes (literal string values are byte-identical). | ✅        | 2026-04-26 |

## 3. Alternatives

- **ALT-001**: Create a dedicated `src/lib/strings.ts` or `src/lib/mime.ts` module. **Rejected**: project owner explicitly forbids new files for string consolidation; fragmentation hurts maintainability.
- **ALT-002**: Extract LLM system-prompt strings from [src/lib/model-prompts.ts](../../src/lib/model-prompts.ts) into a versioned registry. **Rejected for this plan**: that file already serves as the prompt module; versioning adds complexity disproportionate to current need. Defer until prompt A/B testing is required.
- **ALT-003**: Replace per-tool `*_TOOL_LABEL` constants with derivations from `JOB_METADATA`. **Rejected**: labels are file-local, single-use, and the indirection adds coupling without reducing duplication.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` — already imported in [src/transport.ts](../../src/transport.ts); add `ProtocolErrorCode` to the existing import.
- **DEP-002**: No new npm packages.

## 5. Files

- **FILE-001**: [src/transport.ts](../../src/transport.ts) — add 2 module consts, 1 SDK import, replace `-32_603` + 6 MIME literals.
- **FILE-002**: [src/resources.ts](../../src/resources.ts) — add 3 module consts + 1 helper, replace 12 JSON MIME, 3 markdown MIME, 6 description, 7 session-message literals.
- **FILE-003**: [src/tools/analyze.ts](../../src/tools/analyze.ts) — add 1 helper, collapse 4 throw functions to one-liners.

## 6. Testing

- **TEST-001**: Existing [\_\_tests\_\_/transport.test.ts](../../__tests__/transport.test.ts) and [\_\_tests\_\_/transport-host-validation.test.ts](../../__tests__/transport-host-validation.test.ts) MUST pass unchanged — verifies JSON-RPC payload shape and MIME headers are byte-identical.
- **TEST-002**: Existing [\_\_tests\_\_/resources.test.ts](../../__tests__/resources.test.ts) MUST pass unchanged — verifies resource MIME types and session error messages.
- **TEST-003**: Existing [\_\_tests\_\_/tools/registration.test.ts](../../__tests__/tools/registration.test.ts) and analyze-related tests MUST pass — verifies `AnalyzeInput` validation error messages remain identical.
- **TEST-004**: Full suite `npm run test` exit code 0; no test code changes required.

## 7. Risks & Assumptions

- **RISK-001**: A test asserts on `code: -32603` literally rather than via `ProtocolErrorCode.InternalError`. Mitigation: verify in TASK-005; if value differs, revert TASK-003 and use the literal `ProtocolErrorCode.InternalError` value comparison.
- **RISK-002**: A test imports `rpcErrorPayload` indirectly. Mitigation: function signature unchanged; only literal values inside change, and they remain identical.
- **ASSUMPTION-001**: `ProtocolErrorCode.InternalError === -32603` in the installed `@modelcontextprotocol/server` 2.0.0-alpha.2. Verified via SDK source.
- **ASSUMPTION-002**: All 4 `requireAnalyze*` helpers throw plain `Error` (not `ProtocolError`); preserving this behavior is intentional per existing code.

## 8. Related Specifications / Further Reading

- [AGENTS.md](../../AGENTS.md) — project safety boundaries and required commands.
- [src/lib/errors.ts](../../src/lib/errors.ts) — existing pattern for module-level error tables (`HTTP_STATUS_MESSAGES`, `FINISH_REASON_ERRORS`).
- [src/public-contract.ts](../../src/public-contract.ts) — single source of truth for public job/prompt/resource names; not modified by this plan.
