# Feature Packaging & Discoverability Plan

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements the approved packaging and discoverability design for `gemini-assistant`. The plan adds browseable discovery resources, guided onboarding prompts, read-only session transcript visibility, and matching README/package metadata without changing the server's core Gemini tool set.

## 1. Requirements & Constraints

- **REQ-001**: Add a machine-readable discovery catalog that can drive `tools://list`, `workflows://list`, prompt references, and documentation vocabulary.
- **REQ-002**: Add `tools://list` and `workflows://list` as read-only JSON resources through `src/server-content.ts` resource registration.
- **REQ-003**: Add prompt wrappers `getting-started`, `deep-research`, `project-memory`, and `diff-review` through `src/server-content.ts` prompt registration.
- **REQ-004**: Add `sessions://{sessionId}/transcript` as a read-only JSON resource with missing-session responses shaped as `{ "error": "Session not found" }`.
- **REQ-005**: Extend `src/sessions.ts` session state to carry transcript entries that live and die with the in-memory session lifecycle.
- **REQ-006**: Capture transcript entries at the `ask` tool boundary in `src/tools/ask.ts` without depending on Gemini SDK internal transcript state.
- **REQ-007**: Update `README.md` so the first-run story is workflow-based and consistent with the new MCP discovery surface.
- **REQ-008**: Update `package.json` metadata to reflect the stabilized workflow vocabulary and package positioning.
- **REQ-009**: Add automated tests for discovery resources, prompt wrappers, metadata consistency, and transcript lifecycle.
- **CON-001**: Do not add new core analysis tools, remote GitHub integrations, persistent storage, or transport redesign in this plan.
- **CON-002**: Preserve existing registrations in `src/server-registration.ts`; discovery work must layer on top of current tool coverage rather than restructure the server.
- **CON-003**: Keep JSON resource payloads deterministic and concise. Do not generate freeform prose as the canonical discovery format.
- **SEC-001**: New resources must preserve the current server model of returning safe JSON payloads rather than exposing private host data, secrets, or filesystem details.
- **PAT-001**: Reuse the existing `jsonResource(...)`, `ResourceTemplate`, and prompt-registration patterns from `src/server-content.ts`.
- **PAT-002**: Reuse the existing session change notification flow from `src/index.ts` and `src/sessions.ts` so transcript resource updates follow the same resource-update model.
- **PAT-003**: Follow the current test style based on `node:test`, `assert`, and direct module-level validation in `__tests__/`.
- **GUD-001**: Treat the approved design file `docs/superpowers/specs/2026-04-15-packaging-discoverability-design.md` as the authoritative functional scope for this plan.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Introduce a single metadata catalog module that defines discovery entries and workflow definitions used by resources, prompts, and tests.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                     | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | Create `src/catalog.ts` and define explicit TypeScript types for tool entries, prompt entries, resource entries, workflow entries, and related-item references. Include exact identifiers for the currently registered tools from `src/server-registration.ts`, prompts from `src/server-content.ts`, and resources already exposed in `src/server-content.ts`. |           |      |
| TASK-002 | Populate `src/catalog.ts` with deterministic metadata fields `name`, `kind`, `title`, `bestFor`, `whenToUse`, `inputs`, `returns`, and `related` for discovery entries, and `name`, `goal`, `whenToUse`, `steps`, `recommendedTools`, `recommendedPrompts`, and `relatedResources` for workflows.                                                               |           |      |
| TASK-003 | Add helper functions in `src/catalog.ts` for returning ordered discovery lists and ordered workflow lists so downstream resource registration does not reimplement sorting or filtering logic.                                                                                                                                                                  |           |      |
| TASK-004 | Add a focused test file `__tests__/catalog.test.ts` that validates catalog entry shape, unique names, deterministic ordering, and valid `related` references before any resource wiring is added.                                                                                                                                                               |           |      |

### Implementation Phase 2

- **GOAL-002**: Add discovery resources and workflow prompts using the catalog metadata as the single source of truth.

