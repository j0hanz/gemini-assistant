---
goal: Migrate session architecture from ai.chats (client-side state) to ai.interactions (server-side state)
version: 1
date_created: 2026-04-30
status: Planned
plan_type: refactor
component: genai-session-architecture
execution: subagent-driven
---

# Implementation Plan: `@google/genai` Session Architecture (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Migrate from `ai.chats` (client-side conversation state, ~400 lines of replay/rebuild/window logic) to `ai.interactions` (server-side stateful turns with `previous_interaction_id`, SSE streaming, background jobs). Remove all client-side session history management, chat rebuild logic, function-call tracking, and replay-history filtering. Replace with server-side state via interaction IDs.

**Architecture:** Session turns move to the Interactions API with `previous_interaction_id` chaining. Client no longer maintains `Content[]` history or pending function calls. Each turn (user message or tool result) becomes a single `ai.interactions.create()` call. A new `interaction-stream.ts` module consumes SSE events and produces the same progress/thought notifications as the existing stateless `streaming.ts`. Sessions store only the last interaction ID, turn transcripts, and event logs — no replay or rebuild logic.

**Tech Stack:** TypeScript strict mode, `@google/genai` SDK (Interactions API), Zod v4, Node built-in test runner, `node scripts/tasks.mjs` for verification.

---

## 1. Goal

Replace all client-side session state management and chat history rebuilding with server-side interaction chaining via `previous_interaction_id`. After this plan:

- Sessions store only metadata (ID, transcript, events) — no replay parts, no rebuild contracts
- Chat turns use `ai.interactions.create()` with optional `previous_interaction_id` for multi-turn conversations
- Function call state is managed server-side; client provides results via `tool_results` field
- All client-side pending-call tracking, replay filtering, and history windowing is deleted
- `gemini://sessions/{id}/turns/{n}/parts` proxies `ai.interactions.get()` to serve current state
- Tests compile, existing chat and research features work unchanged, full suite passes

## 2. Requirements & Constraints

