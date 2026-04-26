# Gemini Assistant Refactor Design

## Overview

Aggressive code refactor to improve maintainability and consistency by centralizing repeated tool execution logic. This design will consolidate boilerplate out of individual tool handlers and into a shared execution pipeline, strictly without increasing the total number of files in the project.

## 1. Pipeline Wrapper (`src/lib/tool-executor.ts`)

We will create a new shared helper `executeGeminiPipeline` (or extend `ToolExecutor`) that:

- Automatically fetches the workspace cache name via `getWorkspaceCacheName`.
- Resolves standard orchestration (e.g., automatically appending `selectSearchAndUrlContextTools`).
- Manages the top-level progress reporter for the tool.
- Wraps the final call to `executor.runGeminiStream`.

## 2. Centralized File Uploads (`src/lib/file.ts`)

- Move `uploadFilesBatch` out of `src/tools/analyze.ts` into `src/lib/file.ts`.
- Expose a `withUploadsAndPipeline` helper that encapsulates `withUploadedFilesCleanup`, uploads the specified file paths (batch or single), and then hands the uploaded `Part` objects to the tool's callback to be injected into the prompt.

## 3. Refactoring Tool Implementations (`src/tools/*.ts`)

The `analyze`, `review`, and `research` tools will be stripped of their repetitive logic:

- Remove manual instantiation of `ProgressReporter`.
- Remove manual `getWorkspaceCacheName` calls.
- Remove redundant `selectSearchAndUrlContextTools` logic.
- Replace manual `uploadFile` loops with the centralized `uploadFilesBatch` pipeline.
- Tools will now purely define:
  1. What files need uploading.
  2. How the system/user prompt is built.
  3. Response extraction mapping.

## Impact

- **Behavior Preserved**: No observable semantic changes (per `refactor` skill rules).
- **Reduced LOC**: Less repetitive scaffolding.
- **Consistency**: All Gemini tools will go through identical progress reporting and orchestration validation phases.

## Prompt Runtime Alignment Note

Prompt instructions now track the runtime contract more tightly: function-calling guidance is mode-aware, research and grounded-answer prompts only mention capabilities that the resolved orchestration actually enabled, and the runtime validates or derives structured fields instead of asking the model to narrate them in prose. In particular, diagram outputs now populate `syntaxValid` and `syntaxErrors` from streamed code-execution events, and review outputs validate `documentationDrift` against the exported Zod schema before attaching it to structured content.
