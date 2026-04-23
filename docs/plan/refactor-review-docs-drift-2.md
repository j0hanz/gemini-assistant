---
goal: Refactor documentation drift detection to use server-side environment variables and existing workspace context constants
version: 1.0
date_created: 2026-04-23
owner: AI Assistant
status: 'Planned'
tags: ['refactor', 'documentation', 'review', 'mcp-tool']
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan outlines the refactoring of the recently implemented documentation drift detection feature. It removes the burden of supplying `docFilesToCheck` from the MCP client (local LLM) and instead manages the documentation targets entirely server-side. It will introduce an environment variable `REVIEW_DOCS` and fallback gracefully to the pre-existing `SCAN_FILE_NAMES` constant used by the workspace context cache.

## 1. Requirements & Constraints

- **REQ-001**: Remove `docFilesToCheck` from `ReviewInputSchema` (`src/schemas/inputs.ts`), `ReviewInput` type, and `analyzePrWork` arguments (`src/tools/review.ts`).
- **REQ-002**: Export `SCAN_FILE_NAMES` from `src/lib/workspace-context.ts` so it can be reused across the application.
- **REQ-003**: Introduce a `getReviewDocs()` configuration function in `src/config.ts` to read the `REVIEW_DOCS` environment variable (comma-separated).
- **REQ-004**: In `analyzePrWork`, dynamically resolve the files to check by preferring `getReviewDocs()` and falling back to `Array.from(SCAN_FILE_NAMES)`.
- **CON-001**: Do not alter the structure of the `<documentation_context>` injection into the prompt.
- **CON-002**: Ensure all TypeScript types are strict and tests continue to pass (e.g., catalog schema alignment).
- **PAT-001**: Use `src/config.ts` helper functions (like `parseNonEmptyStringEnv` or similar) to read environment variables.

## 2. Implementation Steps

### Implementation Phase 1: Revert Schema Additions

- GOAL-001: Remove `docFilesToCheck` from the public MCP schema so the AI agent does not have to guess document paths.

| Task     | Description                                                                                                              | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-001 | Modify `src/schemas/inputs.ts`: Remove `docFilesToCheck` from `ReviewDiffInputSchema`.                                   |           |      |
| TASK-002 | Modify `src/public-contract.ts`: Remove `docFilesToCheck?` from the inputs array for the `review` tool.                  |           |      |
| TASK-003 | Modify `src/tools/review.ts`: Remove `docFilesToCheck` from the destructured arguments of `analyzePrWork` and its usage. |           |      |

### Implementation Phase 2: Expose Constants and Configuration

- GOAL-002: Expose the `SCAN_FILE_NAMES` constant and configure `REVIEW_DOCS` environment variable parsing.

| Task     | Description                                                                                              | Completed                                                                       | Date |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---- | --- |
| TASK-004 | Modify `src/lib/workspace-context.ts`: Change `const SCAN_FILE_NAMES` to `export const SCAN_FILE_NAMES`. |                                                                                 |      |
| TASK-005 | Modify `src/config.ts`: Implement and export `getReviewDocs(): string[]                                  | undefined`which splits`process.env.REVIEW_DOCS` by commas and trims whitespace. |      |     |

### Implementation Phase 3: Update Tool Logic

- GOAL-003: Tie the configuration and constants into the review workflow.

| Task     | Description                                                                                                                                                          | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-006 | Modify `src/tools/review.ts`: Import `getReviewDocs` from `../config.js` and `SCAN_FILE_NAMES` from `../lib/workspace-context.js`.                                   |           |      |
| TASK-007 | Modify `src/tools/review.ts` inside `analyzePrWork`: Define `const docPathsToCheck = getReviewDocs() ?? Array.from(SCAN_FILE_NAMES);` and pass it to `readDocFiles`. |           |      |

## 3. Alternatives

- **ALT-001**: Use a local `.geminirc.json` workspace configuration file. **Rejected** because it introduces unnecessary overhead, configuration fatigue for end-users, and requires custom file parsing logic. The environment variable + `SCAN_FILE_NAMES` fallback is much cleaner and reuses existing heuristics.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` (No changes, but schemas must remain aligned).
- **DEP-002**: `src/config.ts` (Existing environment parsing patterns).

## 5. Files

- **FILE-001**: `src/schemas/inputs.ts`
- **FILE-002**: `src/public-contract.ts`
- **FILE-003**: `src/tools/review.ts`
- **FILE-004**: `src/lib/workspace-context.ts`
- **FILE-005**: `src/config.ts`

## 6. Testing

- **TEST-001**: Ensure `npm run type-check` passes cleanly.
- **TEST-002**: Ensure `npm run test` passes, specifically the catalog alignment test which verifies that `ReviewInputSchema` matches `public-contract.ts`.

## 7. Risks & Assumptions

- **RISK-001**: The `SCAN_FILE_NAMES` list contains some non-documentation files (e.g., `package.json`, `tsconfig.json`). Reading these files into context could be slightly noisy. However, `package.json` and `tsconfig.json` are often excellent anchors for checking structural drifts (e.g., dependency version descriptions).
