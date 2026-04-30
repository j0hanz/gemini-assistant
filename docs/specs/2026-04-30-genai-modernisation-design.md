# `@google/genai` Modernisation — Design Spec

**Date:** 2026-04-30
**Status:** Approved — pending implementation plan

---

## Motivation

A review of the codebase against current `@google/genai` best practices (Gemini 3.0+) identified:

- **Bug:** `buildReplayHistoryParts` does not filter `part.thought === true`, so thought parts can be
  replayed into Gemini history during session rebuilds — documented to corrupt subsequent turns.
- **Architecture:** `ai.chats` (client-side state) requires ~400 lines of rebuild/filter/window logic
  (`buildRebuiltChatContents`, `selectReplayWindow`, `buildReplayHistoryParts`, `ContentEntry`,
  `SessionGenerationContract`) to survive process restarts. `ai.interactions` with
  `previous_interaction_id` makes all of this unnecessary.
- **Function call tracking:** Client manually tracks pending calls, builds function-response turns,
  and sequences `appendToolResponseTurn` — all work the Interactions API handles server-side.
- **Legacy knob:** `thinkingBudget` (deprecated token-count integer) wired alongside `thinkingLevel`
  with a precedence warning. Gemini 3.0+ uses `thinkingLevel` exclusively.
- **Duck-typed errors:** `AppError` checks `.status` via duck-type instead of `instanceof ApiError`.
- **Wrong field name:** `parameters` used for raw JSON schema in function declarations;
  `parametersJsonSchema` is the correct field.
- **Missed feature:** `mcpToTool` not used — callers must manually serialize MCP tool schemas as JSON.

Breaking changes are acceptable. No backward-compatibility shims or legacy fallbacks.

---

## Two-Path Generation Architecture

The public tool surface stays unchanged (four tools: `chat`, `research`, `analyze`, `review`).
Internally, generation splits into two well-separated paths.

| Path | API surface | Triggered by |
|:---|:---|:---|
| **Session** | `ai.interactions.create()` + `previous_interaction_id` + SSE stream | `chat` tool with a `sessionId` |
| **Stateless** | `ai.models.generateContentStream()` | All other tools + session-less chat |

These paths never mix. Each has its own config builder and streaming module.

---

## Session Store — Stripped to an ID Index

### What is deleted

| Symbol | File | Reason |
|:---|:---|:---|
| `ContentEntry` type | `sessions.ts` | Server-side state replaces local part storage |
| `buildReplayHistoryParts()` | `sessions.ts` | No local replay |
| `buildRebuiltChatContents()` | `sessions.ts` | No chat rebuild |
| `selectReplayWindow()` | `sessions.ts` | No window selection |
| `capRawParts()` | `sessions.ts` | No rawParts |
| `SessionGenerationContract` | `sessions.ts` | No rebuild compatibility check |
| `isCompatibleSessionContract()` | `sessions.ts` | Deleted with contract |
| `buildSessionGenerationContract()` | `sessions.ts` | Deleted with contract |
| `buildConfigFromSessionContract()` | `sessions.ts` | Deleted with contract |
| `hashInstructionText()` | `sessions.ts` | Deleted with contract |
| `appendToolResponseTurn()` | `sessions.ts` | Server tracks function call state |
| `getPendingFunctionCalls()` | `sessions.ts` | Server tracks function call state |
| `Chat` object field on `SessionEntry` | `sessions.ts` | Replaced by `interactionId: string` |
| `rebuildChat` dep in `chat.ts` | `tools/chat.ts` | No rebuild path |
| `normalizeFunctionResponses()` | `tools/chat.ts` | Server handles sequencing |
| `buildChatMessage()` | `tools/chat.ts` | Server handles sequencing |

### What the session store becomes

```ts
interface SessionEntry {
  interactionId: string;   // last Interaction ID in this session chain
  lastAccess:    number;
  transcript:    TranscriptEntry[];
  events:        SessionEventEntry[];
}
```

TTL eviction and the subscriber/notification pattern are preserved unchanged.

### MCP turn-parts resource

`gemini://sessions/{id}/turns/{n}/parts` no longer reads local `rawParts`. It calls
`ai.interactions.get(interactionId)` and maps `Interaction.outputs` into the resource payload.
The resource format changes (typed outputs, not `Part[]`) — this is an acceptable breaking change.

---

## Function Call Loop — Client Tracking Deleted

With `ai.interactions` managing server-side state, each turn (user message **or** tool result) is:

```ts
ai.interactions.create({
  model,
  input,                            // user message text, or omitted for tool-result-only turns
  previous_interaction_id: lastId,
  tool_results: [...]               // present when returning function call results
  tools,
  generation_config,
  system_instruction,
})
```

The server knows which function calls are outstanding from the previous interaction. The client
provides results and the server appends and continues generation.

The entire client-side pending-call tracking stack is deleted (see table above).

---

## Streaming Layer — Two Focused Modules

### `streaming.ts` (existing, trimmed)

Continues to consume `AsyncGenerator<GenerateContentResponse>` from `ai.models`. Used by all
stateless tool calls (research, analyze, review, session-less chat). No structural change beyond
integrating `ApiError` into the error path.

### `interaction-stream.ts` (new)

