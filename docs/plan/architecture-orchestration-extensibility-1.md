---
goal: Expose Custom Function Calling, Chat Code Execution, and Dynamic Capability Sets
version: 1.0
date_created: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [architecture, feature, refactor, orchestration]
---

# Introduction

> [!NOTE]
> The `additionalTools` goal of this plan has been **reverted** by [`refactor-public-contract-integrity-1.md`](refactor-public-contract-integrity-1.md). No public surface actually plumbed client-supplied function declarations through the `additionalTools` path, and the field remained undocumented on the public contract. The Zod input fields, the `OrchestrationRequest.additionalTools` property, and all call-site plumbing have been removed. Client-side function calling on `chat` remains available via the dedicated `functions` field. The dynamic-capability-set and Code Execution portions of this plan remain in effect.

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan implements the high-value architectural improvements identified during the Gemini tool orchestration audit. It focuses on three critical enhancements: refactoring rigid capability flags into dynamic sets, plumbing custom `additionalTools` through to the public MCP inputs, and exposing Gemini Code Execution directly within standard chat sessions.

These changes are highly optimal for an MCP server context:

1. **Custom Function Calling (`additionalTools`)**: Allows the MCP client to pass its own tool schemas to Gemini, enabling complex multi-agent delegation where the MCP server handles Gemini reasoning while the client executes local tools.
2. **Chat Code Execution**: Brings deterministic Python execution (for math, data processing, and logic) directly to low-latency chat interactions, which is a core use case for AI assistants.
3. **Dynamic Capability Sets**: Future-proofs the server's validation and configuration layer against upcoming Gemini tool additions (e.g., File Search) without requiring sprawling changes across multiple files.

## 1. Requirements & Constraints

- **REQ-001**: `OrchestrationConfig` must use a dynamic `activeCapabilities: Set<BuiltInToolName>` instead of hardcoded `uses*` booleans.
- **REQ-002**: `ChatInput` and `ResearchInput` schemas must expose `additionalTools` as an optional input array, accepting valid Gemini Tool definitions.
- **REQ-003**: `ChatInput` schema must accept a `codeExecution?: boolean` parameter to toggle native Python execution.
- **REQ-004**: `chat` tool orchestrator must pass `additionalTools` and `codeExecution` requests to `resolveOrchestration`.
- **CON-001**: Custom function execution remains the responsibility of the MCP client; the MCP server only passes the definitions to Gemini and returns the `functionCalls` in the structured output.
- **PAT-001**: `preflight.ts` validation must check the `activeCapabilities` Set instead of relying on explicit boolean flags.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Decouple capability validation from hardcoded booleans to support arbitrary Gemini tools.

| Task     | Description                                                                                                                                                                                                                 | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/lib/orchestration.ts`, modify `OrchestrationConfig` to replace `usesGoogleSearch`, `usesUrlContext`, `usesCodeExecution` with `activeCapabilities: Set<BuiltInToolName>`.                                           | ✅        | 2026-04-22 |
| TASK-002 | In `src/lib/orchestration.ts`, update `buildOrchestrationConfig` to populate `activeCapabilities` by iterating over the resolved tools, and update the logging payload to serialize this Set (e.g. as an array of strings). | ✅        | 2026-04-22 |
| TASK-003 | In `src/lib/preflight.ts`, update `validateGeminiRequest` to check `activeCapabilities.has('googleSearch')` instead of `usesGoogleSearch`, etc.                                                                             | ✅        | 2026-04-22 |

### Implementation Phase 2

- GOAL-002: Enable deterministic code execution in the chat tool for data and math logic.

| Task     | Description                                                                                                                                                                         | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-004 | In `src/schemas/inputs.ts`, add `codeExecution?: boolean` to the `ChatInput` Zod schema (`createChatInputSchema`). Add a description highlighting that it enables Python execution. | ✅        | 2026-04-22 |
| TASK-005 | In `src/tools/chat.ts`, update `buildChatOrchestrationRequest` to append `'codeExecution'` to `builtInToolNames` if `args.codeExecution` is true.                                   | ✅        | 2026-04-22 |

### Implementation Phase 3

- GOAL-003: Allow MCP clients to inject their own function declarations for Gemini to invoke.

| Task     | Description                                                                                                                                                           | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-006 | In `src/schemas/inputs.ts`, add an `additionalTools` field to both `ChatInput` and `ResearchInput` Zod schemas. This should accept an array of Gemini `Tool` objects. | ✅        | 2026-04-22 |
| TASK-007 | In `src/tools/chat.ts`, update `buildChatOrchestrationRequest` to accept `args.additionalTools` and pass it into the returned request object.                         | ✅        | 2026-04-22 |
| TASK-008 | In `src/tools/research.ts`, update orchestration call sites to pass `args.additionalTools`.                                                                           | ✅        | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Automatically enable `codeExecution` for all chat sessions. Rejected: Code execution increases prompt context size and can increase latency or trigger unnecessary python executions for simple questions. Explicit opt-in via a boolean is safer.
- **ALT-002**: Have the MCP server natively execute the custom `additionalTools` if they are defined as MCP tools. Rejected: MCP servers are designed to provide tools to the client, not to magically proxy tools back to the client natively within the same turn. Returning the `functionCall` to the client is the correct MCP architectural pattern.

## 4. Dependencies

- **DEP-001**: `@google/genai` (for `Tool` type definitions and function calling structures).

## 5. Files

- **FILE-001**: `src/lib/orchestration.ts` (Capability Set logic)
- **FILE-002**: `src/lib/preflight.ts` (Validation logic)
- **FILE-003**: `src/schemas/inputs.ts` (Zod schemas for MCP tools)
- **FILE-004**: `src/tools/chat.ts` (Chat orchestrator adjustments)
- **FILE-005**: `src/tools/research.ts` (Research orchestrator adjustments)

## 6. Testing

- **TEST-001**: Update `__tests__/lib/orchestration.test.ts` to assert `activeCapabilities` contains expected values and logging payloads are correct.
- **TEST-002**: Update `__tests__/tools/ask.test.ts` to pass `codeExecution: true` and verify `codeExecution` is included in the resolved toolset.
- **TEST-003**: Update `__tests__/tools/ask.test.ts` and `research.test.ts` to pass `additionalTools` and verify they are correctly merged into the final Gemini API configuration.
- **TEST-004**: Update `__tests__/lib/preflight.test.ts` to mock `activeCapabilities` properly.

## 7. Risks & Assumptions

- **RISK-001**: Zod schema validation for `additionalTools` might be too permissive if `z.unknown().array()` is used. **Assumption**: A basic validation structure is sufficient, as the Gemini SDK itself will validate the structure at runtime.
- **RISK-002**: The MCP protocol's `CallToolResult` structure must clearly convey the `functionCalls` returned by Gemini. **Assumption**: The existing `buildBaseStructuredOutput` and `buildAskStructuredContent` in `src/tools/chat.ts` already correctly serialize `streamResult.functionCalls`, meaning no changes to output parsing are needed.
