---
goal: Add ai.interactions background execution path for deep-research, replacing the streaming generateContentStream call with a polled background Interaction
version: 1
date_created: 2026-04-29
status: Planned
plan_type: feature
component: interactions-api-background
execution: subagent-driven
---

# Implementation Plan: Interactions API — Background Execution for Deep Research

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Replace `ai.models.generateContentStream` in `agenticSearchWork` with `ai.interactions.create({ background: true })` + polling, giving deep-research tasks a non-streaming, background-tolerant execution path.

**Architecture:** A new `src/lib/interactions.ts` module exposes pure helper functions for creating and polling background `Interaction` objects. `agenticSearchWork` in `src/tools/research.ts` is the only callsite changed; all other tools continue using the existing streaming path. Mock support is added to `MockGeminiEnvironment` so that unit and e2e tests can queue fake `Interaction` responses without hitting the network.

**Tech Stack:** `@google/genai` v1.50.1 (`ai.interactions.create`, `ai.interactions.get`, `ai.interactions.cancel`), Node.js built-in test runner with `tsx/esm`, TypeScript strict mode.

---

## 1. Goal

`agenticSearchWork` currently drives deep-research via a streaming `generateContentStream` call. Long searches can exceed transport timeouts and produce no partial output. The Interactions API's `background: true` mode returns immediately, lets the server poll at its own pace, and is less sensitive to connection duration. On completion the full `Interaction.outputs` array is extracted to text and surfaced through the existing `buildAgenticSearchResult` path. The change is scoped to `searchDepth < 3`; deeper plans continue to use `runDeepResearchPlan`.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                              |
| :---------------------------------------: | :---------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | `agenticSearchWork` must call `ai.interactions.create({ background: true })` and poll via `ai.interactions.get` for `searchDepth < 3`. |
| [`REQ-002`](#2-requirements--constraints) | Requirement | When the polled `Interaction.status` is not `completed`, return an `AppError` with `isError: true`.                                    |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Progress notifications must be sent at least once per poll cycle so the MCP client does not time out.                                  |
| [`REQ-004`](#2-requirements--constraints) | Requirement | If the `AbortSignal` fires during polling, call `ai.interactions.cancel` before throwing.                                              |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Do not change the public MCP contract: no new tools, prompts, or resources.                                                            |
| [`CON-002`](#2-requirements--constraints) | Constraint  | `Interactions` is not a runtime export of `@google/genai`; use `import type { Interactions }` for type imports only.                   |
| [`CON-003`](#2-requirements--constraints) | Constraint  | `ai.interactions` is experimental (SDK prints a warning on first access); no action required, the warning goes to stderr not stdout.   |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [getAI](src/client.ts#L238) lazy singleton pattern — access `getAI().interactions` rather than storing a reference.             |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Follow [AppError](src/lib/errors.ts#L35) for all thrown errors so callers can convert to `CallToolResult`.                             |
| [`PAT-003`](#2-requirements--constraints) | Pattern     | Follow [MockGeminiEnvironment](__tests__/lib/mock-gemini-environment.ts#L63) install/uninstall pattern when adding mock support.       |

## 3. Current Context

### File structure

| File                                                                                     | Status | Responsibility                                                                                                            |
| :--------------------------------------------------------------------------------------- | :----- | :------------------------------------------------------------------------------------------------------------------------ |
| [src/lib/interactions.ts](src/lib/interactions.ts)                                       | Create | Pure helpers: built-in tool mapping, background interaction creation, polling, text extraction, `StreamResult` conversion |
| [\_\_tests\_\_/lib/interactions.test.ts](__tests__/lib/interactions.test.ts)             | Create | Unit tests for all `src/lib/interactions.ts` exports                                                                      |
| [\_\_tests\_\_/lib/mock-gemini-environment.ts](__tests__/lib/mock-gemini-environment.ts) | Modify | Add `ai.interactions` mock (create, get, cancel) with queue helpers                                                       |
| [src/tools/research.ts](src/tools/research.ts)                                           | Modify | Replace `generateContentStream` call in `agenticSearchWork` with background interaction path                              |

### Relevant symbols

| Symbol                                                                | Why it matters                                                                          |
| :-------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| [getAI](src/client.ts#L238)                                           | Entry point for all SDK access; returns the lazy `GoogleGenAI` singleton                |
| [AppError](src/lib/errors.ts#L35)                                     | Standard error type; `.toToolResult()` produces `CallToolResult` with `isError: true`   |
| [StreamResult](src/lib/streaming.ts#L60)                              | Shape returned by the streaming path and consumed by all response builders              |
| [sendProgress](src/lib/progress.ts#L233)                              | Sends MCP progress notifications during polling                                         |
| [PROGRESS_TOTAL](src/lib/progress.ts#L14)                             | Total progress denominator used in `sendProgress` calls                                 |
| [agenticSearchWork](src/tools/research.ts#L906)                       | The function whose `generateContentStream` call is being replaced                       |
| [buildAgenticSearchResult](src/tools/research.ts#L225)                | Converts `StreamResult` + text to `CallToolResult`; reused unchanged                    |
| [buildAgenticResearchPrompt](src/lib/model-prompts.ts#L342)           | Builds the prompt text and system instruction for deep research                         |
| [buildPromptCapabilities](src/tools/research.ts#L212)                 | Maps active capabilities to prompt capability strings                                   |
| [getTaskEmitter](src/lib/tasks.ts#L67)                                | Returns the per-request task phase emitter                                              |
| [TOOL_LABELS](src/public-contract.ts#L468)                            | Label constants used for progress messages                                              |
| [toAskThinkingLevel](src/lib/tool-profiles.ts#L244)                   | Converts `ProfileThinkingLevel` ('low') to `AskThinkingLevel` ('LOW')                   |
| [MockGeminiEnvironment](__tests__/lib/mock-gemini-environment.ts#L63) | Test helper that stubs SDK methods; extended in TASK-003                                |
| [getGeminiModel](src/config.ts#L195)                                  | Returns the model name string used in every Gemini call                                 |
| [withRetry](src/lib/errors.ts#L290)                                   | Retry wrapper used by streaming path; not used in background path (SDK handles retries) |

### Existing commands

```bash
# Run all tests
npm run test

# Run a single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts

# Type-check
npm run type-check

# Full check suite (format + lint + type-check + knip + test + build)
node scripts/tasks.mjs
```

### Current behavior

`agenticSearchWork` in [src/tools/research.ts](src/tools/research.ts) calls `getAI().models.generateContentStream(...)` and pipes the result through `executor.runWithProgress`. This is a streaming path: the model must complete within a single HTTP connection window and every token is processed as it arrives. For deep-research topics this can run for several minutes, risking transport-level timeouts.

## 4. Implementation Phases

### PHASE-001: Interactions client helpers

**Goal:** `src/lib/interactions.ts` is created with all pure helpers for building, creating, polling, and converting background interactions; module type-checks cleanly.

|                                                  Task                                                  | Action                                                       |                                               Depends on                                               | Files                                              | Validate             |
| :----------------------------------------------------------------------------------------------------: | :----------------------------------------------------------- | :----------------------------------------------------------------------------------------------------: | :------------------------------------------------- | :------------------- |
| [`TASK-001`](#task-001-create-srclib-interactionsts-with-tool-mapping-and-createbackgroundinteraction) | Create helpers: tool mapping + `createBackgroundInteraction` |                                                  none                                                  | [src/lib/interactions.ts](src/lib/interactions.ts) | `npm run type-check` |
|   [`TASK-002`](#task-002-add-polluntilcomplete-extracttextfrominteraction-interactiontostreamresult)   | Add polling + extraction helpers                             | [`TASK-001`](#task-001-create-srclib-interactionsts-with-tool-mapping-and-createbackgroundinteraction) | [src/lib/interactions.ts](src/lib/interactions.ts) | `npm run type-check` |

#### TASK-001: Create src/lib/interactions.ts with tool mapping and createBackgroundInteraction

| Field      | Value                                                                                                                                           |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                            |
| Files      | Create: [src/lib/interactions.ts](src/lib/interactions.ts)                                                                                      |
| Symbols    | [getAI](src/client.ts#L238), [AppError](src/lib/errors.ts#L35)                                                                                  |
| Outcome    | `src/lib/interactions.ts` exports `builtInsToInteractionTools` and `createBackgroundInteraction`; `npm run type-check` passes with zero errors. |

- [ ] **Step 1: Apply change** (no prior code to test against)

```ts
// src/lib/interactions.ts
import type { Interactions } from '@google/genai';

import { getAI } from '../client.js';

const BUILT_IN_TO_INTERACTION_TOOL: Readonly<Partial<Record<string, Interactions.Tool>>> = {
  googleSearch: { type: 'google_search' },
  urlContext: { type: 'url_context' },
  codeExecution: { type: 'code_execution' },
};

/** Maps codebase BuiltInCapability names to Interactions API tool objects. */
export function builtInsToInteractionTools(builtIns: readonly string[]): Interactions.Tool[] {
  return builtIns.flatMap((b): Interactions.Tool[] => {
    const tool = BUILT_IN_TO_INTERACTION_TOOL[b];
    return tool ? [tool] : [];
  });
}

export interface BackgroundInteractionParams {
  model: string;
  input: string;
  tools?: Interactions.Tool[];
  thinkingLevel?: Interactions.ThinkingLevel;
  maxOutputTokens?: number;
  systemInstruction?: string;
}

export async function createBackgroundInteraction(
  params: BackgroundInteractionParams,
): Promise<Interactions.Interaction> {
  return getAI().interactions.create({
    model: params.model,
    input: params.input,
    background: true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    generation_config: {
      ...(params.thinkingLevel ? { thinking_level: params.thinkingLevel } : {}),
      ...(params.maxOutputTokens !== undefined
        ? { max_output_tokens: params.maxOutputTokens }
        : {}),
    },
    ...(params.systemInstruction ? { system_instruction: params.systemInstruction } : {}),
  });
}
```

- [ ] **Step 2: Run type-check to verify it passes**

```bash
npm run type-check
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/interactions.ts
git commit -m "feat(interactions): add builtInsToInteractionTools and createBackgroundInteraction helpers"
```

#### TASK-002: Add pollUntilComplete, extractTextFromInteraction, interactionToStreamResult

| Field      | Value                                                                                                                                                 |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-001`](#task-001-create-srclib-interactionsts-with-tool-mapping-and-createbackgroundinteraction)                                                |
| Files      | Modify: [src/lib/interactions.ts](src/lib/interactions.ts)                                                                                            |
| Symbols    | [AppError](src/lib/errors.ts#L35), [StreamResult](src/lib/streaming.ts#L60)                                                                           |
| Outcome    | `src/lib/interactions.ts` additionally exports `pollUntilComplete`, `extractTextFromInteraction`, and `interactionToStreamResult`; type-check passes. |

- [ ] **Step 1: Apply change**

First add two imports to the **top** of `src/lib/interactions.ts` inside the existing import block (after the `import { getAI }` line):

```ts
// src/lib/interactions.ts — add to import block at top of file
import { AppError } from './errors.js';
import type { StreamResult } from './streaming.js';
```

Then append the following **after** the existing `createBackgroundInteraction` export at the bottom of the file:

```ts
// src/lib/interactions.ts  — append after createBackgroundInteraction

const POLL_INTERVAL_MS = 3000;

/**
 * Polls ai.interactions.get until status leaves 'in_progress'.
 * Cancels and throws on AbortSignal. Calls onPoll after each sleep.
 */
export async function pollUntilComplete(
  interactionId: string,
  signal?: AbortSignal,
  onPoll?: () => Promise<void>,
): Promise<Interactions.Interaction> {
  const ai = getAI();
  let current = await ai.interactions.get(interactionId);

  while (current.status === 'in_progress') {
    if (signal?.aborted) {
      await ai.interactions.cancel(interactionId).catch(() => undefined);
      throw new AppError(
        'interactions',
        'Background interaction cancelled by abort signal',
        'cancelled',
        false,
      );
    }

    await interruptibleDelay(POLL_INTERVAL_MS, signal);
    if (onPoll) await onPoll();
    current = await ai.interactions.get(interactionId);
  }

  return current;
}

function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('abort'));
      },
      { once: true },
    );
  });
}

/** Joins all text-type outputs from a completed Interaction. */
export function extractTextFromInteraction(interaction: Interactions.Interaction): string {
  return (interaction.outputs ?? [])
    .filter((o): o is Interactions.TextContent => o.type === 'text')
    .map((o) => o.text)
    .join('');
}

/**
 * Converts a completed Interaction into a StreamResult so it can be passed
 * to existing responseBuilder callbacks (e.g. buildAgenticSearchResult).
 * Tool events and thought text are empty; usage metadata is not surfaced.
 */
export function interactionToStreamResult(interaction: Interactions.Interaction): StreamResult {
  const text = extractTextFromInteraction(interaction);
  return {
    text,
    textByWave: [text],
    thoughtText: '',
    parts: text ? [{ text }] : [],
    toolsUsed: [],
    toolsUsedOccurrences: [],
    functionCalls: [],
    toolEvents: [],
    hadCandidate: true,
  };
}
```

- [ ] **Step 2: Run type-check to verify it passes**

```bash
npm run type-check
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/interactions.ts
git commit -m "feat(interactions): add pollUntilComplete, extractTextFromInteraction, interactionToStreamResult"
```

---

### PHASE-002: Mock support and unit tests

**Goal:** `MockGeminiEnvironment` queues fake `Interaction` responses; unit tests for all five helpers in `src/lib/interactions.ts` pass.

|                                Task                                | Action                                             |                                             Depends on                                             | Files                                                                                    | Validate                                                                                        |
| :----------------------------------------------------------------: | :------------------------------------------------- | :------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
|   [`TASK-003`](#task-003-add-interactions-mock-to-mockgeminienv)   | Add `interactions` mock to `MockGeminiEnvironment` | [`TASK-002`](#task-002-add-polluntilcomplete-extracttextfrominteraction-interactiontostreamresult) | [\_\_tests\_\_/lib/mock-gemini-environment.ts](__tests__/lib/mock-gemini-environment.ts) | `npm run type-check`                                                                            |
| [`TASK-004`](#task-004-write-unit-tests-for-srclib-interactionsts) | Write unit tests for `src/lib/interactions.ts`     |                   [`TASK-003`](#task-003-add-interactions-mock-to-mockgeminienv)                   | [\_\_tests\_\_/lib/interactions.test.ts](__tests__/lib/interactions.test.ts)             | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts` |

#### TASK-003: Add interactions mock to MockGeminiEnvironment

| Field      | Value                                                                                                                                                  |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-add-polluntilcomplete-extracttextfrominteraction-interactiontostreamresult)                                                     |
| Files      | Modify: [\_\_tests\_\_/lib/mock-gemini-environment.ts](__tests__/lib/mock-gemini-environment.ts)                                                       |
| Symbols    | [MockGeminiEnvironment](__tests__/lib/mock-gemini-environment.ts#L63)                                                                                  |
| Outcome    | `MockGeminiEnvironment` exposes `queueInteraction` and `queuePollResponses`; `install()` stubs `ai.interactions.create/get/cancel`; type-check passes. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/interactions.test.ts  — temporary probe test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MockGeminiEnvironment } from './mock-gemini-environment.js';

test('MockGeminiEnvironment has queueInteraction', () => {
  const env = new MockGeminiEnvironment();
  assert.strictEqual(typeof env.queueInteraction, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: FAIL — `TypeError: env.queueInteraction is not a function`.

- [ ] **Step 3: Add mock support**

Add the following to [\_\_tests\_\_/lib/mock-gemini-environment.ts](__tests__/lib/mock-gemini-environment.ts):

In the class body, after the existing `private readonly streamQueue` field:

```ts
// mock-gemini-environment.ts — add these three fields after streamQueue
private readonly interactionQueue: Interactions.Interaction[] = [];
private readonly pollQueue: Map<string, Interactions.Interaction[]> = new Map();
private readonly cancelledIds: string[] = [];
```

Add the import at the top of the file (alongside the existing `@google/genai` imports):

```ts
import type { Interactions } from '@google/genai';
```

In `install()`, after the `this.client.models.generateContentStream = ...` block:

```ts
// install() — append after generateContentStream stub
this.client.interactions.create = async () => {
  const next = this.interactionQueue.shift();
  if (!next) {
    throw new Error('No mocked Interaction queued for interactions.create');
  }
  return next;
};

this.client.interactions.get = async (id: string) => {
  const responses = this.pollQueue.get(id) ?? [];
  const next = responses.shift();
  if (!next) {
    throw new Error(`No poll response queued for interaction id="${id}"`);
  }
  return next;
};

this.client.interactions.cancel = async (id: string) => {
  this.cancelledIds.push(id);
  return {};
};
```

In `uninstall()`, restore the original methods. After the existing restore block, add:

```ts
// uninstall() — restore interactions
this.client.interactions.create = this.originalCreate.bind(this.client.interactions);
this.client.interactions.get = this.originalGet.bind(this.client.interactions);
this.client.interactions.cancel = this.originalCancel.bind(this.client.interactions);
```

Add the saved originals as fields (after existing `private readonly` fields):

```ts
private readonly originalCreate = this.client.interactions.create.bind(
  this.client.interactions,
);
private readonly originalGet = this.client.interactions.get.bind(
  this.client.interactions,
);
private readonly originalCancel = this.client.interactions.cancel.bind(
  this.client.interactions,
);
```

Add public queue helpers at the end of the class body:

```ts
/** Queue an Interaction to be returned by the next interactions.create() call. */
queueInteraction(interaction: Interactions.Interaction): void {
  this.interactionQueue.push(interaction);
}

/**
 * Queue one or more Interactions to be returned by successive interactions.get(id) calls.
 * The first response is returned on the first get, second on the second, etc.
 */
queuePollResponses(id: string, ...responses: Interactions.Interaction[]): void {
  this.pollQueue.set(id, [...(this.pollQueue.get(id) ?? []), ...responses]);
}

get cancelledInteractionIds(): readonly string[] {
  return this.cancelledIds;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/mock-gemini-environment.ts __tests__/lib/interactions.test.ts
git commit -m "test(interactions): add interactions mock to MockGeminiEnvironment"
```

#### TASK-004: Write unit tests for src/lib/interactions.ts

| Field      | Value                                                                                                                                                                                                                                                                                                                                           |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-add-interactions-mock-to-mockgeminienv)                                                                                                                                                                                                                                                                                  |
| Files      | Create: [\_\_tests\_\_/lib/interactions.test.ts](__tests__/lib/interactions.test.ts)                                                                                                                                                                                                                                                            |
| Symbols    | [MockGeminiEnvironment](__tests__/lib/mock-gemini-environment.ts#L63), [builtInsToInteractionTools](src/lib/interactions.ts), [createBackgroundInteraction](src/lib/interactions.ts), [pollUntilComplete](src/lib/interactions.ts), [extractTextFromInteraction](src/lib/interactions.ts), [interactionToStreamResult](src/lib/interactions.ts) |
| Outcome    | All six `describe` blocks in `interactions.test.ts` pass; `npm run type-check` is clean.                                                                                                                                                                                                                                                        |

- [ ] **Step 1: Write the failing tests**

Replace the probe test in `__tests__/lib/interactions.test.ts` with the full suite:

```ts
// __tests__/lib/interactions.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Interactions } from '@google/genai';

import {
  builtInsToInteractionTools,
  createBackgroundInteraction,
  extractTextFromInteraction,
  interactionToStreamResult,
  pollUntilComplete,
} from '../../src/lib/interactions.js';
import { MockGeminiEnvironment } from './mock-gemini-environment.js';

function makeInteraction(
  id: string,
  status: Interactions.Interaction['status'],
  outputs: Interactions.Content[] = [],
): Interactions.Interaction {
  return { id, status, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', outputs };
}

function makeTextContent(text: string): Interactions.TextContent {
  return { type: 'text', text };
}

describe('builtInsToInteractionTools', () => {
  it('maps known built-ins to tool objects', () => {
    const tools = builtInsToInteractionTools(['googleSearch', 'urlContext', 'codeExecution']);
    assert.deepStrictEqual(tools, [
      { type: 'google_search' },
      { type: 'url_context' },
      { type: 'code_execution' },
    ]);
  });

  it('silently ignores unknown built-in names', () => {
    const tools = builtInsToInteractionTools(['unknown', 'googleSearch']);
    assert.deepStrictEqual(tools, [{ type: 'google_search' }]);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(builtInsToInteractionTools([]), []);
  });
});

describe('createBackgroundInteraction', () => {
  const env = new MockGeminiEnvironment();
  before(() => env.install());
  after(() => env.uninstall());

  it('calls interactions.create and returns the queued Interaction', async () => {
    const expected = makeInteraction('ia-1', 'in_progress');
    env.queueInteraction(expected);

    const result = await createBackgroundInteraction({
      model: 'gemini-3-flash-preview',
      input: 'test input',
    });

    assert.strictEqual(result.id, 'ia-1');
    assert.strictEqual(result.status, 'in_progress');
  });
});

describe('pollUntilComplete', () => {
  const env = new MockGeminiEnvironment();
  before(() => env.install());
  after(() => env.uninstall());

  it('returns immediately when first get returns completed', async () => {
    const initial = makeInteraction('ia-2', 'in_progress');
    const done = makeInteraction('ia-2', 'completed', [makeTextContent('result')]);

    env.queueInteraction(initial);
    env.queuePollResponses('ia-2', done);

    await createBackgroundInteraction({ model: 'gemini-3-flash-preview', input: 'q' });
    const result = await pollUntilComplete('ia-2', undefined, undefined);

    assert.strictEqual(result.status, 'completed');
  });

  it('cancels and throws when AbortSignal fires during poll delay', async () => {
    const initial = makeInteraction('ia-3', 'in_progress');
    const stillRunning = makeInteraction('ia-3', 'in_progress');

    env.queueInteraction(initial);
    env.queuePollResponses('ia-3', stillRunning);

    const ac = new AbortController();
    // Abort before pollUntilComplete's first get call
    ac.abort();

    await createBackgroundInteraction({ model: 'gemini-3-flash-preview', input: 'q' });
    await assert.rejects(
      () => pollUntilComplete('ia-3', ac.signal),
      (err: Error) => err.message.includes('cancelled'),
    );

    assert.ok(env.cancelledInteractionIds.includes('ia-3'));
  });
});

describe('extractTextFromInteraction', () => {
  it('joins text outputs', () => {
    const interaction = makeInteraction('ia-4', 'completed', [
      makeTextContent('hello '),
      makeTextContent('world'),
    ]);
    assert.strictEqual(extractTextFromInteraction(interaction), 'hello world');
  });

  it('returns empty string when outputs is empty', () => {
    const interaction = makeInteraction('ia-5', 'completed', []);
    assert.strictEqual(extractTextFromInteraction(interaction), '');
  });

  it('ignores non-text outputs', () => {
    const interaction = makeInteraction('ia-6', 'completed', [
      { type: 'google_search_call', arguments: {} } as unknown as Interactions.Content,
      makeTextContent('answer'),
    ]);
    assert.strictEqual(extractTextFromInteraction(interaction), 'answer');
  });
});

describe('interactionToStreamResult', () => {
  it('produces a StreamResult with text and hadCandidate true', () => {
    const interaction = makeInteraction('ia-7', 'completed', [makeTextContent('output')]);
    const result = interactionToStreamResult(interaction);

    assert.strictEqual(result.text, 'output');
    assert.strictEqual(result.hadCandidate, true);
    assert.deepStrictEqual(result.toolsUsed, []);
    assert.deepStrictEqual(result.functionCalls, []);
  });

  it('produces empty parts when text is empty', () => {
    const interaction = makeInteraction('ia-8', 'completed', []);
    const result = interactionToStreamResult(interaction);
    assert.deepStrictEqual(result.parts, []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: FAIL — import of `builtInsToInteractionTools` from `interactions.js` succeeds (file exists from TASK-001/002), but `MockGeminiEnvironment.queueInteraction` is already added (TASK-003), so failures are only for missing queue/cancel assertions. If TASK-001–003 are done, tests may pass on first run; proceed to Step 4 directly if so.

- [ ] **Step 3: No additional implementation needed** — `src/lib/interactions.ts` was fully written in TASK-001 and TASK-002.

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

Expected: PASS — all six `describe` blocks with zero failures.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/interactions.test.ts
git commit -m "test(interactions): unit tests for interactions.ts helpers"
```

---

### PHASE-003: Wire agenticSearchWork to the background path

**Goal:** `agenticSearchWork` for `searchDepth < 3` calls `createBackgroundInteraction` + `pollUntilComplete` instead of `generateContentStream`; existing tests continue to pass.

|                                                  Task                                                  | Action                                             |                             Depends on                             | Files                                                                                                                    | Validate                                                       |
| :----------------------------------------------------------------------------------------------------: | :------------------------------------------------- | :----------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------- |
| [`TASK-005`](#task-005-replace-generatecontentstream-in-agenticsearchwork-with-background-interaction) | Replace streaming call with background interaction | [`TASK-004`](#task-004-write-unit-tests-for-srclib-interactionsts) | [src/tools/research.ts](src/tools/research.ts), [\_\_tests\_\_/tools/research.test.ts](__tests__/tools/research.test.ts) | `node scripts/tasks.mjs --quick` then `node scripts/tasks.mjs` |

#### TASK-005: Replace generateContentStream in agenticSearchWork with background interaction

| Field      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | [`TASK-004`](#task-004-write-unit-tests-for-srclib-interactionsts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Files      | Modify: [src/tools/research.ts](src/tools/research.ts); Modify: [\_\_tests\_\_/tools/research.test.ts](__tests__/tools/research.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Symbols    | [agenticSearchWork](src/tools/research.ts#L906), [createBackgroundInteraction](src/lib/interactions.ts), [pollUntilComplete](src/lib/interactions.ts), [interactionToStreamResult](src/lib/interactions.ts), [builtInsToInteractionTools](src/lib/interactions.ts), [buildAgenticSearchResult](src/tools/research.ts#L225), [buildAgenticResearchPrompt](src/lib/model-prompts.ts#L342), [getTaskEmitter](src/lib/tasks.ts#L67), [sendProgress](src/lib/progress.ts#L233), [PROGRESS_TOTAL](src/lib/progress.ts#L14), [TOOL_LABELS](src/public-contract.ts#L468), [AppError](src/lib/errors.ts#L35), [getGeminiModel](src/config.ts#L195), [getWorkSignal](src/lib/work-signal.ts#L7) |
| Outcome    | `agenticSearchWork` creates a background Interaction, polls with progress, converts to `StreamResult`, and calls `buildAgenticSearchResult`; existing `research.test.ts` tests pass after mock update.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

- [ ] **Step 1: Write the failing test**

Open [\_\_tests\_\_/tools/research.test.ts](__tests__/tools/research.test.ts) and find the existing test block that covers the `deep` research mode (search for `mode: 'deep'` or `agenticSearchWork`). Add or update a test that queues an `Interaction` instead of a stream.

Add at the end of the existing research test file (or inside the relevant `describe` block):

```ts
// __tests__/tools/research.test.ts  — add inside the file's existing setup
// This test asserts the new background path is taken for mode='deep', searchDepth<3.
// It will fail until agenticSearchWork is updated in Step 3.

it('deep mode uses background interaction for searchDepth=1', async (t) => {
  // Queue the enrichment stream (used by enrichTopicWithSampling) first
  env.queueStream(makeChunk([{ text: 'enriched topic' }], FinishReason.STOP));

  // Queue the background interaction (what the new path creates)
  const backgroundInteraction: Interactions.Interaction = {
    id: 'bg-test-1',
    status: 'in_progress',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  };
  env.queueInteraction(backgroundInteraction);

  // Queue the poll response (completed)
  env.queuePollResponses('bg-test-1', {
    ...backgroundInteraction,
    status: 'completed',
    outputs: [{ type: 'text', text: 'deep research result' }],
  });

  const result = await callTool(client, 'research', {
    goal: 'test topic',
    mode: 'deep',
    searchDepth: 1,
  });

  assert.ok(!result.isError, `Expected success, got: ${JSON.stringify(result)}`);
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  assert.ok(text.includes('deep research result'), `Expected result text, got: ${text}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/research.test.ts
```

Expected: FAIL — either `No mocked Interaction queued` (because `agenticSearchWork` still calls `generateContentStream`) or the result text does not contain `deep research result`.

- [ ] **Step 3: Update agenticSearchWork**

In [src/tools/research.ts](src/tools/research.ts), add the new imports at the top of the file alongside existing lib imports:

```ts
// src/tools/research.ts — add to imports block
import {
  builtInsToInteractionTools,
  createBackgroundInteraction,
  interactionToStreamResult,
  pollUntilComplete,
} from '../lib/interactions.js';
```

Locate `agenticSearchWork` at [src/tools/research.ts#L906](src/tools/research.ts#L906). Replace the body from after the `buildAgenticResearchPrompt` call through `return result;` (the section that calls `executor.runWithProgress`) with the background interaction path. The complete replacement target is:

```ts
// BEFORE (lines roughly 973–1002 inside agenticSearchWork):
await tasks.phase('retrieving');
const result = await executor.runWithProgress(ctx, {
  toolKey: 'research',
  label: TOOL_LABELS.agenticSearch,
  initialMsg: 'Starting deep research',
  logMessage: 'Agentic search requested',
  logData: { topic, searchDepth },
  generator: () =>
    getAI().models.generateContentStream({
      model: getGeminiModel(),
      contents: prompt.promptText,
      config: buildGenerateContentConfig(
        {
          systemInstruction: prompt.systemInstruction,
          costProfile: 'research.quick',
          thinkingLevel,
          thinkingBudget,
          maxOutputTokens,
          safetySettings,
          tools,
          toolConfig,
        },
        getWorkSignal(ctx),
      ),
    }),
  responseBuilder: (streamResult, textContent) =>
    buildAgenticSearchResult(streamResult, textContent, ctx, searchDepth, searchDepth),
});
await tasks.phase('finalizing');
return result;
```

Replace with:

```ts
// AFTER
const builtIns = resolved.config.resolvedProfile?.builtIns ?? [];
const interactionTools = builtInsToInteractionTools(builtIns);
const interactionThinkingLevel =
  (thinkingLevel?.toLowerCase() as Interactions.ThinkingLevel | undefined) ?? 'medium';

await tasks.phase('retrieving');
const backgroundInteraction = await createBackgroundInteraction({
  model: getGeminiModel(),
  input: prompt.promptText,
  tools: interactionTools,
  thinkingLevel: interactionThinkingLevel,
  ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  systemInstruction: prompt.systemInstruction,
});

let pollCount = 0;
const polledInteraction = await pollUntilComplete(
  backgroundInteraction.id,
  getWorkSignal(ctx),
  async () => {
    pollCount += 1;
    await sendProgress(
      ctx,
      Math.min(10 + pollCount * 8, 85),
      PROGRESS_TOTAL,
      `${TOOL_LABELS.agenticSearch}: Research in progress…`,
    );
  },
);

if (polledInteraction.status !== 'completed') {
  return new AppError(
    'research',
    `Background research ended with unexpected status: ${polledInteraction.status}`,
    'internal',
    true,
  ).toToolResult();
}

await tasks.phase('finalizing');
const streamResult = interactionToStreamResult(polledInteraction);
const textContent = streamResult.text;
const built = buildAgenticSearchResult(streamResult, textContent, ctx, searchDepth, searchDepth);
const overlayCont = built.resultMod
  ? (built.resultMod({ content: [{ type: 'text', text: textContent }] }).content ?? [])
  : [];
return {
  content: [{ type: 'text', text: textContent }, ...overlayCont],
  ...(built.structuredContent !== undefined ? { structuredContent: built.structuredContent } : {}),
};
```

Also add `Interactions` to the import at the top of `research.ts`:

```ts
import type { Interactions } from '@google/genai';
```

And add `sendProgress` and `PROGRESS_TOTAL` to imports if not already present:

```ts
import { PROGRESS_TOTAL, sendProgress } from '../lib/progress.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/research.test.ts
```

Expected: PASS — all tests including the new background interaction test pass.

Then run the full suite:

```bash
node scripts/tasks.mjs
```

Expected: all tasks green, zero type errors, zero lint errors, zero test failures.

- [ ] **Step 5: Commit**

```bash
git add src/tools/research.ts __tests__/tools/research.test.ts
git commit -m "feat(research): replace agenticSearchWork streaming call with background interaction"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — `src/lib/interactions.ts` unit tests all pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/interactions.test.ts
```

### [`VAL-002`](#5-testing--validation) — No TypeScript errors across the project

```bash
npm run type-check
```

### [`VAL-003`](#5-testing--validation) — Full task suite green

```bash
node scripts/tasks.mjs
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                               |
| :--------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | `npm run type-check` reports zero errors after all tasks complete.                                                                                               |
| [`AC-002`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 with all checks green.                                                                                                          |
| [`AC-003`](#6-acceptance-criteria) | `__tests__/lib/interactions.test.ts` contains tests for all five exported functions and all pass.                                                                |
| [`AC-004`](#6-acceptance-criteria) | `agenticSearchWork` in [src/tools/research.ts](src/tools/research.ts) no longer contains a call to `getAI().models.generateContentStream` for `searchDepth < 3`. |
| [`AC-005`](#6-acceptance-criteria) | When a `MockGeminiEnvironment` queues a completed `Interaction` for a deep research call, the `CallToolResult` text contains the interaction's text output.      |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                                                          |
| :---------------------------: | :--: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | `ai.interactions` is experimental; the SDK prints a deprecation-style warning to stderr on first access. This does not affect stdio MCP transport (stdout-only) but will appear in logs. No mitigation needed — the warning is informational.                                                                                                   |
| [`RISK-002`](#7-risks--notes) | Risk | Background interactions do not emit per-token streaming events, so `toolEvents`, `groundingMetadata`, and `urlContextMetadata` in the resulting `StreamResult` are empty. `buildAgenticSearchResult` logic that reads `streamResult.toolsUsed` will see an empty list, meaning citation/source formatting is absent. This is a known trade-off. |
| [`RISK-003`](#7-risks--notes) | Risk | `pollUntilComplete` uses a fixed 3-second interval. Very long research tasks (>10 minutes) will send many progress notifications. The MCP spec has no notification rate limit, but aggressive clients may log warnings.                                                                                                                         |
| [`NOTE-001`](#7-risks--notes) | Note | `runDeepResearchPlan` ([src/tools/research.ts#L586](src/tools/research.ts#L586)) is not touched — it handles `searchDepth >= 3` via multi-step orchestration and continues to use `generateContentStream`.                                                                                                                                      |
| [`NOTE-002`](#7-risks--notes) | Note | The `Interactions` namespace type import (`import type { Interactions } from '@google/genai'`) works for TypeScript type checking even though `Interactions` is not a runtime value export. Do not attempt `import { Interactions }` (value import) — it will throw at runtime.                                                                 |
| [`NOTE-003`](#7-risks--notes) | Note | `thinkingBudget` is not forwarded to the Interactions API. The `GenerationConfig_2` for interactions does not expose a `thinking_budget` field; only `thinking_level` is available.                                                                                                                                                             |
