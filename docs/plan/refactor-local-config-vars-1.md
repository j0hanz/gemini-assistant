---
goal: Rewrite local environment variable surface with short config names
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, config, breaking-change, local]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

This plan implemented the local-first config rewrite specified in `docs/specs/2026-04-22-local-config-vars-design.md`. The change is intentionally breaking: old long environment variable names were removed with no alias fallback, and the normal local config surface is now `API_KEY`, `MODEL`, `ROOTS`, `CONTEXT`, `AUTO_SCAN`, `CACHE`, `CACHE_TTL`, `THOUGHTS`, `LOG_PAYLOADS`, `TRANSPORT`, `HOST`, and `PORT`.

## 1. Requirements & Constraints

- **REQ-001**: `API_KEY` MUST remain the required Gemini API key variable.
- **REQ-002**: `MODEL` MUST replace `GEMINI_MODEL` and default to `gemini-3-flash-preview`.
- **REQ-003**: `THOUGHTS` MUST replace `GEMINI_EXPOSE_THOUGHTS` and default to `false`.
- **REQ-004**: `ROOTS` MUST replace `ALLOWED_FILE_ROOTS` for comma-separated allowed file roots.
- **REQ-005**: `CONTEXT` MUST replace `WORKSPACE_CONTEXT_FILE`.
- **REQ-006**: `AUTO_SCAN` MUST replace `WORKSPACE_AUTO_SCAN` and default to `true`.
- **REQ-007**: `CACHE` MUST replace `WORKSPACE_CACHE_ENABLED` and default to `false`.
- **REQ-008**: `CACHE_TTL` MUST replace `WORKSPACE_CACHE_TTL` and default to `3600s`.
- **REQ-009**: `LOG_PAYLOADS` MUST replace `LOG_VERBOSE_PAYLOADS` and default to `false`.
- **REQ-010**: `TRANSPORT`, `HOST`, and `PORT` MUST replace `MCP_TRANSPORT`, `MCP_HTTP_HOST`, and `MCP_HTTP_PORT`.
- **REQ-011**: Old variables MUST have no effect when set: `GEMINI_MODEL`, `GEMINI_EXPOSE_THOUGHTS`, `ALLOWED_FILE_ROOTS`, `WORKSPACE_CONTEXT_FILE`, `WORKSPACE_AUTO_SCAN`, `WORKSPACE_CACHE_ENABLED`, `WORKSPACE_CACHE_TTL`, `LOG_VERBOSE_PAYLOADS`, `MCP_TRANSPORT`, `MCP_HTTP_HOST`, and `MCP_HTTP_PORT`.
- **REQ-012**: Hosted/server-only env controls MUST be removed from the public env surface: `MCP_CORS_ORIGIN`, `MCP_ALLOWED_HOSTS`, `MCP_STATELESS`, `MCP_MAX_TRANSPORT_SESSIONS`, `MCP_TRANSPORT_SESSION_TTL_MS`, `MAX_SESSIONS`, `SESSION_TTL_MS`, `MAX_SESSION_EVENT_ENTRIES`, and `MAX_SESSION_TRANSCRIPT_ENTRIES`.
- **SEC-001**: `API_KEY` MUST NOT be logged, exposed in resources, or included in errors beyond the missing-key variable name.
- **SEC-002**: File-root validation error text MUST mention `ROOTS`, not `ALLOWED_FILE_ROOTS`.
- **CON-001**: Do not add JSON/YAML/TOML config files.
- **CON-002**: Do not add backward-compatible aliases.
- **CON-003**: Do not add global env vars for per-request settings such as temperature, max output tokens, or seed.
- **CON-004**: Do not install dependencies.
- **GUD-001**: Keep all environment reads centralized in `src/config.ts`.
- **GUD-002**: Use strict boolean parsing: only literal `true` and `false` are valid when a boolean variable is set.
- **GUD-003**: Use non-empty string parsing for `MODEL` and `HOST`.
- **GUD-004**: Follow AGENTS.md validation order: `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`.

