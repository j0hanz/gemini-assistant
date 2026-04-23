---
goal: Implement documentation drift detection in the PR review tool
version: 1.0
date_created: 2026-04-23
owner: AI Assistant
status: 'Planned'
tags: ['feature', 'documentation', 'review', 'mcp-tool']
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan outlines the implementation of a documentation drift detection mechanism within the `gemini-assistant` MCP `review` tool. It ensures that when code modifications (diffs) render existing overarching documentation (e.g., `README.md`, `AGENTS.md`) factually incorrect, the Gemini model explicitly flags the mismatch as structured JSON data. This feature must be entirely silent when no documentation changes are required.

## 1. Requirements & Constraints

- **REQ-001**: Update `ReviewInputSchema` to accept an optional `docFilesToCheck` array of file paths.
- **REQ-002**: Provide a default configuration to check `['README.md', 'AGENTS.md']` if `docFilesToCheck` is omitted.
- **REQ-003**: Update `ReviewOutputSchema` to include an optional `documentationDrift` array (containing `file`, `driftDescription`, and `suggestedUpdate`).
- **REQ-004**: Read actual file contents of specified/default documentation files gracefully (ignoring missing files without throwing errors).
- **REQ-005**: Inject the retrieved documentation file contents into `buildDiffReviewPrompt`.
- **REQ-006**: Emit documentation drift into `AskStructuredContent` only when factual drift exists.
- **CON-001**: To avoid noise, the `documentationDrift` field MUST be omitted entirely if the documentation is still accurate. It cannot emit an empty array.
- **PAT-001**: Follow existing Zod v4 schema definition patterns in `src/schemas/*`.
- **GUD-001**: The prompt must use explicit constraints to prevent the model from inventing minor stylistic issues.

## 2. Implementation Steps

### Implementation Phase 1: Input & Output Schemas

- GOAL-001: Expand Zod schemas to support doc checks and structured drift output.

| Task     | Description                                                                                                              | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-001 | Modify `src/schemas/inputs.ts`: add `docFilesToCheck?: z.array(z.string()).optional()` to `ReviewInputSchema`.           |           |      |
| TASK-002 | Modify `src/schemas/outputs.ts`: add `documentationDrift` array schema to `ReviewOutputSchema` as an optional field.     |           |      |
| TASK-003 | Modify `AskStructuredContent` interface (or review equivalent) in `src/tools/review.ts` to include `documentationDrift`. |           |      |

### Implementation Phase 2: Prompt Engineering

- GOAL-002: Inject documentation context into the LLM system prompt.

| Task     | Description                                                                                                                                           | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-004 | Modify `src/lib/model-prompts.ts`: update `buildDiffReviewPrompt` parameter signature to accept `docContexts: {filename: string, content: string}[]`. |           |      |
| TASK-005 | Append a `<documentation_context>` XML block inside `buildDiffReviewPrompt` if `docContexts` is not empty.                                            |           |      |
| TASK-006 | Append strict CONSTRAINT directives to the prompt instructing the model to omit the field completely if no factual drift is found.                    |           |      |

### Implementation Phase 3: Tool Logic & File Reading

- GOAL-003: Read local documentation files and format the final MCP tool response.

| Task     | Description                                                                                                                                                                                                | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-007 | Modify `src/tools/review.ts`: Implement a helper `readDocFiles(paths: string[])` using `fs/promises.readFile` that catches `ENOENT` silently.                                                              |           |      |
| TASK-008 | In `reviewDiffWork`, resolve the doc files to check (using provided inputs or defaults `['README.md', 'AGENTS.md']`), and fetch their contents.                                                            |           |      |
| TASK-009 | Pass the fetched `docContexts` into `buildDiffReviewPrompt(..., docContexts)`.                                                                                                                             |           |      |
| TASK-010 | Modify the tool's result formatter to extract `documentationDrift` from the model's parsed JSON and inject a visible `⚠️ Documentation Drift Detected` text banner into the raw markdown content response. |           |      |

## 3. Alternatives

- **ALT-001**: Create a separate standalone `check_documentation` tool. **Rejected** because it introduces redundant API calls; the model already processes the full code diff during a review, making it highly cost-efficient to evaluate docs simultaneously.

## 4. Dependencies

- **DEP-001**: `node:fs/promises` (Native module, required for reading documentation files).
- **DEP-002**: `@google/genai` (For executing the generation, no version change required).
- **DEP-003**: `zod` (v4, used for schema updates).

## 5. Files

- **FILE-001**: `src/schemas/inputs.ts`
- **FILE-002**: `src/schemas/outputs.ts`
- **FILE-003**: `src/lib/model-prompts.ts`
- **FILE-004**: `src/tools/review.ts`

## 6. Testing

- **TEST-001**: Invoke review tool with a diff that fundamentally changes a CLI argument, alongside a `README.md` containing the old argument. Verify `documentationDrift` is populated and the text banner is present.
- **TEST-002**: Invoke review tool with an innocuous diff (e.g., refactoring a private helper method). Verify `documentationDrift` is `undefined`.
- **TEST-003**: Ensure the tool executes successfully even if `README.md` and `AGENTS.md` do not exist in the file system.

## 7. Risks & Assumptions

- **RISK-001**: The LLM might hallucinate drift due to trivial stylistic differences (False Positives). Mitigated by strict system prompt constraints.
- **RISK-002**: Unusually large documentation files could bloat the context window. Assumes overarching docs (`README.md`, `AGENTS.md`) are within reasonable token limits.
