---
goal: Refactor Gemini Tools Pipeline
version: 1.0
date_created: 2026-04-26
owner: Gemini Assistant
status: 'Completed'
tags: [refactor, architecture, code-quality]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan outlines the steps to aggressively refactor the execution logic of the Gemini tools (`analyze`, `review`, `research`) to improve maintainability and consistency without adding new files. It achieves this by centralizing repetitive progress reporting, file uploading, workspace caching, and orchestration behaviors into a new shared execution pipeline wrapper in the `tool-executor` and `file` libraries.

## 1. Requirements & Constraints

- **REQ-001**: Move `uploadFilesBatch` from `src/tools/analyze.ts` to `src/lib/file.ts`.
- **REQ-002**: Centralize the cache fetching (`getWorkspaceCacheName`) into `src/lib/tool-executor.ts`.
- **REQ-003**: Create a new wrapper `executeGeminiPipeline` in `src/lib/tool-executor.ts` that handles caching, base orchestration (search/url), progress reporting, and runs `executor.runGeminiStream`.
- **CON-001**: Do not increase the total number of files in the project.
- **CON-002**: Zero observable behavior change.

## 2. Implementation Steps

### Implementation Phase 1: File Library Updates

- GOAL-001: Extract and adapt file upload logic to `src/lib/file.ts`.

| Task     | Description                                                                                            | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-001 | Move `uploadFilesBatch` from `analyze.ts` to `lib/file.ts`, adding automatic ProgressReporter updates. | ✅        | 2026-04-26 |
| TASK-002 | Expose `withUploadsAndPipeline` in `lib/file.ts` to simplify cleanup.                                  | ✅        | 2026-04-26 |

### Implementation Phase 2: Pipeline Wrapper

- GOAL-002: Enhance the `tool-executor` to automatically handle shared orchestration and caching.

| Task     | Description                                                                                                                | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-003 | Inject `WorkspaceCacheManager` into `executor` instantiation, or accept it inside `GeminiStreamRequest`.                   | ✅        | 2026-04-26 |
| TASK-004 | Add `executeGeminiPipeline` to `ToolExecutor` that automates `selectSearchAndUrlContextTools` and `getWorkspaceCacheName`. | ✅        | 2026-04-26 |

### Implementation Phase 3: Tool Refactoring

- GOAL-003: Simplify tool files to only handle data flow and prompt construction.

| Task     | Description                                                                         | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-005 | Refactor `src/tools/analyze.ts` to use `executeGeminiPipeline` and central uploads. | ✅        | 2026-04-26 |
| TASK-006 | Refactor `src/tools/review.ts` to use `executeGeminiPipeline` and central uploads.  | ✅        | 2026-04-26 |
| TASK-007 | Refactor `src/tools/research.ts` (if applicable) to use the new pipelines.          | ✅        | 2026-04-26 |

## 3. Alternatives

- **ALT-001**: Create a base class for tools. Rejected because it breaks from the codebase's existing functional paradigm.
- **ALT-002**: Minimal helper extraction. Rejected as not aggressive enough to achieve desired maintainability.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` contexts and tasks.
- **DEP-002**: Zod for validation schemas.

## 5. Files

- **FILE-001**: `src/lib/file.ts`
- **FILE-002**: `src/lib/tool-executor.ts`
- **FILE-003**: `src/tools/analyze.ts`
- **FILE-004**: `src/tools/review.ts`
- **FILE-005**: `src/tools/research.ts`

## 6. Testing

- **TEST-001**: Run `npm run test` to verify behavior remains identical.
- **TEST-002**: Use `npm run lint` and `npm run type-check` to verify strict nulls and imports.

## 7. Risks & Assumptions

- **RISK-001**: Moving `WorkspaceCacheManager` resolution into the executor might require passing the dependency up to `src/server.ts` or passing it through the pipeline explicitly.
- **ASSUMPTION-001**: All tools share identical progress labeling formats that can be generalized.

## 8. Related Specifications / Further Reading

[docs/specs/2026-04-26-refactor-design.md](docs/specs/2026-04-26-refactor-design.md)