| Task     | Description                                                                                                                                                                                                                                                                                                                | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-005 | Update `src/server-content.ts` to import the new catalog helpers and register `tools://list` and `workflows://list` via `server.registerResource(...)` using `jsonResource(...)` and `ResourceTemplate`.                                                                                                                   |           |      |
| TASK-006 | Extend `registerResources(server)` in `src/server-content.ts` so the new resources are registered alongside the existing session and cache resources without removing `sessions://list`, `sessions://{sessionId}`, `caches://list`, or `caches://{cacheName}`.                                                             |           |      |
| TASK-007 | Add prompt registrations for `getting-started`, `deep-research`, `project-memory`, and `diff-review` in `src/server-content.ts` using the existing `userPromptMessage(...)` pattern. Each prompt body must explicitly reference the recommended tools, recommended prompts, and resource URIs defined in `src/catalog.ts`. |           |      |
| TASK-008 | Keep prompt schemas explicit in `src/server-content.ts`. Define exact input arguments for any wrapper prompt that needs them, and keep `getting-started` argument-free if no variables are required.                                                                                                                       |           |      |
| TASK-009 | Update `__tests__/tools/registration.test.ts` so it still validates full registration while covering the expanded prompt and resource set.                                                                                                                                                                                 |           |      |
| TASK-010 | Add a new test file `__tests__/resources.test.ts` that exercises `tools://list` and `workflows://list` resource read behavior, payload shape, and deterministic ordering.                                                                                                                                                  |           |      |
| TASK-011 | Extend `__tests__/prompts.test.ts` or split prompt coverage into additional files so the new prompt schemas and message builders are validated in the same style as `code-review`, `summarize`, and `explain-error`.                                                                                                       |           |      |

### Implementation Phase 3

- **GOAL-003**: Add in-memory session transcript support and expose it through a read-only transcript resource.

| Task     | Description                                                                                                                                                                                                                                                                                  | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-012 | Extend `src/sessions.ts` by updating `SessionEntry` to include a transcript collection with entries containing `role`, `text`, `timestamp`, and optional `taskId`. Add exported helper functions for transcript append, transcript read, and transcript-aware session removal.               |           |      |
| TASK-013 | Update `setSession(...)`, `getSession(...)`, eviction helpers, and expiry handling in `src/sessions.ts` so transcript state is stored with the session and removed automatically when the session is evicted or expires.                                                                     |           |      |
| TASK-014 | Update `src/server-content.ts` to register `sessions://{sessionId}/transcript` using `ResourceTemplate`. Reuse the existing `completeSessionIds` completion flow and return `{ "error": "Session not found" }` when the transcript target is absent.                                         |           |      |
| TASK-015 | Update `src/index.ts` resource-change emission so transcript detail URIs are included when session changes occur, allowing subscribed clients to observe transcript updates through existing resource update notifications.                                                                  |           |      |
| TASK-016 | Add or update tests in `__tests__/sessions.test.ts` to validate transcript initialization, transcript append, transcript removal on expiry, and transcript removal on LRU eviction. Add direct resource-read tests for `sessions://{sessionId}/transcript` in `__tests__/resources.test.ts`. |           |      |

### Implementation Phase 4

- **GOAL-004**: Capture transcript entries at the `ask` boundary and keep transcript behavior independent from Gemini SDK internals.

| Task     | Description                                                                                                                                                                                                                                                                    | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-017 | Update `src/tools/ask.ts` to append a user transcript entry when a message is accepted for a new or existing session. The write must happen at the server boundary using the request message string rather than Gemini internal chat history.                                  |           |      |
| TASK-018 | Update `src/tools/ask.ts` to append an assistant transcript entry when a non-error final answer is produced. Reuse the existing final text extraction path from `formatStructuredResult(...)` or a nearby helper so the stored assistant text matches the user-visible answer. |           |      |
| TASK-019 | Ensure transcript append behavior works for both `askNewSession(...)` and `askExistingSession(...)` flows and does not store entries for failed session creation or failed result generation.                                                                                  |           |      |
| TASK-020 | Add targeted tests covering transcript capture for first-turn and subsequent-turn `ask` flows. Create a new test file `__tests__/tools/ask-transcript.test.ts` if the existing `ask` area lacks direct test coverage.                                                          |           |      |