| ID                                        | Type        | Statement                                                                                                                                                                                     |
| :---------------------------------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Session store contains only `interactionId`, `lastAccess`, `transcript`, `events` — all replay/rebuild/contract logic deleted.                                                                |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Chat turns use `ai.interactions.create()` with `previous_interaction_id` for multi-turn sessions; stateless chat uses `ai.models.generateContentStream()` unchanged.                          |
| [`REQ-003`](#2-requirements--constraints) | Requirement | `interaction-stream.ts` consumes Interactions SSE and produces MCP task/thought notifications compatible with `streaming.ts` interface.                                                       |
| [`REQ-004`](#2-requirements--constraints) | Requirement | Function results passed via `ai.interactions.create({ tool_results: [...] })` — no client pending-call tracking, `appendToolResponseTurn`, or `getPendingFunctionCalls`.                      |
| [`REQ-005`](#2-requirements--constraints) | Requirement | Agent profile can declare `mcpServer` spec; `mcpToTool()` converts MCP tool list to Gemini function declarations; merged with raw `functions` before building tool list.                      |
| [`REQ-006`](#2-requirements--constraints) | Requirement | `buildInteractionParams()` builds `Interactions.CreateInteractionParameters` with snake_case fields (`generation_config.thinking_level`, `max_output_tokens`, `system_instruction`, `tools`). |
| [`REQ-007`](#2-requirements--constraints) | Requirement | `gemini://sessions/{id}/turns/{n}/parts` calls `ai.interactions.get(interactionId)` and maps `Interaction.outputs` into resource payload (breaking change: typed outputs, not `Part[]`).      |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No `console.log` — use `logger` from [src/lib/logger.ts](src/lib/logger.ts) (stdio transport constraint).                                                                                     |
| [`CON-002`](#2-requirements--constraints) | Constraint  | Breaking changes are intentional — no backward-compat shims or deprecation warnings for removed functions.                                                                                    |
| [`CON-003`](#2-requirements--constraints) | Constraint  | Run `node scripts/tasks.mjs` before every commit step.                                                                                                                                        |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | All changes follow Plan 1 cleanup — no `thinkingBudget`, correct `parametersJsonSchema` usage, `ApiError` classification.                                                                     |

## 3. Current Context

### File structure

| File                                                                                 | Status | Responsibility                                                                                                                             |
| :----------------------------------------------------------------------------------- | :----- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| [src/lib/interaction-stream.ts](src/lib/interaction-stream.ts)                       | Create | New module: consume Interactions SSE; emit MCP progress/thought notifications                                                              |
| [src/sessions.ts](src/sessions.ts)                                                   | Modify | Gut to ID index: delete all replay/rebuild/contract logic; simplify to `{ interactionId, lastAccess, transcript, events }`                 |
| [src/client.ts](src/client.ts)                                                       | Modify | Add `buildInteractionParams()` config builder for snake_case Interactions API                                                              |
| [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts)                                 | Modify | Add `mcpServer` field to `ToolsSpecOverrides`; integrate `mcpToTool()` when present                                                        |
| [src/tools/chat.ts](src/tools/chat.ts)                                               | Modify | Use `ai.interactions.create()` for session turns; drop `buildRebuiltChatContents`, `normalizeFunctionResponses`, all rebuild/pending logic |
| [src/lib/interactions.ts](src/lib/interactions.ts)                                   | Modify | Add foreground session-turn support (currently only background jobs); SSE streaming consumer                                               |
| [src/resources.ts](src/resources.ts)                                                 | Modify | Update `gemini://sessions/{id}/turns/{n}/parts` to proxy Interactions API instead of serving local `rawParts`                              |
| [**tests**/lib/interaction-stream.test.ts](__tests__/lib/interaction-stream.test.ts) | Create | Test SSE consumption and MCP event emission                                                                                                |
| [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                             | Modify | Update tests for simplified session store; delete tests for rebuild/contract logic                                                         |
| [**tests**/tools/chat.test.ts](__tests__/tools/chat.test.ts)                         | Modify | Update chat session turn tests to use interactions API                                                                                     |

### Relevant symbols

| Symbol                                                     | Why it matters                                                |
| :--------------------------------------------------------- | :------------------------------------------------------------ |
| [SessionEntry](src/sessions.ts#L230)                       | Type to simplify: delete Chat field, add interactionId        |
| [ContentEntry](src/sessions.ts#L38)                        | Type to delete entirely (no local part storage)               |
| [SessionGenerationContract](src/sessions.ts#L55)           | Type to delete (no rebuild compatibility check)               |
| [buildRebuiltChatContents](src/sessions.ts#L390)           | Function to delete (server-side state)                        |
| [buildReplayHistoryParts](src/sessions.ts#L566)            | Function to delete (server-side state)                        |
| [appendToolResponseTurn](src/sessions.ts#L399)             | Function to delete (server manages function state)            |
| [getPendingFunctionCalls](src/sessions.ts#L417)            | Function to delete (server-side pending tracking)             |
| [selectReplayWindow](src/sessions.ts#L1143)                | Function to delete (no windowing needed)                      |
| [buildGenerateContentConfig](src/client.ts#L157)           | Keep for stateless paths; will add `buildInteractionParams()` |
| [createBackgroundInteraction](src/lib/interactions.ts#L31) | Existing; will add foreground session-turn support            |
| [interactionToStreamResult](src/lib/interactions.ts#L111)  | Existing; will be used for SSE consumption                    |
| [resolveProfile](src/lib/tool-profiles.ts#L269)            | Use to build profiles; add mcpServer field support            |
| [buildToolsArray](src/lib/tool-profiles.ts#L392)           | Will integrate `mcpToTool()` output when mcpServer present    |
| [ToolsSpecOverrides](src/lib/tool-profiles.ts#L188)        | Add `mcpServer` field for MCP server declaratio               |
| [chat](src/tools/chat.ts#L956)                             | Main tool function; refactor to use interactions API          |

### Existing commands

```bash
# Full verification suite (format → lint/type-check/knip → test/build)
node scripts/tasks.mjs

# Single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts
```

### Current behaviour

Sessions use `ai.chats` (client-side state) with local `Content[]` history, replay filtering, rebuild logic, and pending function-call tracking. Chat turns manually sequence function responses. All this state is stored in `sessions.ts` via `ContentEntry` and `SessionGenerationContract`.

## 4. Implementation Phases

### PHASE-001: Create `interaction-stream.ts` SSE consumer

**Goal:** New module consumes Interactions API SSE stream and emits the same MCP notifications as `streaming.ts`, making the SSE source transparent to callers.

| Task                                                     | Action                                                               | Depends on | Files                                                                                                                                                | Validate                                                                                              |
| :------------------------------------------------------- | :------------------------------------------------------------------- | :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| [`TASK-001`](#task-001-create-interaction-stream-module) | Create new `interaction-stream.ts` module consuming Interactions SSE | none       | [src/lib/interaction-stream.ts](src/lib/interaction-stream.ts), [**tests**/lib/interaction-stream.test.ts](__tests__/lib/interaction-stream.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interaction-stream.test.ts` |

#### TASK-001: Create `interaction-stream.ts` module

| Field      | Value                                                                                                                                                                                                                                                                     |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | none                                                                                                                                                                                                                                                                      |
| Files      | Create: [src/lib/interaction-stream.ts](src/lib/interaction-stream.ts); Create: [**tests**/lib/interaction-stream.test.ts](__tests__/lib/interaction-stream.test.ts)                                                                                                      |
| Symbols    | [createBackgroundInteraction](src/lib/interactions.ts#L31), [interactionToStreamResult](src/lib/interactions.ts#L111)                                                                                                                                                     |
| Outcome    | New module exports `consumeInteractionStream()` function that takes an SSE event stream from `ai.interactions`, emits MCP progress/thought notifications, and returns a result compatible with `SessionEventEntry`. Tests verify event parsing and notification emission. |

- [ ] **Step 1: Create failing test** — write [**tests**/lib/interaction-stream.test.ts](__tests__/lib/interaction-stream.test.ts)

```ts
// __tests__/lib/interaction-stream.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

import { consumeInteractionStream } from '../../src/lib/interaction-stream.js';

test('consumeInteractionStream — parses SSE deltas and emits notifications', async () => {
  // Mock SSE event stream from Interactions API
  const mockEvents = [
    { type: 'content_part_delta', index: 0, delta: { text: 'Hello ' } },
    { type: 'content_part_delta', index: 0, delta: { text: 'world' } },
    { type: 'message_stop' },
  ];

  const notifications = [];
  const mockEmitter = {
    emit: (type, data) => notifications.push({ type, data }),
  };

  // Create async iterable from mock events
  const eventStream = (async function* () {
    for (const evt of mockEvents) {
      yield evt;
    }
  })();

  const result = await consumeInteractionStream(eventStream, mockEmitter);

  assert.deepStrictEqual(result.status, 'completed');
  assert.ok(result.text.includes('Hello world'));
  assert.ok(notifications.length > 0);
});
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interaction-stream.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create [src/lib/interaction-stream.ts](src/lib/interaction-stream.ts)**

```ts
// src/lib/interaction-stream.ts
import type { Readable } from 'node:stream';

import type { Interaction } from '@google/genai';

export interface StreamNotification {
  type: 'progress' | 'thought-delta' | 'function-call' | 'phase-transition';
  data: unknown;
}

export interface InteractionStreamResult {
  status: 'completed' | 'failed' | 'cancelled';
  text?: string;
  outputs?: Interaction['outputs'];
  error?: Error;
}

interface StreamEmitter {
  emit(type: string, data: unknown): void;
}

/**
 * Consume Interactions API SSE event stream.
 * Emits MCP notifications (progress, thoughts, function calls).
 * Returns result compatible with SessionEventEntry recording.
 */
export async function consumeInteractionStream(
  eventStream: AsyncIterable<unknown>,
  emitter: StreamEmitter,
): Promise<InteractionStreamResult> {
  let fullText = '';
  let outputs: Interaction['outputs'] = [];
  let status: 'completed' | 'failed' | 'cancelled' = 'completed';
  let error: Error | undefined;

  try {
    for await (const event of eventStream) {
      const evt = event as Record<string, unknown>;

      // Parse content deltas
      if (evt.type === 'content_part_delta') {
        const delta = evt.delta as Record<string, unknown>;
        if (typeof delta.text === 'string') {
          fullText += delta.text;
          emitter.emit('progress', { delta: delta.text });
        }
      }

      // Parse thought summaries
      if (evt.type === 'thought_summary') {
        const summary = evt.summary as string;
        emitter.emit('thought-delta', { summary });
      }

      // Parse function calls
      if (evt.type === 'function_call') {
        emitter.emit('function-call', evt);
      }

      // End of message
      if (evt.type === 'message_stop') {
        emitter.emit('phase-transition', { phase: 'completed' });
      }
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err : new Error(String(err));
    emitter.emit('phase-transition', { phase: 'failed', error });
  }

  return {
    status,
    text: fullText || undefined,
    outputs: outputs.length > 0 ? outputs : undefined,
    error,
  };
}
```

- [ ] **Step 4: Verify test passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interaction-stream.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/interaction-stream.ts __tests__/lib/interaction-stream.test.ts
git commit -m "feat(interaction-stream): new SSE consumer for Interactions API session turns"
```

---

### PHASE-002: Gut `sessions.ts` to ID index

**Goal:** Simplify `SessionEntry` to store only metadata; delete all replay/rebuild/contract logic and client-side pending-call tracking.

| Task                                                        | Action                                                     | Depends on                                                  | Files                                                                                        | Validate                           |
| :---------------------------------------------------------- | :--------------------------------------------------------- | :---------------------------------------------------------- | :------------------------------------------------------------------------------------------- | :--------------------------------- |
| [`TASK-002`](#task-002-simplify-sessionentry-type)          | Simplify `SessionEntry` type; delete unused types          | none                                                        | [src/sessions.ts](src/sessions.ts), [**tests**/sessions.test.ts](__tests__/sessions.test.ts) | `npm run type-check`               |
| [`TASK-003`](#task-003-delete-replay-and-rebuild-functions) | Delete all replay/rebuild/contract functions               | [`TASK-002`](#task-002-simplify-sessionentry-type)          | [src/sessions.ts](src/sessions.ts)                                                           | `npm run knip` (no unused exports) |
| [`TASK-004`](#task-004-delete-client-pending-call-tracking) | Delete `appendToolResponseTurn`, `getPendingFunctionCalls` | [`TASK-003`](#task-003-delete-replay-and-rebuild-functions) | [src/sessions.ts](src/sessions.ts), [src/tools/chat.ts](src/tools/chat.ts)                   | `node scripts/tasks.mjs --quick`   |

#### TASK-002: Simplify `SessionEntry` type

| Field      | Value                                                                                                                                                                                                                                          |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                                                                           |
| Files      | Modify: [src/sessions.ts](src/sessions.ts)                                                                                                                                                                                                     |
| Symbols    | [SessionEntry](src/sessions.ts#L230), [ContentEntry](src/sessions.ts#L38), [SessionGenerationContract](src/sessions.ts#L55)                                                                                                                    |
| Outcome    | `SessionEntry` type has only `interactionId: string`, `lastAccess: number`, `transcript: TranscriptEntry[]`, `events: SessionEventEntry[]`. Types `ContentEntry`, `Chat` (field on SessionEntry), and `SessionGenerationContract` are deleted. |

- [ ] **Step 1: Apply change** — Update [src/sessions.ts](src/sessions.ts)

Find [SessionEntry](src/sessions.ts#L230) and replace it:

```ts
// Before:
interface SessionEntry {
  chat: Chat;
  lastAccess: number;
  transcript: TranscriptEntry[];
  events: SessionEventEntry[];
}

// After:
interface SessionEntry {
  interactionId: string;
  lastAccess: number;
  transcript: TranscriptEntry[];
  events: SessionEventEntry[];
}
```

Delete the `Chat` type (near SessionEntry definition).
Delete the [ContentEntry](src/sessions.ts#L38) type entirely.
Delete the [SessionGenerationContract](src/sessions.ts#L55) type entirely.

- [ ] **Step 2: Verify types compile**

```bash
npm run type-check
```

Expected: PASS.

- [ ] **Step 3: Verify no tests break immediately**

```bash
node scripts/tasks.mjs --quick
```

Expected: Some test failures in sessions.test.ts (cascading from removed types) — this is expected.

- [ ] **Step 4: Commit**

```bash
git add src/sessions.ts
git commit -m "refactor(sessions): simplify SessionEntry to interactionId + metadata only"
```

---

#### TASK-003: Delete replay and rebuild functions

| Field      | Value                                                                                                                                                                                                                                          |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-simplify-sessionentry-type)                                                                                                                                                                                             |
| Files      | Modify: [src/sessions.ts](src/sessions.ts)                                                                                                                                                                                                     |
| Symbols    | [buildReplayHistoryParts](src/sessions.ts#L566), [buildRebuiltChatContents](src/sessions.ts#L390), [selectReplayWindow](src/sessions.ts#L1143)                                                                                                 |
| Outcome    | Functions `buildReplayHistoryParts`, `buildRebuiltChatContents`, `selectReplayWindow`, and `isCompatibleSessionContract`, `buildSessionGenerationContract`, `buildConfigFromSessionContract`, `hashInstructionText` are deleted from the file. |

- [ ] **Step 1: Apply change** — Delete functions from [src/sessions.ts](src/sessions.ts)

Delete entirely:

- [buildReplayHistoryParts](src/sessions.ts#L566)
- [buildRebuiltChatContents](src/sessions.ts#L390)
- [selectReplayWindow](src/sessions.ts#L1143)
- `isCompatibleSessionContract` (internal helper)
- `buildSessionGenerationContract` (internal helper)
- `buildConfigFromSessionContract` (internal helper)
- `hashInstructionText` (internal helper)

All these are safe to delete — they were never exported and only used by removed replay logic.

- [ ] **Step 2: Verify no unused exports**

```bash
npm run knip
```

Expected: PASS (all removed functions are now gone, no orphaned references).

- [ ] **Step 3: Commit**

```bash
git add src/sessions.ts
git commit -m "refactor(sessions): delete all replay/rebuild/window logic"
```

---

#### TASK-004: Delete client pending-call tracking

| Field      | Value                                                                                                                                                                   |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-delete-replay-and-rebuild-functions)                                                                                                             |
| Files      | Modify: [src/sessions.ts](src/sessions.ts); Modify: [src/tools/chat.ts](src/tools/chat.ts)                                                                              |
| Symbols    | [appendToolResponseTurn](src/sessions.ts#L399), [getPendingFunctionCalls](src/sessions.ts#L417)                                                                         |
| Outcome    | Functions `appendToolResponseTurn` and `getPendingFunctionCalls` deleted from sessions.ts. All references in chat.ts removed. No pending-call state stored client-side. |

- [ ] **Step 1: Apply change** — Delete [appendToolResponseTurn](src/sessions.ts#L399) and [getPendingFunctionCalls](src/sessions.ts#L417) from [src/sessions.ts](src/sessions.ts)

Delete both functions entirely.

- [ ] **Step 2: Remove references from [src/tools/chat.ts](src/tools/chat.ts)**

Search for calls to `appendToolResponseTurn` and `getPendingFunctionCalls` in chat.ts and delete those call sites (will be replaced in next phase).

- [ ] **Step 3: Verify**

```bash
node scripts/tasks.mjs --quick
```

Expected: PASS (format, lint, type-check, knip).

- [ ] **Step 4: Commit**

```bash
git add src/sessions.ts src/tools/chat.ts
git commit -m "refactor(sessions): delete appendToolResponseTurn and getPendingFunctionCalls"
```

---

### PHASE-003: Add `buildInteractionParams()` config builder

**Goal:** Create snake_case config builder for `ai.interactions.create()` calls, mirroring `buildGenerateContentConfig()` for the models API.

| Task                                                          | Action                                      | Depends on | Files                                                                                | Validate                                                                              |
| :------------------------------------------------------------ | :------------------------------------------ | :--------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| [`TASK-005`](#task-005-create-buildinteractionparams-builder) | Add `buildInteractionParams()` to client.ts | none       | [src/client.ts](src/client.ts), [**tests**/client.test.ts](__tests__/client.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/client.test.ts` |

#### TASK-005: Create `buildInteractionParams()` builder

| Field      | Value                                                                                                                                                                                                                                                      |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                                                                                       |
| Files      | Modify: [src/client.ts](src/client.ts); Modify: [**tests**/client.test.ts](__tests__/client.test.ts)                                                                                                                                                       |
| Symbols    | [buildGenerateContentConfig](src/client.ts#L157), [ResolvedProfile](src/lib/tool-profiles.ts#L223)                                                                                                                                                         |
| Outcome    | New `buildInteractionParams()` function exports from client.ts, accepts `ResolvedProfile` and tool overrides, returns `Interactions.CreateInteractionParameters` with correct snake_case fields. Tests verify correct field casing and tool list building. |

- [ ] **Step 1: Write failing test** — Add to [**tests**/client.test.ts](__tests__/client.test.ts)

```ts
test('buildInteractionParams — emits snake_case generation_config', () => {
  const params = buildInteractionParams(
    {
      profile: 'plain',
      overrides: {},
    },
    { toolKey: 'chat' },
    {
      systemInstruction: 'Be helpful',
      thinkingLevel: 'LOW',
      maxOutputTokens: 2048,
    },
  );

  assert.ok('generation_config' in params);
  assert.ok('thinking_level' in params.generation_config);
  assert.strictEqual(params.generation_config.thinking_level, 'low');
  assert.strictEqual(params.generation_config.max_output_tokens, 2048);
  assert.strictEqual(params.system_instruction, 'Be helpful');
});
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/client.test.ts
```

Expected: FAIL — `buildInteractionParams is not defined`.

- [ ] **Step 3: Implement [src/client.ts](src/client.ts)**

Add this function to [src/client.ts](src/client.ts):

```ts
export interface InteractionParamsOptions {
  systemInstruction?: string | undefined;
  thinkingLevel?: AskThinkingLevel | undefined;
  maxOutputTokens?: number | undefined;
  tools?: ToolListUnion | undefined;
}

export function buildInteractionParams(
  profile: { profile: string; overrides: ToolsSpecOverrides },
  context: { toolKey: string },
  options: InteractionParamsOptions,
): Interactions.CreateInteractionParameters {
  const resolved = resolveProfile(profile, context);
  const tools = buildToolsArray(resolved);

  const generationConfig = {
    ...(options.thinkingLevel ? { thinking_level: options.thinkingLevel.toLowerCase() } : {}),
    ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
  };

  return {
    model: 'gemini-3-pro-preview',
    ...(options.systemInstruction ? { system_instruction: options.systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}
```

- [ ] **Step 4: Verify test passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts __tests__/client.test.ts
git commit -m "feat(client): add buildInteractionParams() for Interactions API config"
```

---

### PHASE-004: Integrate `mcpToTool()` in agent profile

**Goal:** Add `mcpServer` field to `ToolsSpecOverrides` and integrate `mcpToTool()` output into tool list building.

| Task                                                           | Action                                     | Depends on | Files                                                                                                                            | Validate                                                                                         |
| :------------------------------------------------------------- | :----------------------------------------- | :--------- | :------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| [`TASK-006`](#task-006-add-mcpserver-support-to-tool-profiles) | Add mcpServer field; integrate mcpToTool() | none       | [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts), [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts` |

#### TASK-006: Add mcpServer support to tool profiles

| Field      | Value                                                                                                                                                                                                                    |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                                                                                     |
| Files      | Modify: [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts); Modify: [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts)                                                                         |
| Symbols    | [ToolsSpecOverrides](src/lib/tool-profiles.ts#L188), [buildToolsArray](src/lib/tool-profiles.ts#L392), [resolveProfile](src/lib/tool-profiles.ts#L269)                                                                   |
| Outcome    | `ToolsSpecOverrides` gains `mcpServer?: McpServerSpec` field. When present, `mcpToTool()` converts MCP tool list to Gemini declarations, merged with any raw `functions`. Test verifies MCP tool conversion and merging. |

- [ ] **Step 1: Write failing test** — Add to [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts)

```ts
test('buildToolsArray — mcpServer spec converts tools via mcpToTool', () => {
  const mcpSpec = {
    transport: 'stdio' as const,
    command: 'node',
    args: ['mcp-server.js'],
  };

  const resolved = resolveProfile(
    {
      profile: 'agent',
      overrides: {
        mcpServer: mcpSpec,
        functions: [{ name: 'custom_fn', description: 'custom', parametersJsonSchema: {} }],
      },
    },
    { toolKey: 'chat' },
  );

  const tools = buildToolsArray(resolved);
  const decls = tools.flatMap((t) => ('functionDeclarations' in t ? t.functionDeclarations : []));

  assert.ok(decls.length > 0, 'should have function declarations from MCP + custom');
  assert.ok(
    decls.some((d) => d.name === 'custom_fn'),
    'custom function should be present',
  );
});
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts
```

Expected: FAIL — mcpServer field does not exist.

- [ ] **Step 3: Update [src/lib/tool-profiles.ts](src/lib/tool-profiles.ts)**

Add to `ToolsSpecOverrides` type (around line 188):

```ts
interface McpServerSpec {
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ToolsSpecOverrides {
  functions?: FunctionDeclarationInput[];
  mcpServer?: McpServerSpec;
  // ... existing fields
}
```

In [buildToolsArray](src/lib/tool-profiles.ts#L392), add MCP tool conversion before building the function declarations array:

```ts
// After resolving profiles, before building tools
let functions = resolved.functions ?? [];

// If mcpServer specified, convert MCP tools to declarations
if (resolved.mcpServer) {
  try {
    const mcpTools = await mcpToTool(resolved.mcpServer);
    functions = [...mcpTools, ...functions];
  } catch (err) {
    logger.error('Failed to convert MCP tools', { error: err });
  }
}

// Then build the tool array with merged functions
const tools = [];
if (functions.length > 0) {
  tools.push({
    functionDeclarations: functions.map((decl) => ({
      name: decl.name,
      description: decl.description,
      ...(decl.parametersJsonSchema !== undefined
        ? { parametersJsonSchema: decl.parametersJsonSchema }
        : {}),
    })),
  });
}
// ... rest of tool building
```

- [ ] **Step 4: Verify test passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tool-profiles.ts __tests__/lib/tool-profiles.test.ts
git commit -m "feat(tool-profiles): add mcpServer support; integrate mcpToTool()"
```

---

### PHASE-005: Refactor chat tool to use `ai.interactions` for sessions

**Goal:** Update [chat](src/tools/chat.ts) to use `ai.interactions.create()` for session turns; drop all rebuild/pending-call logic; use `buildInteractionParams()`.

| Task                                                          | Action                               | Depends on                                                    | Files                                                                                                | Validate                                                                                  |
| :------------------------------------------------------------ | :----------------------------------- | :------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| [`TASK-007`](#task-007-refactor-chat-to-use-interactions-api) | Refactor chat tool main turn handler | [`TASK-005`](#task-005-create-buildinteractionparams-builder) | [src/tools/chat.ts](src/tools/chat.ts), [**tests**/tools/chat.test.ts](__tests__/tools/chat.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/chat.test.ts` |

#### TASK-007: Refactor chat to use Interactions API

| Field      | Value                                                                                                                                                                                                                                                                             |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-005`](#task-005-create-buildinteractionparams-builder)                                                                                                                                                                                                                     |
| Files      | Modify: [src/tools/chat.ts](src/tools/chat.ts); Modify: [**tests**/tools/chat.test.ts](__tests__/tools/chat.test.ts)                                                                                                                                                              |
| Symbols    | [chat](src/tools/chat.ts#L956), [buildInteractionParams](src/client.ts#L189)                                                                                                                                                                                                      |
| Outcome    | Chat session turns call `ai.interactions.create()` with `previous_interaction_id` chaining. Function results passed via `tool_results` field. All `buildRebuiltChatContents`, `normalizeFunctionResponses` calls removed. Session store updated with `interactionId`. Tests pass. |

- [ ] **Step 1: Write failing test** — Add to [**tests**/tools/chat.test.ts](__tests__/tools/chat.test.ts)

```ts
test('chat tool with sessionId — uses ai.interactions for multi-turn', async () => {
  const result = await chatTool(
    {
      goal: 'Hello',
      sessionId: 'sess-123',
      profile: 'plain',
    },
    contextWithMocks({
      getAI: () => ({
        interactions: {
          create: async (params) => ({
            id: 'interaction-456',
            status: 'completed',
            outputs: [{ type: 'text', text: 'Hi there!' }],
          }),
          get: async (id) => ({
            id,
            outputs: [{ type: 'text', text: 'Hi there!' }],
          }),
        },
      }),
    }),
  );

  assert.ok(result.content.length > 0);
  const session = getSessionStore().getOrCreate('sess-123');
  assert.strictEqual(session.interactionId, 'interaction-456');
});
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/chat.test.ts
```

Expected: FAIL — chat tool does not yet use interactions API.

- [ ] **Step 3: Refactor [src/tools/chat.ts](src/tools/chat.ts)**

In the main [chat](src/tools/chat.ts#L956) tool handler, replace the `ai.chats` or `ai.models` path with `ai.interactions` for sessions:

```ts
// Simplified pseudocode; adapt to actual chat.ts structure
async function chatTool(input: ChatInput, context: ToolContext) {
  // For sessionId: use ai.interactions
  if (input.sessionId) {
    const session = context.sessions.getOrCreate(input.sessionId);
    const params = buildInteractionParams(
      { profile: input.profile, overrides: input.tools ?? {} },
      { toolKey: 'chat' },
      {
        systemInstruction: resolveSystemInstruction(input),
        thinkingLevel: input.thinkingLevel,
        maxOutputTokens: 2048,
      },
    );

    // Add previous interaction if session has one
    if (session.interactionId) {
      params.previous_interaction_id = session.interactionId;
    }

    // Create interaction turn
    const interaction = await getAI().interactions.create({
      ...params,
      input: input.goal,
    });

    // Update session with new interaction ID
    session.interactionId = interaction.id;

    // Stream results
    // ... emit progress notifications, record turn in transcript/events
    return buildCallToolResult({
      content: [{ type: 'text', text: interaction.outputs?.[0]?.text || '' }],
    });
  }

  // For stateless chat: continue using ai.models (unchanged)
  // ...
}
```

- [ ] **Step 4: Verify test passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/chat.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/chat.ts __tests__/tools/chat.test.ts
git commit -m "refactor(chat): use ai.interactions for session turns; drop rebuild logic"
```

---

### PHASE-006: Update `gemini://sessions/{id}/turns/{n}/parts` resource

**Goal:** Update the resource handler to proxy `ai.interactions.get()` instead of serving local `rawParts`. Breaking change: typed outputs instead of `Part[]`.

| Task                                                  | Action                                    | Depends on                                                    | Files                                | Validate                                                                                 |
| :---------------------------------------------------- | :---------------------------------------- | :------------------------------------------------------------ | :----------------------------------- | :--------------------------------------------------------------------------------------- |
| [`TASK-008`](#task-008-update-session-parts-resource) | Update resource to proxy Interactions API | [`TASK-007`](#task-007-refactor-chat-to-use-interactions-api) | [src/resources.ts](src/resources.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources.test.ts` |

#### TASK-008: Update session parts resource

| Field      | Value                                                                                                                                                                                                                                       |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | [`TASK-007`](#task-007-refactor-chat-to-use-interactions-api)                                                                                                                                                                               |
| Files      | Modify: [src/resources.ts](src/resources.ts)                                                                                                                                                                                                |
| Symbols    | [SessionStore](src/resources.ts#L29)                                                                                                                                                                                                        |
| Outcome    | `gemini://sessions/{id}/turns/{n}/parts` resource calls `ai.interactions.get(interactionId)` and maps `Interaction.outputs` into resource payload. Resource format changes from `Part[]` to typed outputs — breaking change. Tests updated. |

- [ ] **Step 1: Write failing test** — Add to test file for resources

```ts
test('gemini://sessions/{id}/turns/{n}/parts — proxies Interactions API', async () => {
  const mockSession = {
    interactionId: 'interaction-789',
    transcript: [],
    events: [],
  };

  const mockInteraction = {
    id: 'interaction-789',
    outputs: [
      { type: 'text' as const, text: 'Hello' },
      { type: 'text' as const, text: 'World' },
    ],
  };

  const resource = await resourceHandler(
    'gemini://sessions/sess-123/turns/0/parts',
    { getAI, getSessionStore, ... }
  );

  assert.deepStrictEqual(resource.contents[0].text, JSON.stringify(mockInteraction.outputs));
});
```

- [ ] **Step 2: Verify test fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources.test.ts
```

Expected: FAIL — resource does not proxy Interactions API.

- [ ] **Step 3: Update [src/resources.ts](src/resources.ts)**

Find the `gemini://sessions/{id}/turns/{n}/parts` resource handler and update it:

```ts
// Before: served from session.turns[n].rawParts
// After: proxy from ai.interactions.get()

if (uri.startsWith('gemini://sessions/')) {
  // ... parse sessionId, turnIndex
  const session = sessionStore.getOrCreate(sessionId);
  const interaction = await getAI().interactions.get(session.interactionId);

  return {
    uri,
    mimeType: 'application/json',
    contents: [
      {
        text: JSON.stringify(interaction.outputs),
      },
    ],
  };
}
```

- [ ] **Step 4: Verify test passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/resources.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resources.ts __tests__/resources.test.ts
git commit -m "refactor(resources): gemini://sessions/{id}/turns/{n}/parts proxies Interactions API"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Full suite passes

```bash
node scripts/tasks.mjs
```

Expected: all stages green — format, lint, type-check, knip, test, build.

### [`VAL-002`](#5-testing--validation) — Session store simplified

```bash
grep -n "buildRebuiltChatContents\|buildReplayHistoryParts\|ContentEntry\|Chat:" src/sessions.ts
```

Expected: no output (all deleted).

### [`VAL-003`](#5-testing--validation) — Chat uses Interactions for sessions

```bash
grep -n "ai.interactions.create" src/tools/chat.ts
```

Expected: output showing interactions.create calls present in session code path.

### [`VAL-004`](#5-testing--validation) — MCP tools integrated

```bash
grep -n "mcpToTool\|mcpServer" src/lib/tool-profiles.ts
```

Expected: output showing mcpToTool usage and mcpServer field handling.

## 6. Acceptance Criteria

| ID                                 | Observable Outcome                                                                                     |
| :--------------------------------- | :----------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 with all stages green.                                                |
| [`AC-002`](#6-acceptance-criteria) | `SessionEntry` type has only `interactionId`, `lastAccess`, `transcript`, `events` fields.             |
| [`AC-003`](#6-acceptance-criteria) | Chat sessions use `ai.interactions.create()` with `previous_interaction_id` chaining.                  |
| [`AC-004`](#6-acceptance-criteria) | `buildInteractionParams()` exported from client.ts, emits snake_case `generation_config`.              |
| [`AC-005`](#6-acceptance-criteria) | Agent profile supports `mcpServer` field; `mcpToTool()` converts and merges MCP tools.                 |
| [`AC-006`](#6-acceptance-criteria) | `gemini://sessions/{id}/turns/{n}/parts` proxies `ai.interactions.get()`.                              |
| [`AC-007`](#6-acceptance-criteria) | Zero references to deleted functions (buildRebuiltChatContents, appendToolResponseTurn, etc.) in code. |

## 7. Risks / Notes

| ID                            | Type | Detail                                                                                                                                                                                    |
| :---------------------------- | :--- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`NOTE-001`](#7-risks--notes) | Note | This is Plan 2 of 2. Plan 1 (genai-mechanical-fixes) must be completed and merged before starting Plan 2.                                                                                 |
| [`NOTE-002`](#7-risks--notes) | Note | Breaking change: `gemini://sessions/{id}/turns/{n}/parts` resource format changes from `Part[]` to typed Interaction.outputs. Clients must adapt to new structure.                        |
| [`NOTE-003`](#7-risks--notes) | Note | MCP tool integration is async; `buildToolsArray()` will need error handling for MCP server startup failures (currently synchronous signature).                                            |
| [`RISK-001`](#7-risks--notes) | Risk | Session resumption depends on valid `interactionId` stored; if Gemini deletes old interactions, session replay will fail. Mitigation: handle 404 from Interactions API gracefully.        |
| [`RISK-002`](#7-risks--notes) | Risk | Function call handling changes from client-side pending tracking to server-side state. Ensure all tool call paths properly construct `tool_results` field for `ai.interactions.create()`. |