Consumes the `ai.interactions` SSE event stream for session turns. Produces MCP progress
notifications, thought-delta events, and phase transitions using the same notification surface as
`streaming.ts`. Returns a result compatible with `SessionEventEntry` recording.

Both modules feed the same MCP notification interface — the distinction is invisible to callers.

---

## Config Builders — Two Clean Functions

### `buildGenerateContentConfig()` (existing, `client.ts`)

Stays as the config builder for the stateless `ai.models` path. Change: `thinkingBudget` parameter
removed (see Thinking Config section).

### `buildInteractionParams()` (new, `client.ts` or `lib/interaction-config.ts`)

Builds `Interactions.CreateInteractionParameters` for session turns. Uses snake\_case fields:
`generation_config.thinking_level`, `max_output_tokens`, `system_instruction`, `tools`.

Both builders are fed by `ResolvedProfile` from `tool-profiles.ts`. No new abstraction layer
between them — `ResolvedProfile` is already the neutral representation.

---

## Thinking Config — Single Knob

### Deleted

- `thinkingBudget` parameter from `ConfigBuilderOptions`, `buildThinkingConfig`, all tool input
  schemas (`AskArgs` etc.), and `buildGenerateContentConfig`.
- `GEMINI_THINKING_BUDGET_CAP` environment variable and its parser in `config.ts`.
- The precedence-warning branch in `buildThinkingConfig`.

### Retained

- `thinkingLevel` as the sole thinking control (`MINIMAL | LOW | MEDIUM | HIGH`).
- Models path: `thinkingConfig: { thinkingLevel: ThinkingLevel.X }` (SDK enum, camelCase).
- Interactions path: `generation_config: { thinking_level: 'x' }` (lowercase string per
  Interactions API shape).
- The `THINKING_LEVEL_MAP` that converts `AskThinkingLevel` → `ThinkingLevel` enum stays.

---

## `mcpToTool` — First-Class in `agent` Profile

### Input schema change

`ToolsSpecOverrides` gains an `mcpServer` field alongside `functions`:

```ts
interface ToolsSpecOverrides {
  functions?:          FunctionDeclarationInput[];  // kept
  mcpServer?:          McpServerSpec;               // new
  // ... existing fields
}

interface McpServerSpec {
  transport: 'stdio' | 'http';
  command?:  string;   // for stdio
  url?:      string;   // for http
  args?:     string[];
  env?:      Record<string, string>;
}
```

When `mcpServer` is present on the `agent` profile, `mcpToTool()` from `@google/genai` converts the
MCP server's tool list into Gemini function declarations. These are merged with any raw `functions`
declarations before building the `ToolListUnion`.

### `parametersJsonSchema` fix (same PR)

In `tool-profiles.ts`, the function declaration builder changes:

```ts
// Before
{ parameters: decl.parametersJsonSchema }

// After
{ parametersJsonSchema: decl.parametersJsonSchema }
```

---

## Error Handling — `ApiError` First

```ts
import { ApiError, FinishReason, GoogleGenAI } from '@google/genai';
```

`AppError.isRetryable` and `AppError.from` are updated:

1. Check `err instanceof ApiError` first — use `.status` from the `ApiError` instance directly.
2. Fall through to duck-type check on `.status` for errors that never become `ApiError` instances
   (e.g. Node `fetch` layer network errors: `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`).
3. Fall through to `hasRetryableNetworkCode` for `code`-based network errors.

The duck-type fallback is load-bearing (not legacy) because network-layer errors are genuinely not
`ApiError` instances.

---

## Files Affected

| File | Change |
|:---|:---|
| `src/sessions.ts` | Major reduction — gut to ID index, delete all replay/rebuild/contract logic |
| `src/tools/chat.ts` | Remove rebuild dep, function-response tracking, `normalizeFunctionResponses`, `buildChatMessage` |
| `src/lib/interactions.ts` | Add foreground session turn support; `buildInteractionParams()` |
| `src/lib/streaming.ts` | Add `ApiError` integration; otherwise unchanged |
| `src/lib/interaction-stream.ts` | **New** — SSE consumer for session turns |
| `src/client.ts` | Remove `thinkingBudget`; add `buildInteractionParams()` or delegate to new module |
| `src/config.ts` | Remove `getThinkingBudgetCap()` and `GEMINI_THINKING_BUDGET_CAP` |
| `src/lib/errors.ts` | Import `ApiError`; update `AppError.from` and `AppError.isRetryable` |
| `src/lib/tool-profiles.ts` | Add `mcpServer` override; fix `parametersJsonSchema` |
| `src/schemas/fields.ts` | Remove `thinkingBudget` from input schemas; add `mcpServer` spec schema |
| `src/schemas/inputs.ts` | Propagate `thinkingBudget` removal |
| `src/resources.ts` | Update `gemini://sessions/{id}/turns/{n}/parts` to proxy Interactions API |
| `__tests__/**` | Update tests throughout for removed symbols and new session contract |

---

## Constraints Carried Forward

- `console.log` remains banned in server code — stdio transport constraint unchanged.
- TypeScript strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) unchanged.
- ESM only, `.js` extensions on imports.
- Public tool surface frozen (`chat`, `research`, `analyze`, `review`).
- `node scripts/tasks.mjs` must pass before commit.