### Implementation Phase 5

- **GOAL-005**: Align repository documentation and package metadata with the new onboarding and discovery surface.

| Task     | Description                                                                                                                                                                                                                                                                            | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-021 | Rewrite `README.md` to start with the first-run workflow. Add sections for `Start here`, `Common jobs`, `Sessions versus caches`, and the new discovery resources `tools://list`, `workflows://list`, and `sessions://{sessionId}/transcript`.                                         |           |      |
| TASK-022 | Add a minimal environment example and a concise MCP client setup snippet to `README.md` that matches the actual package scripts and transport modes already defined in `package.json` and `src/index.ts`.                                                                              |           |      |
| TASK-023 | Update `package.json` metadata by adding or refining `repository`, `keywords`, `license`, `files`, and `exports` fields so package positioning matches the new README and MCP discovery language. Do not change runtime dependencies in this task.                                     |           |      |
| TASK-024 | Add a documentation regression check by updating or creating tests that verify new resource and prompt names listed in `README.md` and package metadata exist in code. If no automated doc consistency check is practical, document that manual verification is required before merge. |           |      |

### Implementation Phase 6

- **GOAL-006**: Verify the full packaging/discoverability release through repository checks and consistency enforcement.

| Task     | Description                                                                                                                                                                                                                                                                           | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-025 | Run `npm run lint` and resolve all issues caused by the new catalog, prompt, resource, transcript, README, and package metadata changes.                                                                                                                                              |           |      |
| TASK-026 | Run `npm run type-check` and resolve all type errors, including any new catalog typing, resource typing, and session transcript typing.                                                                                                                                               |           |      |
| TASK-027 | Run `npm run test` and ensure the new catalog, resource, prompt, and transcript lifecycle tests pass alongside the existing suite.                                                                                                                                                    |           |      |
| TASK-028 | Perform a final consistency audit that checks every discovery entry in `src/catalog.ts` against real registrations in `src/server-registration.ts` and `src/server-content.ts`, then verify the README names the same public surface. Capture any mismatch as a blocker before merge. |           |      |

## 3. Alternatives

- **ALT-001**: Generate discovery output directly from registration strings in `src/server-registration.ts` and `src/server-content.ts`. Rejected because the current registration strings are insufficient for product-facing fields like `bestFor`, `whenToUse`, and workflow step definitions.
- **ALT-002**: Store session transcripts by introspecting the Gemini `Chat` object. Rejected because SDK internals are not controlled by this repository and would make transcript behavior fragile.
- **ALT-003**: Skip prompt wrappers and rely only on README documentation. Rejected because the approved design prioritizes in-client discoverability for MCP users rather than repo-only discoverability.
- **ALT-004**: Expand this initiative to include new tools such as `review_code` or `summarize_text`. Rejected because the approved design explicitly limits scope to packaging and discoverability.

## 4. Dependencies

- **DEP-001**: `src/server-content.ts` remains the primary registration site for prompts and resources and must stay compatible with the new catalog-driven additions.
- **DEP-002**: `src/sessions.ts` is the authoritative source for in-memory session lifecycle and must be extended rather than bypassed.
- **DEP-003**: `src/tools/ask.ts` is the authoritative boundary for multi-turn session creation and must own transcript writes.
- **DEP-004**: `src/index.ts` currently broadcasts session resource updates and must include any new transcript resource URIs that need refresh notifications.
- **DEP-005**: The existing test runner in `package.json` and current `node:test` style in `__tests__/` remain the verification mechanism for this plan.

## 5. Files