## 2. Implementation Steps

### Implementation Phase 1 — Config module rewrite

- GOAL-001: Replace the public environment variable names in `src/config.ts` and keep internal defaults deterministic.

| Task     | Description                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/config.ts`, add exported `getApiKey(): string` that reads `process.env.API_KEY`, trims only for emptiness validation, and throws `API_KEY environment variable is required.` when absent or blank.                                  | ✅        | 2026-04-22 |
| TASK-002 | In `src/config.ts`, change `getGeminiModel()` to return `parseNonEmptyStringEnv('MODEL', DEFAULT_MODEL)` and stop reading `process.env.GEMINI_MODEL`.                                                                                       | ✅        | 2026-04-22 |
| TASK-003 | In `src/config.ts`, change `getExposeThoughts()` to return `parseBooleanEnv('THOUGHTS', false)` and stop reading `process.env.GEMINI_EXPOSE_THOUGHTS`.                                                                                      | ✅        | 2026-04-22 |
| TASK-004 | In `src/config.ts`, change `getVerbosePayloadLogging()` to return `parseBooleanEnv('LOG_PAYLOADS', false)` and stop reading `LOG_VERBOSE_PAYLOADS`.                                                                                         | ✅        | 2026-04-22 |
| TASK-005 | In `src/config.ts`, change `parseTransportModeEnv()` to read `process.env.TRANSPORT ?? DEFAULT_TRANSPORT`; update its error text to `TRANSPORT must be one of: stdio, http, web-standard.`                                                  | ✅        | 2026-04-22 |
| TASK-006 | In `src/config.ts`, change `getTransportConfig()` to read `HOST` and `PORT`; remove `MCP_CORS_ORIGIN`, `MCP_STATELESS`, `MCP_MAX_TRANSPORT_SESSIONS`, and `MCP_TRANSPORT_SESSION_TTL_MS` from env parsing.                                  | ✅        | 2026-04-22 |
| TASK-007 | In `src/config.ts`, keep required `TransportConfig` fields by returning internal constants for `corsOrigin: ''`, `isStateless: false`, `maxSessions: DEFAULT_MAX_TRANSPORT_SESSIONS`, and `sessionTtlMs: DEFAULT_TRANSPORT_SESSION_TTL_MS`. | ✅        | 2026-04-22 |
| TASK-008 | In `src/config.ts`, change `getAllowedFileRootsEnv()` to read `process.env.ROOTS` and rename it to `getRootsEnv()` if no external imports require the old function name after Phase 2.                                                      | ✅        | 2026-04-22 |
| TASK-009 | In `src/config.ts`, remove `getAllowedHostsEnv()` or make it return `undefined` without reading any env variable; update all imports in Phase 2 accordingly.                                                                                | ✅        | 2026-04-22 |
| TASK-010 | In `src/config.ts`, change workspace getters to read `CACHE`, `CONTEXT`, `CACHE_TTL`, and `AUTO_SCAN`; use `parseBooleanEnv('CACHE', false)` and `parseBooleanEnv('AUTO_SCAN', true)`.                                                      | ✅        | 2026-04-22 |
| TASK-011 | In `src/config.ts`, keep session limit defaults as internal constants returned by `getSessionLimits()` and remove reads of `MAX_SESSIONS`, `SESSION_TTL_MS`, `MAX_SESSION_EVENT_ENTRIES`, and `MAX_SESSION_TRANSCRIPT_ENTRIES`.             | ✅        | 2026-04-22 |

### Implementation Phase 2 — Runtime consumer updates

- GOAL-002: Route all runtime config consumers through the rewritten config module and remove old env names from user-facing messages.

| Task     | Description                                                                                                                                                                                                | Completed              | Date               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------ | ----------- | -------------------- | ----- | ----------- | ---------------------------------------------------------------------------------- | --- | ---------- |
| TASK-012 | In `src/client.ts`, import `getApiKey` from `./config.js` and replace direct `process.env.API_KEY` access in `getAI()` with `const apiKey = getApiKey();`.                                                 | ✅                     | 2026-04-22         |
| TASK-013 | In `src/lib/validation.ts`, replace import `getAllowedFileRootsEnv, getAllowedHostsEnv` with the new config API from Phase 1.                                                                              | ✅                     | 2026-04-22         |
| TASK-014 | In `src/lib/validation.ts`, update `getEnvRoots()` to read `ROOTS` through config and preserve existing fallback to `[normalize(process.cwd())]` when unset or empty.                                      | ✅                     | 2026-04-22         |
| TASK-015 | In `src/lib/validation.ts`, remove explicit allowed-host env support from `parseAllowedHosts()`; make it return `undefined` unless an internal non-env constant is introduced in `src/config.ts`.          | ✅                     | 2026-04-22         |
| TASK-016 | In `src/lib/validation.ts`, update host-validation comments to remove references to `MCP_ALLOWED_HOSTS`.                                                                                                   | ✅                     | 2026-04-22         |
| TASK-017 | In `src/lib/validation.ts`, change the out-of-roots error from `Set ALLOWED_FILE_ROOTS to expand access.` to `Set ROOTS to expand access.`                                                                 | ✅                     | 2026-04-22         |
| TASK-018 | In `src/transport.ts`, update warning/help text that currently references `MCP_ALLOWED_HOSTS`; remove instructions for that deleted env var and keep warnings focused on local `HOST`.                     | ✅                     | 2026-04-22         |
| TASK-019 | In `src/resources.ts`, verify the server context dashboard still reports model, thoughts, workspace cache, and auto-scan using the rewritten getters; make no display changes unless old env names appear. | ✅                     | 2026-04-22         |
| TASK-020 | Run `rg -n "process\\.env" src` and verify remaining direct env reads are only inside `src/config.ts`. Move any remaining reads into `src/config.ts`.                                                      | ✅                     | 2026-04-22         |
| TASK-021 | Run `rg -n "GEMINI_MODEL                                                                                                                                                                                   | GEMINI_EXPOSE_THOUGHTS | ALLOWED_FILE_ROOTS | WORKSPACE\_ | LOG_VERBOSE_PAYLOADS | MCP\_ | MAX_SESSION | SESSION_TTL_MS" src` and remove or rewrite all references to old public env names. | ✅  | 2026-04-22 |

### Implementation Phase 3 — Test migration

- GOAL-003: Update tests to assert the new env names and confirm old names have no effect.

| Task     | Description                                                                                                                                                                                                                                                                                               | Completed              | Date               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------ | ----------- | -------------------- | ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | --- | ---------- |
| TASK-022 | In `__tests__/config.test.ts`, replace the `afterEach` cleanup list with new variables: `API_KEY`, `MODEL`, `THOUGHTS`, `LOG_PAYLOADS`, `TRANSPORT`, `HOST`, `PORT`, `ROOTS`, `CONTEXT`, `AUTO_SCAN`, `CACHE`, and `CACHE_TTL`; also delete old variables to prevent cross-test pollution checks.         | ✅                     | 2026-04-22         |
| TASK-023 | In `__tests__/config.test.ts`, update invalid transport mode, invalid port, and empty host tests to use `TRANSPORT`, `PORT`, and `HOST`; update expected regexes to the new names.                                                                                                                        | ✅                     | 2026-04-22         |
| TASK-024 | In `__tests__/config.test.ts`, replace verbose payload tests with `LOG_PAYLOADS`; add invalid boolean coverage for `THOUGHTS`, `CACHE`, and `AUTO_SCAN`.                                                                                                                                                  | ✅                     | 2026-04-22         |
| TASK-025 | In `__tests__/config.test.ts`, add tests for `getGeminiModel()` default, valid `MODEL`, and empty `MODEL` rejection.                                                                                                                                                                                      | ✅                     | 2026-04-22         |
| TASK-026 | In `__tests__/config.test.ts`, add tests for `getWorkspaceCacheEnabled()`, `getWorkspaceContextFile()`, `getWorkspaceCacheTtl()`, and `getWorkspaceAutoScan()` using `CACHE`, `CONTEXT`, `CACHE_TTL`, and `AUTO_SCAN`.                                                                                    | ✅                     | 2026-04-22         |
| TASK-027 | In `__tests__/config.test.ts`, add a no-alias test that sets old names such as `GEMINI_MODEL`, `WORKSPACE_CACHE_ENABLED`, and `MCP_TRANSPORT`, leaves new names unset, and asserts defaults still apply.                                                                                                  | ✅                     | 2026-04-22         |
| TASK-028 | In workspace-context tests under `__tests__/lib/workspace-context.test.ts`, replace `WORKSPACE_AUTO_SCAN` with `AUTO_SCAN`, `WORKSPACE_CONTEXT_FILE` with `CONTEXT`, and `WORKSPACE_CACHE_ENABLED` with `CACHE`.                                                                                          | ✅                     | 2026-04-22         |
| TASK-029 | In file-root and validation tests under `__tests__/e2e.test.ts`, `__tests__/resources.test.ts`, `__tests__/lib/validation.test.ts`, and `__tests__/tools/ask.test.ts`, replace `ALLOWED_FILE_ROOTS` with `ROOTS` and expected error text with `ROOTS`.                                                    | ✅                     | 2026-04-22         |
| TASK-030 | In logger tests under `__tests__/lib/logger.test.ts`, replace `LOG_VERBOSE_PAYLOADS` with `LOG_PAYLOADS`.                                                                                                                                                                                                 | ✅                     | 2026-04-22         |
| TASK-031 | In transport tests under `__tests__/transport.test.ts` and `__tests__/transport-host-validation.test.ts`, replace `MCP_HTTP_HOST` with `HOST` and `MCP_HTTP_PORT` with `PORT`; remove or rewrite tests that assert deleted CORS, allowed-host env, stateless env, and transport session TTL env behavior. | ✅                     | 2026-04-22         |
| TASK-032 | In notification and ask transcript tests, replace `WORKSPACE_CACHE_ENABLED`, `WORKSPACE_CONTEXT_FILE`, and `ALLOWED_FILE_ROOTS` with `CACHE`, `CONTEXT`, and `ROOTS`.                                                                                                                                     | ✅                     | 2026-04-22         |
| TASK-033 | Run `rg -n "GEMINI_MODEL                                                                                                                                                                                                                                                                                  | GEMINI_EXPOSE_THOUGHTS | ALLOWED_FILE_ROOTS | WORKSPACE\_ | LOG_VERBOSE_PAYLOADS | MCP\_ | MAX_SESSION | SESSION_TTL_MS" **tests**` and update every remaining old-name reference unless the test intentionally verifies no-alias behavior. | ✅  | 2026-04-22 |

### Implementation Phase 4 — Documentation migration

- GOAL-004: Update docs to present the local-first config surface and remove old env names from user instructions.

| Task     | Description                                                                                                                                              | Completed              | Date               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------ | ----------- | -------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --- | ---------- |
| TASK-034 | In `README.md`, change the minimal `.env` example to use `API_KEY` and `TRANSPORT=stdio`.                                                                | ✅                     | 2026-04-22         |
| TASK-035 | In `README.md`, replace the optional variable list with the new local config groups: required, model, workspace, cache, debug, optional local transport. | ✅                     | 2026-04-22         |
| TASK-036 | In `README.md`, remove host-validation documentation that instructs users to set `MCP_ALLOWED_HOSTS`.                                                    | ✅                     | 2026-04-22         |
| TASK-037 | In `README.md`, update HTTP transport command from `MCP_TRANSPORT=http npx tsx src/index.ts` to `TRANSPORT=http npx tsx src/index.ts`.                   | ✅                     | 2026-04-22         |
| TASK-038 | In `README.md`, update MCP client setup JSON to use `TRANSPORT`, not `MCP_TRANSPORT`.                                                                    | ✅                     | 2026-04-22         |
| TASK-039 | Run `rg -n "GEMINI_MODEL                                                                                                                                 | GEMINI_EXPOSE_THOUGHTS | ALLOWED_FILE_ROOTS | WORKSPACE\_ | LOG_VERBOSE_PAYLOADS | MCP\_ | MAX_SESSION | SESSION_TTL_MS" README.md docs AGENTS.md` and remove or explicitly mark old names only where documenting the breaking change is necessary. | ✅  | 2026-04-22 |

### Implementation Phase 5 — Validation

- GOAL-005: Prove the refactor is complete and the repository remains healthy.

| Task     | Description                          | Completed              | Date               |
| -------- | ------------------------------------ | ---------------------- | ------------------ | ----------- | -------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------- |
| TASK-040 | Run `npm run format`.                | ✅                     | 2026-04-22         |
| TASK-041 | Run `npm run lint`.                  | ✅                     | 2026-04-22         |
| TASK-042 | Run `npm run type-check`.            | ✅                     | 2026-04-22         |
| TASK-043 | Run `npm run test`.                  | ✅                     | 2026-04-22         |
| TASK-044 | Run final grep: `rg -n "GEMINI_MODEL | GEMINI_EXPOSE_THOUGHTS | ALLOWED_FILE_ROOTS | WORKSPACE\_ | LOG_VERBOSE_PAYLOADS | MCP\_ | MAX_SESSION | SESSION_TTL_MS" src **tests** README.md docs`; confirm remaining hits are only in the spec/plan or intentional breaking-change notes. | ✅  | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Keep old long names as aliases while adding short names. Rejected: user explicitly requested a complete rewrite and no backward-compatible aliases.
- **ALT-002**: Rename every config getter to match the new env names. Rejected as mandatory work: external module behavior matters more than getter names. Rename only where it improves clarity and does not create churn.
- **ALT-003**: Remove HTTP/web-standard transport support completely. Rejected: the approved design keeps optional local `TRANSPORT`, `HOST`, and `PORT`.
- **ALT-004**: Keep hosted env controls such as CORS and allowed hosts under new short names. Rejected: local usage does not need them, and they would expand the config surface beyond the approved design.

## 4. Dependencies

- **DEP-001**: Node.js `process.env`; no new runtime dependency.
- **DEP-002**: Existing `src/config.ts` parser helpers: `parseBooleanEnv`, `parseIntEnv`, `parseNonEmptyStringEnv`.
- **DEP-003**: Existing test runner configured by `npm run test`.
- **DEP-004**: Existing README and MCP client examples; no external documentation dependency.

## 5. Files

- **FILE-001**: `src/config.ts` — central env rewrite, parser use, defaults, API key getter.
- **FILE-002**: `src/client.ts` — replace direct API key env read with `getApiKey()`.
- **FILE-003**: `src/lib/validation.ts` — `ROOTS` integration, host env removal, error text update.
- **FILE-004**: `src/transport.ts` — local transport warning/help text update.
- **FILE-005**: `src/resources.ts` — verify config dashboard compatibility.
- **FILE-006**: `src/lib/workspace-context.ts` — no direct env reads expected; verify getter behavior through updated config.
- **FILE-007**: `src/lib/logger.ts` — no direct env reads expected; verify `LOG_PAYLOADS` flows through config.
- **FILE-008**: `__tests__/config.test.ts` — primary config parser regression suite.
- **FILE-009**: `__tests__/lib/workspace-context.test.ts` — workspace env rename migration.
- **FILE-010**: `__tests__/lib/validation.test.ts` — roots rename and no-alias validation.
- **FILE-011**: `__tests__/transport.test.ts` and `__tests__/transport-host-validation.test.ts` — transport env rename and hosted-control test removal.
- **FILE-012**: `__tests__/e2e.test.ts`, `__tests__/notifications.e2e.test.ts`, `__tests__/resources.test.ts`, `__tests__/tools/ask.test.ts`, `__tests__/tools/ask-transcript.test.ts`, and `__tests__/lib/logger.test.ts` — affected env setup migration.
- **FILE-013**: `README.md` — local-first environment documentation.
- **FILE-014**: `docs/specs/2026-04-22-local-config-vars-design.md` — source specification, read-only.

## 6. Testing

- **TEST-001**: `getApiKey()` throws `API_KEY environment variable is required.` when `API_KEY` is unset or blank.
- **TEST-002**: `getGeminiModel()` returns default model when `MODEL` is unset and returns the configured non-empty `MODEL` value when set.
- **TEST-003**: `getGeminiModel()` rejects blank `MODEL`.
- **TEST-004**: `getExposeThoughts()` accepts only `THOUGHTS=true` and `THOUGHTS=false`; rejects `yes`.
- **TEST-005**: `getWorkspaceCacheEnabled()` accepts only `CACHE=true` and `CACHE=false`; rejects `yes`; defaults to `false`.
- **TEST-006**: `getWorkspaceAutoScan()` accepts only `AUTO_SCAN=true` and `AUTO_SCAN=false`; rejects `yes`; defaults to `true`.
- **TEST-007**: `getVerbosePayloadLogging()` accepts only `LOG_PAYLOADS=true` and `LOG_PAYLOADS=false`; rejects `yes`; defaults to `false`.
- **TEST-008**: `getTransportMode()` accepts `TRANSPORT=stdio`, `TRANSPORT=http`, and `TRANSPORT=web-standard`; rejects `TRANSPORT=socket`.
- **TEST-009**: `getTransportConfig()` accepts `HOST` and `PORT`, rejects blank `HOST`, rejects non-integer `PORT`, and rejects out-of-range `PORT`.
- **TEST-010**: Old env vars set alone do not change config outputs.
- **TEST-011**: File-root validation uses `ROOTS` and emits error text naming `ROOTS`.
- **TEST-012**: Existing workspace cache, notification, task, resource, transport, and tool tests pass after env-name migration.
- **TEST-013**: Full validation commands pass: `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test`.

## 7. Risks & Assumptions

- **RISK-001**: Removing hosted env controls may break tests that currently exercise CORS, stateless HTTP, and explicit allowed-host behavior. Mitigation: rewrite those tests around the retained local behavior or delete tests for removed public config.
- **RISK-002**: `MODEL` and `THOUGHTS` are evaluated at module import time in `src/client.ts` via exported constants. Mitigation: tests that modify those vars must import modules in isolated processes or assert through `src/config.ts` getters instead of already-imported constants.
- **RISK-003**: The package test command loads `.env`; a local `.env` with old names could mask missing test setup. Mitigation: config tests must delete both old and new variable names in `afterEach`.
- **RISK-004**: Short names such as `PORT` and `HOST` can collide with parent shell variables. Mitigation: local MCP client env blocks are scoped to this server; README should show explicit values.
- **ASSUMPTION-001**: The project is optimized for local MCP use, not hosted deployment.
- **ASSUMPTION-002**: Existing internal defaults for session limits and transport session TTL can remain unchanged as constants.
- **ASSUMPTION-003**: No downstream consumer depends on old env names after this breaking change.

## 8. Related Specifications / Further Reading

- `docs/specs/2026-04-22-local-config-vars-design.md` — approved design for the breaking local config rewrite.
- `src/config.ts` — current central config module.
- `src/client.ts` — Gemini client construction and model constants.
- `src/lib/validation.ts` — roots and host validation.
- `README.md` — user-facing local setup instructions.
- `AGENTS.md` — repository validation and safety checklist.