- **FILE-001**: `src/catalog.ts` — new metadata catalog for discovery entries and workflows.
- **FILE-002**: `src/server-content.ts` — new discovery resources and workflow prompts.
- **FILE-003**: `src/sessions.ts` — session transcript storage and transcript helper APIs.
- **FILE-004**: `src/tools/ask.ts` — transcript capture at the request/response boundary.
- **FILE-005**: `src/index.ts` — session resource update emission for transcript URIs.
- **FILE-006**: `src/server-registration.ts` — registration list validation impact only; update only if explicit discovery registration naming needs alignment.
- **FILE-007**: `README.md` — workflow-first onboarding and discovery documentation.
- **FILE-008**: `package.json` — package metadata alignment for distribution and discoverability.
- **FILE-009**: `__tests__/catalog.test.ts` — new catalog validation coverage.
- **FILE-010**: `__tests__/resources.test.ts` — new resource read behavior coverage.
- **FILE-011**: `__tests__/prompts.test.ts` — prompt schema/message coverage for new wrappers, or equivalent split prompt test files.
- **FILE-012**: `__tests__/sessions.test.ts` — transcript lifecycle coverage.
- **FILE-013**: `__tests__/tools/registration.test.ts` — registration alignment checks for new prompts/resources.
- **FILE-014**: `__tests__/tools/ask-transcript.test.ts` — direct transcript capture tests if needed.
- **FILE-015**: `docs/superpowers/specs/2026-04-15-packaging-discoverability-design.md` — approved design reference for plan execution.

## 6. Testing

- **TEST-001**: Validate `src/catalog.ts` entry structure, ordering, unique names, and valid cross-references.
- **TEST-002**: Validate `tools://list` JSON payload structure and deterministic contents.
- **TEST-003**: Validate `workflows://list` JSON payload structure, workflow ordering, and `getting-started` default-first position.
- **TEST-004**: Validate new prompt schemas and generated prompt messages for `getting-started`, `deep-research`, `project-memory`, and `diff-review`.
- **TEST-005**: Validate `sessions://{sessionId}/transcript` read behavior for active sessions and missing sessions.
- **TEST-006**: Validate transcript creation on first multi-turn `ask` call.
- **TEST-007**: Validate transcript append on later multi-turn `ask` calls.
- **TEST-008**: Validate transcript removal on session expiry.
- **TEST-009**: Validate transcript removal on session eviction.
- **TEST-010**: Run `npm run lint`.
- **TEST-011**: Run `npm run type-check`.
- **TEST-012**: Run `npm run test`.

## 7. Risks & Assumptions

- **RISK-001**: Catalog metadata can drift from the real registration surface if updates land in one place only. Mitigation: add explicit consistency tests and make `src/catalog.ts` the only discovery source.
- **RISK-002**: Session transcript writes can accidentally capture partial or duplicate assistant responses if inserted at the wrong point in `src/tools/ask.ts`. Mitigation: append only after final non-error output is finalized.
- **RISK-003**: Extending session state can worsen current test coupling because `__tests__/sessions.test.ts` already relies on module-level state. Mitigation: keep transcript lifecycle tests deterministic and isolate fresh imports where needed.
- **RISK-004**: README and package metadata can lag behind code changes late in the implementation. Mitigation: keep documentation and metadata in a dedicated final phase and block completion on alignment checks.
- **ASSUMPTION-001**: Existing MCP clients can consume additional resources and prompts without transport changes.
- **ASSUMPTION-002**: The current `ask` tool remains the only place where multi-turn chat sessions are created and resumed.
- **ASSUMPTION-003**: No external persistence requirement will be introduced during execution of this plan.

## 8. Related Specifications / Further Reading

- [docs/superpowers/specs/2026-04-15-packaging-discoverability-design.md](/abs/path/c:/gemini-assistant/docs/superpowers/specs/2026-04-15-packaging-discoverability-design.md)
- [src/server-content.ts](/abs/path/c:/gemini-assistant/src/server-content.ts)
- [src/sessions.ts](/abs/path/c:/gemini-assistant/src/sessions.ts)
- [src/tools/ask.ts](/abs/path/c:/gemini-assistant/src/tools/ask.ts)
- [README.md](/abs/path/c:/gemini-assistant/README.md)
