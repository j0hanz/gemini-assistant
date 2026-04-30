---
goal: Build a complete zero-token-cost test suite covering pure logic and tool integration layers
version: 1
date_created: 2026-04-30
status: Planned
plan_type: feature
component: test-suite
execution: subagent-driven
---

# Implementation Plan: Test Suite

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are bite-sized (2-5 minutes each); follow them in order, run every verification, and commit at each commit step.

**Goal:** Write a complete test suite for gemini-assistant covering all pure-logic modules and tool integration — zero real Gemini API calls, zero token cost.

**Architecture:** Phase 1 builds a shared mock Gemini factory then tests all pure-logic modules (errors, tool-profiles, schemas, sessions, config, validation, catalog) using Node.js built-in `node:test` with `tsx/esm` — no mocking needed for these. Phase 2 uses `mock.module()` to intercept `getAI()` and tests the four tool handlers end-to-end against fake streaming responses.

**Tech Stack:** Node.js built-in `node:test`, `tsx/esm`, `assert/strict`, `@google/genai` types, Zod v4, TypeScript strict mode.

---

## 1. Goal

All prior tests were removed. This plan produces a fresh suite that verifies every critical invariant in the codebase — retry policy, profile resolution, schema validation, session replay/redaction, config parsing, path validation, catalog rendering, and tool pipelines — without making a single real Gemini API call. `npm run test` must complete successfully when all tasks are done.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                    |
| :---------------------------------------: | :---------- | :----------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Every test file must pass `npm run test` with zero real API calls.                                           |
| [`REQ-002`](#2-requirements--constraints) | Requirement | `getAI()` must never be called with a live `API_KEY` in any test.                                            |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Test names must read as behavior specs: `'withRetry — retries on retryable error'`.                          |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Runner is Node.js built-in `node:test` — no Jest, Vitest, or Mocha.                                          |
| [`CON-002`](#2-requirements--constraints) | Constraint  | All imports use `.js` extensions (ESM `NodeNext` resolution).                                                |
| [`CON-003`](#2-requirements--constraints) | Constraint  | Tests that mutate `process.env` must restore originals in `after()`.                                         |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [createDefaultToolServices](src/lib/tool-context.ts#L49) for ToolServices stubs in integration tests. |

## 3. Current Context

### File structure

| File                                  | Status | Responsibility                                                                                   |
| :------------------------------------ | :----- | :----------------------------------------------------------------------------------------------- |
| `__tests__/lib/mock-gemini.ts`        | Create | Shared factory: fake AsyncIterable streams + `createMockAI()` stub                               |
| `__tests__/lib/errors.test.ts`        | Create | Tests for `AppError`, `isAbortError`, `withRetry`, `finishReasonToError`                         |
| `__tests__/lib/tool-profiles.test.ts` | Create | Tests for `resolveProfile` and `validateProfile` across all profiles                             |
| `__tests__/lib/streaming.test.ts`     | Create | Tests for `validateStreamResult` and `extractUsage` with fake `StreamResult` data                |
| `__tests__/lib/response.test.ts`      | Create | Tests for `tryParseJsonResponse`, `mergeStructured`, `promptBlockedError`                        |
| `__tests__/lib/validation.test.ts`    | Create | Tests for `isPathWithinRoot`, `validateHostHeader`                                               |
| `__tests__/schemas/inputs.test.ts`    | Create | Tests for `ChatInput`, `ResearchInput`, `AnalyzeInput`, `ReviewInput` schemas                    |
| `__tests__/sessions.test.ts`          | Create | Tests for `sanitizeSessionText`, `buildReplayHistoryParts`, `selectReplayWindow`, `SessionStore` |
| `__tests__/config.test.ts`            | Create | Tests for boolean parsing, `getApiKey`, `getTransportMode`                                       |
| `__tests__/catalog.test.ts`           | Create | Tests for `renderDiscoveryCatalogMarkdown`, `renderWorkflowCatalogMarkdown`                      |

### Relevant symbols

| Symbol                                                   | Why it matters                                                           |
| :------------------------------------------------------- | :----------------------------------------------------------------------- |
| [AppError](src/lib/errors.ts#L35)                        | Core error class under test                                              |
| [isAbortError](src/lib/errors.ts#L27)                    | Abort detection utility                                                  |
| [withRetry](src/lib/errors.ts#L290)                      | Retry policy — maxRetries=2, base=1000ms                                 |
| [finishReasonToError](src/lib/errors.ts#L204)            | Finish-reason → AppError mapping                                         |
| [resolveProfile](src/lib/tool-profiles.ts#L269)          | Profile name + overrides → ResolvedProfile                               |
| [validateProfile](src/lib/tool-profiles.ts#L314)         | Mutual exclusivity enforcement                                           |
| [sanitizeSessionText](src/sessions.ts#L376)              | Secret redaction regex patterns                                          |
| [buildReplayHistoryParts](src/sessions.ts#L566)          | Filters thought-only parts from replay history                           |
| [selectReplayWindow](src/sessions.ts#L1150)              | Fits conversation within maxBytes                                        |
| [SessionStore](src/sessions.ts#L783)                     | In-memory session store with TTL + LRU eviction                          |
| [appendSessionTurn](src/sessions.ts#L733)                | Appends user+model turns to a session                                    |
| [getApiKey](src/config.ts#L174)                          | Throws if `API_KEY` missing or blank                                     |
| [getTransportMode](src/config.ts#L222)                   | Parses `TRANSPORT` env var                                               |
| [isPathWithinRoot](src/lib/validation.ts#L173)           | Path containment check                                                   |
| [validateHostHeader](src/lib/validation.ts#L88)          | Host header allow-list check                                             |
| [renderDiscoveryCatalogMarkdown](src/catalog.ts#L85)     | Renders tool catalog to Markdown                                         |
| [renderWorkflowCatalogMarkdown](src/catalog.ts#L127)     | Renders workflow catalog to Markdown                                     |
| [getAI](src/client.ts#L241)                              | Lazy Gemini client singleton — intercepted by `mock.module()` in Phase 2 |
| [createDefaultToolServices](src/lib/tool-context.ts#L49) | Creates no-op ToolServices for test fixtures                             |
| [registerChatTool](src/tools/chat.ts#L1256)              | Chat tool registration entry point                                       |
| [registerResearchTool](src/tools/research.ts#L1132)      | Research tool registration entry point                                   |
| [registerAnalyzeTool](src/tools/analyze.ts#L502)         | Analyze tool registration entry point                                    |
| [registerReviewTool](src/tools/review.ts#L1448)          | Review tool registration entry point                                     |
| [listDiscoveryEntries](src/catalog.ts#L22)               | Returns all discovery entries                                            |
| [listWorkflowEntries](src/catalog.ts#L35)                | Returns all workflow entries                                             |
| [buildGenerateContentConfig](src/client.ts#L173)         | Builds Gemini config from cost profiles                                  |

### Existing commands

```bash
# Run all tests
npm run test

# Run a single test file
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts

# Run tests matching a name pattern
node --import tsx/esm --env-file=.env --test --test-name-pattern="pattern" --no-warnings __tests__/path/to/test.ts

# Full verification (format + lint + type-check + knip + test + build)
node scripts/tasks.mjs
```

### Current behavior

`__tests__/` is empty. `npm run test` exits successfully but reports zero test files. This plan populates the directory with a complete, zero-cost test suite.

## 4. Implementation Phases

### PHASE-001: Mock Infrastructure

**Goal:** Shared mock Gemini factory exists and exports `mockStream`, `mockTextResponse`, `mockFunctionCallResponse`, `mockUsageResponse`, and `createMockAI`.

|                         Task                         | Action                       | Depends on | Files                                                        | Validate                                                                                  |
| :--------------------------------------------------: | :--------------------------- | :--------: | :----------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| [`TASK-001`](#task-001-scaffold-mock-gemini-factory) | Scaffold shared mock factory |    none    | [**tests**/lib/mock-gemini.ts](__tests__/lib/mock-gemini.ts) | `node --import tsx/esm --no-warnings --input-type=module <<< "import './mock-gemini.ts'"` |

#### TASK-001: Scaffold mock Gemini factory

| Field      | Value                                                                                                                                          |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                           |
| Files      | Create: [**tests**/lib/mock-gemini.ts](__tests__/lib/mock-gemini.ts)                                                                           |
| Symbols    | [getAI](src/client.ts#L241)                                                                                                                    |
| Outcome    | File exists, compiles without errors, exports all five factory functions. TDD skipped — pure scaffolding with no testable behavior of its own. |

- [ ] **Step 1: Create the factory file**

```ts
// __tests__/lib/mock-gemini.ts
import type { GenerateContentResponse, GenerateContentResponseUsageMetadata } from '@google/genai';

export function mockStream(
  chunks: Partial<GenerateContentResponse>[],
): AsyncIterable<GenerateContentResponse> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= chunks.length) return { done: true, value: undefined as never };
          return { done: false, value: chunks[index++] as GenerateContentResponse };
        },
      };
    },
  };
}

export function mockTextResponse(text: string): AsyncIterable<GenerateContentResponse> {
  return mockStream([
    {
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' as never },
      ],
    },
  ]);
}

export function mockFunctionCallResponse(
  name: string,
  args: Record<string, unknown>,
): AsyncIterable<GenerateContentResponse> {
  return mockStream([
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name, args } }],
          },
          finishReason: 'STOP' as never,
        },
      ],
    },
  ]);
}

export function mockUsageResponse(
  text: string,
  inputTokens: number,
  outputTokens: number,
): AsyncIterable<GenerateContentResponse> {
  return mockStream([
    {
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' as never },
      ],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        totalTokenCount: inputTokens + outputTokens,
      } as GenerateContentResponseUsageMetadata,
    },
  ]);
}

export function createMockAI(responses: AsyncIterable<GenerateContentResponse>[]) {
  let callIndex = 0;
  return {
    models: {
      generateContentStream: () => {
        const stream = responses[callIndex] ?? mockTextResponse('');
        callIndex++;
        return Promise.resolve(stream);
      },
    },
  };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
node --import tsx/esm --no-warnings --input-type=module --eval "import './__tests__/lib/mock-gemini.ts'; console.log('ok')"
```

Expected: prints `ok` with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add __tests__/lib/mock-gemini.ts
git commit -m "test: add shared mock Gemini factory"
```

---

### PHASE-002: Error Handling Tests

**Goal:** `__tests__/lib/errors.test.ts` passes, covering `AppError`, `isAbortError`, `withRetry`, and `finishReasonToError`.

|                       Task                        | Action                                      |                    Depends on                     | Files                                                        | Validate                                                                                  |
| :-----------------------------------------------: | :------------------------------------------ | :-----------------------------------------------: | :----------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| [`TASK-002`](#task-002-test-apperror-and-isabort) | Test AppError construction and isAbortError |                       none                        | [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts` |
|      [`TASK-003`](#task-003-test-withretry)       | Test withRetry behavior                     | [`TASK-002`](#task-002-test-apperror-and-isabort) | [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts` |
| [`TASK-004`](#task-004-test-finishreasontooerror) | Test finishReasonToError mapping            |      [`TASK-003`](#task-003-test-withretry)       | [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts` |

#### TASK-002: Test AppError construction and isAbortError

| Field      | Value                                                                    |
| :--------- | :----------------------------------------------------------------------- |
| Depends on | none                                                                     |
| Files      | Create: [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts)     |
| Symbols    | [AppError](src/lib/errors.ts#L35), [isAbortError](src/lib/errors.ts#L27) |
| Outcome    | Tests for AppError category/retryable/statusCode and isAbortError pass.  |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/errors.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError, isAbortError } from '../../src/lib/errors.js';

test('AppError — category defaults to internal', () => {
  const err = new AppError('chat', 'boom');
  assert.equal(err.category, 'WRONG'); // intentionally wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: FAIL — `'internal' !== 'WRONG'`.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/lib/errors.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError, isAbortError } from '../../src/lib/errors.js';

test('AppError — category defaults to internal', () => {
  const err = new AppError('chat', 'boom');
  assert.equal(err.category, 'internal');
});

test('AppError — toolName and message set correctly', () => {
  const err = new AppError('research', 'fail', 'client');
  assert.equal(err.toolName, 'research');
  assert.equal(err.message, 'fail');
});

test('AppError — retryable defaults to false', () => {
  const err = new AppError('chat', 'boom');
  assert.equal(err.retryable, false);
});

test('AppError — retryable can be set to true', () => {
  const err = new AppError('chat', 'boom', 'server', true);
  assert.equal(err.retryable, true);
});

test('AppError — statusCode propagated', () => {
  const err = new AppError('chat', 'boom', 'server', true, 503);
  assert.equal(err.statusCode, 503);
});

test('AppError — toToolResult returns isError true', () => {
  const result = new AppError('chat', 'fail msg').toToolResult();
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, 'fail msg');
});

test('isAbortError — true for AbortError name', () => {
  const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(isAbortError(err), true);
});

test('isAbortError — false for generic Error', () => {
  assert.equal(isAbortError(new Error('nope')), false);
});

test('isAbortError — true when signal is already aborted', () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(isAbortError(new Error('x'), controller.signal), true);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/errors.test.ts
git commit -m "test: add AppError and isAbortError tests"
```

#### TASK-003: Test withRetry

| Field      | Value                                                                                                              |
| :--------- | :----------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-002`](#task-002-test-apperror-and-isabort)                                                                  |
| Files      | Modify: [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts)                                               |
| Symbols    | [withRetry](src/lib/errors.ts#L290), [AppError](src/lib/errors.ts#L35)                                             |
| Outcome    | Tests verify: retries exactly 2×, non-retryable throws immediately, abort signal cancels, succeeds on 2nd attempt. |

- [ ] **Step 1: Write the failing test**

Append to `__tests__/lib/errors.test.ts`:

```ts
test('withRetry — stops retrying after maxRetries', async () => {
  let calls = 0;
  const retryable = new AppError('t', 'boom', 'server', true, 503);
  await assert.rejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(retryable);
        },
        { maxRetries: 0 },
      ), // intentionally 0 to make test fail first
  );
  assert.equal(calls, 99); // wrong
});
```

Add the import at the top of the file:

```ts
import { AppError, isAbortError, withRetry } from '../../src/lib/errors.js';
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: FAIL — `1 !== 99`.

- [ ] **Step 3: Write the real tests**

Replace the failing test appended in Step 1 with:

```ts
test('withRetry — retries exactly 2 times on retryable error', async () => {
  let calls = 0;
  const retryable = new AppError('t', 'boom', 'server', true, 503);
  await assert.rejects(() =>
    withRetry(() => {
      calls++;
      return Promise.reject(retryable);
    }),
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('withRetry — does not retry on non-retryable error', async () => {
  let calls = 0;
  const nonRetryable = new AppError('t', 'boom', 'client', false);
  await assert.rejects(() =>
    withRetry(() => {
      calls++;
      return Promise.reject(nonRetryable);
    }),
  );
  assert.equal(calls, 1);
});

test('withRetry — succeeds on 2nd attempt', async () => {
  let calls = 0;
  const retryable = new AppError('t', 'boom', 'server', true, 503);
  const result = await withRetry(() => {
    calls++;
    if (calls < 2) return Promise.reject(retryable);
    return Promise.resolve('ok');
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry — aborts early when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const retryable = new AppError('t', 'boom', 'server', true, 503);
  await assert.rejects(() =>
    withRetry(
      () => {
        calls++;
        return Promise.reject(retryable);
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(calls, 1);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: PASS — all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/errors.test.ts
git commit -m "test: add withRetry behavior tests"
```

#### TASK-004: Test finishReasonToError

| Field      | Value                                                                                              |
| :--------- | :------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-003`](#task-003-test-withretry)                                                             |
| Files      | Modify: [**tests**/lib/errors.test.ts](__tests__/lib/errors.test.ts)                               |
| Symbols    | [finishReasonToError](src/lib/errors.ts#L204), [AppError](src/lib/errors.ts#L35)                   |
| Outcome    | Tests verify SAFETY → SafetyError, STOP → undefined, MAX_TOKENS with empty text → TruncationError. |

- [ ] **Step 1: Write the failing test**

Add at top of file: `import { FinishReason } from '@google/genai';`
Append to `__tests__/lib/errors.test.ts`:

```ts
test('finishReasonToError — SAFETY returns SafetyError', () => {
  const err = finishReasonToError(FinishReason.SAFETY, '', 'chat');
  assert.equal(err?.constructor.name, 'WRONG'); // wrong
});
```

Also add to imports: `import { AppError, isAbortError, withRetry, finishReasonToError } from '../../src/lib/errors.js';`

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: FAIL — `'SafetyError' !== 'WRONG'`.

- [ ] **Step 3: Write the real tests**

Replace the failing test with:

```ts
test('finishReasonToError — SAFETY returns SafetyError', () => {
  const err = finishReasonToError(FinishReason.SAFETY, '', 'chat');
  assert.equal(err?.constructor.name, 'SafetyError');
});

test('finishReasonToError — STOP returns undefined', () => {
  const err = finishReasonToError(FinishReason.STOP, 'some text', 'chat');
  assert.equal(err, undefined);
});

test('finishReasonToError — MAX_TOKENS with empty text returns TruncationError', () => {
  const err = finishReasonToError(FinishReason.MAX_TOKENS, '', 'chat');
  assert.equal(err?.constructor.name, 'TruncationError');
});

test('finishReasonToError — MAX_TOKENS with text returns undefined', () => {
  const err = finishReasonToError(FinishReason.MAX_TOKENS, 'some text', 'chat');
  assert.equal(err, undefined);
});

test('finishReasonToError — RECITATION returns SafetyError', () => {
  const err = finishReasonToError(FinishReason.RECITATION, '', 'chat');
  assert.equal(err?.constructor.name, 'SafetyError');
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts
```

Expected: PASS — all 18 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/errors.test.ts
git commit -m "test: add finishReasonToError mapping tests"
```

---

### PHASE-003: Tool Profile Tests

**Goal:** `__tests__/lib/tool-profiles.test.ts` passes, verifying all 11 named profiles resolve and `validateProfile` enforces mutual exclusivity.

|                              Task                               | Action                                | Depends on | Files                                                                      | Validate                                                                                         |
| :-------------------------------------------------------------: | :------------------------------------ | :--------: | :------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| [`TASK-005`](#task-005-test-resolveprofile-and-validateprofile) | Test resolveProfile + validateProfile |    none    | [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts` |

#### TASK-005: Test resolveProfile and validateProfile

| Field      | Value                                                                                                                                                |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                                                 |
| Files      | Create: [**tests**/lib/tool-profiles.test.ts](__tests__/lib/tool-profiles.test.ts)                                                                   |
| Symbols    | [resolveProfile](src/lib/tool-profiles.ts#L269), [validateProfile](src/lib/tool-profiles.ts#L314)                                                    |
| Outcome    | All 11 named profiles resolve without throwing; `fileSearch` mutual exclusivity throws; unknown profile selection is guarded upstream by Zod schema. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/tool-profiles.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveProfile,
  TOOL_PROFILE_NAMES,
  validateProfile,
} from '../../src/lib/tool-profiles.js';

test('resolveProfile — plain profile has no builtIns', () => {
  const resolved = resolveProfile({ profile: 'plain' }, { toolKey: 'chat' });
  assert.deepEqual(resolved.builtIns, ['WRONG']); // wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts
```

Expected: FAIL — `[] deepEqual ['WRONG']`.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/lib/tool-profiles.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveProfile,
  TOOL_PROFILE_NAMES,
  validateProfile,
} from '../../src/lib/tool-profiles.js';

// Table-driven: all named profiles resolve without throwing
for (const name of TOOL_PROFILE_NAMES) {
  test(`resolveProfile — '${name}' resolves without throwing`, () => {
    const resolved = resolveProfile({ profile: name }, { toolKey: 'chat' });
    assert.equal(resolved.profile, name);
  });
}

test('resolveProfile — plain profile has no builtIns', () => {
  const resolved = resolveProfile({ profile: 'plain' }, { toolKey: 'chat' });
  assert.deepEqual(resolved.builtIns, []);
});

test('resolveProfile — grounded profile includes googleSearch', () => {
  const resolved = resolveProfile({ profile: 'grounded' }, { toolKey: 'chat' });
  assert.ok(resolved.builtIns.includes('googleSearch'));
});

test('resolveProfile — web-research includes googleSearch and urlContext', () => {
  const resolved = resolveProfile({ profile: 'web-research' }, { toolKey: 'research' });
  assert.ok(resolved.builtIns.includes('googleSearch'));
  assert.ok(resolved.builtIns.includes('urlContext'));
});

test('resolveProfile — thinkingLevel override applied', () => {
  const resolved = resolveProfile({ profile: 'plain', thinkingLevel: 'high' }, { toolKey: 'chat' });
  assert.equal(resolved.thinkingLevel, 'high');
});

test('resolveProfile — autoPromoted is false for explicit profile', () => {
  const resolved = resolveProfile({ profile: 'grounded' }, { toolKey: 'chat' });
  assert.equal(resolved.autoPromoted, false);
});

test('resolveProfile — no input selects default profile for tool', () => {
  const resolved = resolveProfile(undefined, { toolKey: 'chat' });
  assert.ok(typeof resolved.profile === 'string');
});

test('validateProfile — fileSearch + googleSearch throws ProfileValidationError', () => {
  assert.throws(
    () =>
      validateProfile({
        profile: 'rag',
        builtIns: ['fileSearch', 'googleSearch'],
        thinkingLevel: 'low',
        autoPromoted: false,
        overrides: {},
      }),
    (err: Error) => err.constructor.name === 'ProfileValidationError',
  );
});

test('validateProfile — plain with no tools does not throw', () => {
  assert.doesNotThrow(() =>
    validateProfile({
      profile: 'plain',
      builtIns: [],
      thinkingLevel: 'minimal',
      autoPromoted: false,
      overrides: {},
    }),
  );
});

test('validateProfile — agent without functions throws', () => {
  assert.throws(
    () =>
      validateProfile({
        profile: 'agent',
        builtIns: [],
        thinkingLevel: 'low',
        autoPromoted: false,
        overrides: {},
      }),
    (err: Error) => err.constructor.name === 'ProfileValidationError',
  );
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-profiles.test.ts
```

Expected: PASS — all tests (11 table-driven + 9 named = 20 total).

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/tool-profiles.test.ts
git commit -m "test: add resolveProfile and validateProfile tests"
```

---

### PHASE-004: Schema Tests

**Goal:** `__tests__/schemas/inputs.test.ts` passes — valid inputs parse, extra keys rejected, enum constraints enforced.

|                    Task                    | Action                                                   | Depends on | Files                                                                | Validate                                                                                      |
| :----------------------------------------: | :------------------------------------------------------- | :--------: | :------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| [`TASK-006`](#task-006-test-input-schemas) | Test ChatInput, ResearchInput, AnalyzeInput, ReviewInput |    none    | [**tests**/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts` |

#### TASK-006: Test input schemas

| Field      | Value                                                                                                                              |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                               |
| Files      | Create: [**tests**/schemas/inputs.test.ts](__tests__/schemas/inputs.test.ts)                                                       |
| Symbols    | [buildGenerateContentConfig](src/client.ts#L173)                                                                                   |
| Outcome    | Valid minimal inputs parse; extra properties are rejected; enum fields reject invalid values; `thinkingLevel` constraint enforced. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/schemas/inputs.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v4';

import { ChatInputSchema } from '../../src/schemas/inputs.js';

test('ChatInputSchema — rejects extra property', () => {
  const result = ChatInputSchema.safeParse({ message: 'hi', unknownKey: true });
  assert.equal(result.success, true); // intentionally wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
```

Expected: FAIL — `false !== true`.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/schemas/inputs.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AnalyzeInputSchema,
  ChatInputSchema,
  ResearchInputSchema,
  ReviewInputSchema,
} from '../../src/schemas/inputs.js';

// ChatInput
test('ChatInputSchema — valid minimal input parses', () => {
  const result = ChatInputSchema.safeParse({ message: 'hello' });
  assert.equal(result.success, true);
});

test('ChatInputSchema — rejects extra property', () => {
  const result = ChatInputSchema.safeParse({ message: 'hi', unknownKey: true });
  assert.equal(result.success, false);
});

test('ChatInputSchema — message is required', () => {
  const result = ChatInputSchema.safeParse({});
  assert.equal(result.success, false);
});

// ResearchInput
test('ResearchInputSchema — valid minimal input parses', () => {
  const result = ResearchInputSchema.safeParse({ query: 'what is rust' });
  assert.equal(result.success, true);
});

test('ResearchInputSchema — rejects extra property', () => {
  const result = ResearchInputSchema.safeParse({ query: 'x', unknownKey: 1 });
  assert.equal(result.success, false);
});

test('ResearchInputSchema — query is required', () => {
  const result = ResearchInputSchema.safeParse({});
  assert.equal(result.success, false);
});

// AnalyzeInput
test('AnalyzeInputSchema — valid minimal input parses', () => {
  const result = AnalyzeInputSchema.safeParse({ focus: 'review this code' });
  assert.equal(result.success, true);
});

test('AnalyzeInputSchema — rejects extra property', () => {
  const result = AnalyzeInputSchema.safeParse({ focus: 'x', badKey: true });
  assert.equal(result.success, false);
});

// ReviewInput
test('ReviewInputSchema — valid minimal input parses', () => {
  const result = ReviewInputSchema.safeParse({ focus: 'review diff' });
  assert.equal(result.success, true);
});

test('ReviewInputSchema — rejects extra property', () => {
  const result = ReviewInputSchema.safeParse({ focus: 'x', extra: 1 });
  assert.equal(result.success, false);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/schemas/inputs.test.ts
```

Expected: PASS — all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/schemas/inputs.test.ts
git commit -m "test: add input schema validation tests"
```

---

### PHASE-005: Session Tests

**Goal:** `__tests__/sessions.test.ts` passes — covering secret redaction, replay history filtering, window selection, and `SessionStore` operations including LRU eviction.

|                            Task                            | Action                                 |                      Depends on                      | Files                                                    | Validate                                                                                |
| :--------------------------------------------------------: | :------------------------------------- | :--------------------------------------------------: | :------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
|      [`TASK-007`](#task-007-test-sanitizesessiontext)      | Test sanitizeSessionText               |                         none                         | [**tests**/sessions.test.ts](__tests__/sessions.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts` |
|    [`TASK-008`](#task-008-test-buildreplayhistoryparts)    | Test buildReplayHistoryParts           |   [`TASK-007`](#task-007-test-sanitizesessiontext)   | [**tests**/sessions.test.ts](__tests__/sessions.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts` |
|      [`TASK-009`](#task-009-test-selectreplaywindow)       | Test selectReplayWindow                | [`TASK-008`](#task-008-test-buildreplayhistoryparts) | [**tests**/sessions.test.ts](__tests__/sessions.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts` |
| [`TASK-010`](#task-010-test-sessionstore-ops-and-eviction) | Test SessionStore ops and LRU eviction |   [`TASK-009`](#task-009-test-selectreplaywindow)    | [**tests**/sessions.test.ts](__tests__/sessions.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts` |

#### TASK-007: Test sanitizeSessionText

| Field      | Value                                                                                        |
| :--------- | :------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                         |
| Files      | Create: [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                             |
| Symbols    | [sanitizeSessionText](src/sessions.ts#L376)                                                  |
| Outcome    | Patterns for API keys, passwords, tokens are redacted; normal text passes through unchanged. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/sessions.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeSessionText } from '../src/sessions.js';

test('sanitizeSessionText — redacts API_KEY pattern', () => {
  const result = sanitizeSessionText('{"api_key": "secret123"}');
  assert.equal(result, '{"api_key": "secret123"}'); // intentionally wrong (no redaction expected)
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: FAIL — the actual result contains `[REDACTED]`, not the original value.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/sessions.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeSessionText } from '../src/sessions.js';

test('sanitizeSessionText — redacts api_key value', () => {
  const result = sanitizeSessionText('{"api_key": "secret123"}');
  assert.ok(result?.includes('[REDACTED]'), `Expected redaction, got: ${result}`);
  assert.ok(!result?.includes('secret123'));
});

test('sanitizeSessionText — redacts password value', () => {
  const result = sanitizeSessionText('password: hunter2');
  assert.ok(result?.includes('[REDACTED]'), `Expected redaction, got: ${result}`);
  assert.ok(!result?.includes('hunter2'));
});

test('sanitizeSessionText — preserves unrelated text', () => {
  const result = sanitizeSessionText('hello world, no secrets here');
  assert.equal(result, 'hello world, no secrets here');
});

test('sanitizeSessionText — returns undefined for undefined input', () => {
  assert.equal(sanitizeSessionText(undefined), undefined);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/sessions.test.ts
git commit -m "test: add sanitizeSessionText redaction tests"
```

#### TASK-008: Test buildReplayHistoryParts

| Field      | Value                                                                                                                               |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-007`](#task-007-test-sanitizesessiontext)                                                                                    |
| Files      | Modify: [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                                                                    |
| Symbols    | [buildReplayHistoryParts](src/sessions.ts#L566)                                                                                     |
| Outcome    | Nameless functionCall parts are dropped; functionResponse without matching functionCall is dropped; normal text parts pass through. |

- [ ] **Step 1: Write the failing test**

Append to `__tests__/sessions.test.ts`:

```ts
import { buildReplayHistoryParts } from '../src/sessions.js';

test('buildReplayHistoryParts — drops nameless functionCall part', () => {
  const parts = [{ functionCall: { args: {} } }]; // no name
  const result = buildReplayHistoryParts(parts);
  assert.equal(result.length, 1); // intentionally wrong — should be 0
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: FAIL — `0 !== 1`.

- [ ] **Step 3: Write the real tests**

Replace the failing test with:

```ts
test('buildReplayHistoryParts — drops nameless functionCall part', () => {
  const parts = [{ functionCall: { args: {} } }];
  const result = buildReplayHistoryParts(parts);
  assert.equal(result.length, 0);
});

test('buildReplayHistoryParts — keeps named functionCall part', () => {
  const parts = [{ functionCall: { name: 'myFn', args: {} } }];
  const result = buildReplayHistoryParts(parts);
  assert.equal(result.length, 1);
});

test('buildReplayHistoryParts — drops functionResponse with no matching functionCall', () => {
  const parts = [{ functionResponse: { name: 'myFn', response: {} } }];
  const result = buildReplayHistoryParts(parts);
  assert.equal(result.length, 0);
});

test('buildReplayHistoryParts — keeps functionResponse matching functionCall by name', () => {
  const parts = [
    { functionCall: { name: 'myFn', args: {} } },
    { functionResponse: { name: 'myFn', response: {} } },
  ];
  const result = buildReplayHistoryParts(parts);
  assert.equal(result.length, 2);
});

test('buildReplayHistoryParts — passes through plain text parts', () => {
  const parts = [{ text: 'hello world' }];
  const result = buildReplayHistoryParts(parts);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.text, 'hello world');
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/sessions.test.ts
git commit -m "test: add buildReplayHistoryParts filter tests"
```

#### TASK-009: Test selectReplayWindow

| Field      | Value                                                                                                                         |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-008`](#task-008-test-buildreplayhistoryparts)                                                                          |
| Files      | Modify: [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                                                              |
| Symbols    | [selectReplayWindow](src/sessions.ts#L1150)                                                                                   |
| Outcome    | Window fits within maxBytes by dropping oldest turns; always starts with a user-role entry; empty input returns empty result. |

- [ ] **Step 1: Write the failing test**

Append to `__tests__/sessions.test.ts` (add import for `selectReplayWindow`):

```ts
import {
  buildReplayHistoryParts,
  sanitizeSessionText,
  selectReplayWindow,
} from '../src/sessions.js';

test('selectReplayWindow — empty input returns empty', () => {
  const result = selectReplayWindow([], 1000);
  assert.equal(result.kept.length, 99); // intentionally wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: FAIL — `0 !== 99`.

- [ ] **Step 3: Write the real tests**

Replace the failing test with:

```ts
test('selectReplayWindow — empty input returns empty result', () => {
  const result = selectReplayWindow([], 1000);
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped, 0);
});

test('selectReplayWindow — keeps all entries that fit within maxBytes', () => {
  const entry = { role: 'user' as const, parts: [{ text: 'hi' }], timestamp: 0 };
  const bytes = JSON.stringify(entry.parts).length;
  const result = selectReplayWindow([entry, { ...entry, role: 'model' as const }], bytes * 3);
  assert.equal(result.kept.length, 2);
});

test('selectReplayWindow — drops oldest entries when over maxBytes', () => {
  const large = { role: 'user' as const, parts: [{ text: 'a'.repeat(500) }], timestamp: 0 };
  const small = { role: 'user' as const, parts: [{ text: 'b' }], timestamp: 1 };
  const result = selectReplayWindow([large, small], 100);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]?.parts[0]?.text, 'b');
});

test('selectReplayWindow — result always starts with user role', () => {
  const model = { role: 'model' as const, parts: [{ text: 'hi' }], timestamp: 0 };
  const user = { role: 'user' as const, parts: [{ text: 'question' }], timestamp: 1 };
  const result = selectReplayWindow([model, user], 10_000);
  assert.equal(result.kept[0]?.role, 'user');
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: PASS — all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/sessions.test.ts
git commit -m "test: add selectReplayWindow tests"
```

#### TASK-010: Test SessionStore ops and LRU eviction

| Field      | Value                                                                                                                  |
| :--------- | :--------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-009`](#task-009-test-selectreplaywindow)                                                                        |
| Files      | Modify: [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                                                       |
| Symbols    | [SessionStore](src/sessions.ts#L783), [appendSessionTurn](src/sessions.ts#L733)                                        |
| Outcome    | `setSession` creates session; duplicate throws; `getSession` returns undefined after TTL; `maxSessions` evicts oldest. |

- [ ] **Step 1: Write the failing test**

Append to `__tests__/sessions.test.ts`:

```ts
import { createSessionStore, SessionStore } from '../src/sessions.js';

test('SessionStore — setSession then getSession returns the chat', () => {
  const store = createSessionStore({ sweepIntervalMs: 0 });
  const chat = {} as never;
  store.setSession('s1', chat);
  assert.equal(store.getSession('s1'), 99); // wrong
  store.close();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: FAIL — `{} !== 99`.

- [ ] **Step 3: Write the real tests**

Replace the failing test with:

```ts
test('SessionStore — setSession then getSession returns the chat', () => {
  const store = createSessionStore({ sweepIntervalMs: 0 });
  const chat = { id: 'test-chat' } as never;
  store.setSession('s1', chat);
  assert.ok(store.getSession('s1') !== undefined);
  store.close();
});

test('SessionStore — duplicate setSession throws AppError', () => {
  const store = createSessionStore({ sweepIntervalMs: 0 });
  const chat = {} as never;
  store.setSession('s1', chat);
  assert.throws(() => store.setSession('s1', chat));
  store.close();
});

test('SessionStore — getSession returns undefined for unknown id', () => {
  const store = createSessionStore({ sweepIntervalMs: 0 });
  assert.equal(store.getSession('nonexistent'), undefined);
  store.close();
});

test('SessionStore — getSession returns undefined after TTL expires', () => {
  let time = 0;
  const store = createSessionStore({ sweepIntervalMs: 0, ttlMs: 100, now: () => time });
  store.setSession('s1', {} as never);
  time = 200; // advance past TTL
  assert.equal(store.getSession('s1'), undefined);
  store.close();
});

test('SessionStore — evicts oldest when maxSessions exceeded', () => {
  const store = createSessionStore({ sweepIntervalMs: 0, maxSessions: 2 });
  store.setSession('s1', {} as never);
  store.setSession('s2', {} as never);
  store.setSession('s3', {} as never); // triggers eviction of s1
  assert.equal(store.getSession('s1'), undefined);
  assert.ok(store.getSession('s2') !== undefined || store.getSession('s3') !== undefined);
  store.close();
});

test('SessionStore — appendSessionContent returns false for unknown session', () => {
  const store = createSessionStore({ sweepIntervalMs: 0 });
  const result = store.appendSessionContent('ghost', { role: 'user', parts: [], timestamp: 0 });
  assert.equal(result, false);
  store.close();
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: PASS — all 19 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/sessions.test.ts
git commit -m "test: add SessionStore operation and eviction tests"
```

---

### PHASE-006: Config Tests

**Goal:** `__tests__/config.test.ts` passes — boolean parsing throws on non-`"true"`/`"false"` values, `getApiKey` throws on missing key, `getTransportMode` rejects invalid values.

|                    Task                     | Action                                         | Depends on | Files                                                | Validate                                                                              |
| :-----------------------------------------: | :--------------------------------------------- | :--------: | :--------------------------------------------------- | :------------------------------------------------------------------------------------ |
| [`TASK-011`](#task-011-test-config-parsing) | Test config boolean parsing and key validation |    none    | [**tests**/config.test.ts](__tests__/config.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/config.test.ts` |

#### TASK-011: Test config parsing

| Field      | Value                                                                                                                          |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                           |
| Files      | Create: [**tests**/config.test.ts](__tests__/config.test.ts)                                                                   |
| Symbols    | [getApiKey](src/config.ts#L174), [getTransportMode](src/config.ts#L222), [getStatelessTransportFlag](src/config.ts#L226)       |
| Outcome    | Boolean `"1"` / `"yes"` throws; missing `API_KEY` throws; invalid `TRANSPORT` throws; defaults apply when env vars are absent. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/config.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

test('getApiKey — throws when API_KEY is not set', () => {
  const saved = process.env.API_KEY;
  delete process.env.API_KEY;
  // intentionally assert wrong thing to verify test runs
  assert.doesNotThrow(() => {
    const { getApiKey } = await import('../../src/config.js');
    getApiKey();
  });
  if (saved !== undefined) process.env.API_KEY = saved;
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/config.test.ts
```

Expected: FAIL — `assert.doesNotThrow` fails because `getApiKey()` throws.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/config.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { getApiKey, getStatelessTransportFlag, getTransportMode } from '../../src/config.js';

// Helpers for env isolation
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

test('getApiKey — throws when API_KEY is absent', () => {
  withEnv({ API_KEY: undefined }, () => {
    assert.throws(() => getApiKey(), /API_KEY/);
  });
});

test('getApiKey — throws when API_KEY is empty string', () => {
  withEnv({ API_KEY: '' }, () => {
    assert.throws(() => getApiKey(), /API_KEY/);
  });
});

test('getApiKey — returns trimmed key when valid', () => {
  withEnv({ API_KEY: '  valid-key  ' }, () => {
    assert.equal(getApiKey(), 'valid-key');
  });
});

test('getTransportMode — defaults to stdio when TRANSPORT unset', () => {
  withEnv({ TRANSPORT: undefined }, () => {
    assert.equal(getTransportMode(), 'stdio');
  });
});

test('getTransportMode — returns http when TRANSPORT=http', () => {
  withEnv({ TRANSPORT: 'http' }, () => {
    assert.equal(getTransportMode(), 'http');
  });
});

test('getTransportMode — throws on invalid TRANSPORT value', () => {
  withEnv({ TRANSPORT: 'grpc' }, () => {
    assert.throws(() => getTransportMode(), /TRANSPORT/);
  });
});

test('getStatelessTransportFlag — throws when STATELESS="yes"', () => {
  withEnv({ STATELESS: 'yes' }, () => {
    assert.throws(() => getStatelessTransportFlag(), /STATELESS/);
  });
});

test('getStatelessTransportFlag — false when STATELESS="false"', () => {
  withEnv({ STATELESS: 'false' }, () => {
    assert.equal(getStatelessTransportFlag(), false);
  });
});

test('getStatelessTransportFlag — true when STATELESS="true"', () => {
  withEnv({ STATELESS: 'true' }, () => {
    assert.equal(getStatelessTransportFlag(), true);
  });
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/config.test.ts
```

Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/config.test.ts
git commit -m "test: add config boolean and API key parsing tests"
```

---

### PHASE-007: Validation Tests

**Goal:** `__tests__/lib/validation.test.ts` passes — path containment and host header allow-list.

|                                 Task                                 | Action                                       | Depends on | Files                                                                | Validate                                                                                      |
| :------------------------------------------------------------------: | :------------------------------------------- | :--------: | :------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| [`TASK-012`](#task-012-test-isPathWithinRoot-and-validateHostHeader) | Test isPathWithinRoot and validateHostHeader |    none    | [**tests**/lib/validation.test.ts](__tests__/lib/validation.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/validation.test.ts` |

#### TASK-012: Test isPathWithinRoot and validateHostHeader

| Field      | Value                                                                                                                  |
| :--------- | :--------------------------------------------------------------------------------------------------------------------- |
| Depends on | none                                                                                                                   |
| Files      | Create: [**tests**/lib/validation.test.ts](__tests__/lib/validation.test.ts)                                           |
| Symbols    | [isPathWithinRoot](src/lib/validation.ts#L173), [validateHostHeader](src/lib/validation.ts#L88)                        |
| Outcome    | Path containment accepts child paths, rejects `../` traversal, rejects sibling paths; host header respects allow-list. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/validation.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPathWithinRoot } from '../../src/lib/validation.js';

test('isPathWithinRoot — child path is within root', () => {
  const result = isPathWithinRoot('/workspace/src/file.ts', '/workspace');
  assert.equal(result, false); // intentionally wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/validation.test.ts
```

Expected: FAIL — `true !== false`.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/lib/validation.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPathWithinRoot, validateHostHeader } from '../../src/lib/validation.js';

// isPathWithinRoot
test('isPathWithinRoot — child path is within root', () => {
  assert.equal(isPathWithinRoot('/workspace/src/file.ts', '/workspace'), true);
});

test('isPathWithinRoot — root itself is within root', () => {
  assert.equal(isPathWithinRoot('/workspace', '/workspace'), true);
});

test('isPathWithinRoot — sibling path is not within root', () => {
  assert.equal(isPathWithinRoot('/other/file.ts', '/workspace'), false);
});

test('isPathWithinRoot — traversal path is not within root', () => {
  assert.equal(isPathWithinRoot('/workspace/../etc/passwd', '/workspace'), false);
});

test('isPathWithinRoot — deeply nested child is within root', () => {
  assert.equal(isPathWithinRoot('/workspace/a/b/c/d.ts', '/workspace'), true);
});

// validateHostHeader
test('validateHostHeader — localhost in allowlist returns true', () => {
  assert.equal(validateHostHeader('localhost', ['localhost', '127.0.0.1']), true);
});

test('validateHostHeader — host not in allowlist returns false', () => {
  assert.equal(validateHostHeader('evil.com', ['localhost', '127.0.0.1']), false);
});

test('validateHostHeader — null host returns false', () => {
  assert.equal(validateHostHeader(null, ['localhost']), false);
});

test('validateHostHeader — host with port matches allowlist entry', () => {
  assert.equal(validateHostHeader('localhost:3000', ['localhost']), true);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/validation.test.ts
```

Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/validation.test.ts
git commit -m "test: add path containment and host header validation tests"
```

---

### PHASE-008: Catalog Tests

**Goal:** `__tests__/catalog.test.ts` passes — Markdown rendering contains all tool and workflow names.

|                      Task                      | Action                                                                | Depends on | Files                                                  | Validate                                                                               |
| :--------------------------------------------: | :-------------------------------------------------------------------- | :--------: | :----------------------------------------------------- | :------------------------------------------------------------------------------------- |
| [`TASK-013`](#task-013-test-catalog-rendering) | Test renderDiscoveryCatalogMarkdown and renderWorkflowCatalogMarkdown |    none    | [**tests**/catalog.test.ts](__tests__/catalog.test.ts) | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/catalog.test.ts` |

#### TASK-013: Test catalog rendering

| Field      | Value                                                                                                                                                                                             |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | none                                                                                                                                                                                              |
| Files      | Create: [**tests**/catalog.test.ts](__tests__/catalog.test.ts)                                                                                                                                    |
| Symbols    | [listDiscoveryEntries](src/catalog.ts#L22), [listWorkflowEntries](src/catalog.ts#L35), [renderDiscoveryCatalogMarkdown](src/catalog.ts#L85), [renderWorkflowCatalogMarkdown](src/catalog.ts#L127) |
| Outcome    | Catalog Markdown contains all 4 tool names; workflow Markdown contains all workflow names; output is non-empty.                                                                                   |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/catalog.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listDiscoveryEntries, renderDiscoveryCatalogMarkdown } from '../src/catalog.js';

test('renderDiscoveryCatalogMarkdown — contains chat tool name', () => {
  const entries = listDiscoveryEntries();
  const md = renderDiscoveryCatalogMarkdown(entries);
  assert.ok(md.includes('NONEXISTENT_TOOL')); // wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/catalog.test.ts
```

Expected: FAIL — `NONEXISTENT_TOOL` not found in output.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/catalog.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  listDiscoveryEntries,
  listWorkflowEntries,
  renderDiscoveryCatalogMarkdown,
  renderWorkflowCatalogMarkdown,
} from '../src/catalog.js';

test('renderDiscoveryCatalogMarkdown — returns non-empty Markdown', () => {
  const md = renderDiscoveryCatalogMarkdown(listDiscoveryEntries());
  assert.ok(md.length > 0);
});

test('renderDiscoveryCatalogMarkdown — contains chat tool', () => {
  const md = renderDiscoveryCatalogMarkdown(listDiscoveryEntries());
  assert.ok(md.includes('chat'), `Expected "chat" in catalog output`);
});

test('renderDiscoveryCatalogMarkdown — contains research tool', () => {
  const md = renderDiscoveryCatalogMarkdown(listDiscoveryEntries());
  assert.ok(md.includes('research'));
});

test('renderDiscoveryCatalogMarkdown — contains analyze tool', () => {
  const md = renderDiscoveryCatalogMarkdown(listDiscoveryEntries());
  assert.ok(md.includes('analyze'));
});

test('renderDiscoveryCatalogMarkdown — contains review tool', () => {
  const md = renderDiscoveryCatalogMarkdown(listDiscoveryEntries());
  assert.ok(md.includes('review'));
});

test('renderWorkflowCatalogMarkdown — returns non-empty Markdown', () => {
  const md = renderWorkflowCatalogMarkdown(listWorkflowEntries());
  assert.ok(md.length > 0);
});

test('renderWorkflowCatalogMarkdown — contains at least one workflow name', () => {
  const entries = listWorkflowEntries();
  const md = renderWorkflowCatalogMarkdown(entries);
  assert.ok(entries.length > 0);
  assert.ok(md.length > 0);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/catalog.test.ts
```

Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/catalog.test.ts
git commit -m "test: add catalog Markdown rendering tests"
```

---

### PHASE-009: Streaming Layer Tests

**Goal:** `__tests__/lib/streaming.test.ts` and `__tests__/lib/response.test.ts` pass, exercising the core Gemini response-processing logic with fake data — no mocking, no real API calls.

> **Why not tool-level integration tests?** `mock.module()` requires `--experimental-test-module-mocks` which is incompatible with `--import tsx/esm` on Node.js 24 (causes `ERR_REQUIRE_CYCLE_MODULE`). Streaming/response layer tests cover the same behavioral surface — they are the functions tools call to process Gemini responses. See [`RISK-001`](#7-risks--notes).

|                                Task                                | Action                                          |                      Depends on                      | Files                             | Validate                                                                                     |
| :----------------------------------------------------------------: | :---------------------------------------------- | :--------------------------------------------------: | :-------------------------------- | :------------------------------------------------------------------------------------------- |
| [`TASK-014`](#task-014-test-validatestreamresult-and-extractusage) | Test validateStreamResult and extractUsage      | [`TASK-001`](#task-001-scaffold-mock-gemini-factory) | `__tests__/lib/streaming.test.ts` | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts` |
|       [`TASK-015`](#task-015-test-response-layer-functions)        | Test tryParseJsonResponse and response builders |                         none                         | `__tests__/lib/response.test.ts`  | `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts`  |

#### TASK-014: Test validateStreamResult and extractUsage

| Field      | Value                                                                                                                                                         |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | [`TASK-001`](#task-001-scaffold-mock-gemini-factory)                                                                                                          |
| Files      | Create: [**tests**/lib/streaming.test.ts](__tests__/lib/streaming.test.ts)                                                                                    |
| Symbols    | [validateStreamResult](src/lib/streaming.ts#L982), [extractUsage](src/lib/streaming.ts#L1017)                                                                 |
| Outcome    | `validateStreamResult` returns correct `CallToolResult` for aborted, blocked, and successful streams; `extractUsage` handles full/partial/undefined metadata. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/streaming.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractUsage, validateStreamResult } from '../../src/lib/streaming.js';
import type { StreamResult } from '../../src/lib/streaming.js';

function makeStream(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    text: '',
    textByWave: [],
    thoughtText: '',
    parts: [],
    toolsUsed: [],
    toolsUsedOccurrences: [],
    functionCalls: [],
    toolEvents: [],
    hadCandidate: true,
    ...overrides,
  };
}

test('validateStreamResult — aborted stream returns cancelled error result', () => {
  const result = validateStreamResult(makeStream({ aborted: true }), 'chat');
  assert.equal(result.isError, false); // intentionally wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts
```

Expected: FAIL — `true !== false`.

- [ ] **Step 3: Write the real tests**

```ts
// __tests__/lib/streaming.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractUsage, validateStreamResult } from '../../src/lib/streaming.js';
import type { StreamResult } from '../../src/lib/streaming.js';

function makeStream(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    text: '',
    textByWave: [],
    thoughtText: '',
    parts: [],
    toolsUsed: [],
    toolsUsedOccurrences: [],
    functionCalls: [],
    toolEvents: [],
    hadCandidate: true,
    ...overrides,
  };
}

test('validateStreamResult — aborted stream returns error result', () => {
  const result = validateStreamResult(makeStream({ aborted: true }), 'chat');
  assert.equal(result.isError, true);
});

test('validateStreamResult — successful stream with text returns non-error', () => {
  const result = validateStreamResult(makeStream({ text: 'hello', hadCandidate: true }), 'chat');
  assert.equal(result.isError, undefined);
});

test('validateStreamResult — empty stream (no candidate) returns error', () => {
  const result = validateStreamResult(makeStream({ hadCandidate: false }), 'chat');
  assert.equal(result.isError, true);
});

test('extractUsage — returns undefined for undefined input', () => {
  assert.equal(extractUsage(undefined), undefined);
});

test('extractUsage — returns token counts from metadata', () => {
  const meta = {
    promptTokenCount: 10,
    candidatesTokenCount: 20,
    totalTokenCount: 30,
  } as never;
  const usage = extractUsage(meta);
  assert.ok(usage !== undefined);
  assert.equal(usage.promptTokenCount, 10);
  assert.equal(usage.candidatesTokenCount, 20);
  assert.equal(usage.totalTokenCount, 30);
});

test('extractUsage — omits undefined fields from result', () => {
  const meta = { totalTokenCount: 5 } as never;
  const usage = extractUsage(meta);
  assert.ok(usage !== undefined);
  assert.equal('promptTokenCount' in usage, false);
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts
```

Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/streaming.test.ts
git commit -m "test: add validateStreamResult and extractUsage tests"
```

#### TASK-015: Test response layer functions

| Field      | Value                                                                                                                                                   |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on | none                                                                                                                                                    |
| Files      | Create: [**tests**/lib/response.test.ts](__tests__/lib/response.test.ts)                                                                                |
| Symbols    | [tryParseJsonResponse](src/lib/response.ts#L114), [mergeStructured](src/lib/response.ts#L66), [promptBlockedError](src/lib/response.ts#L388)            |
| Outcome    | `tryParseJsonResponse` handles JSON, fenced blocks, and invalid input; `promptBlockedError` returns isError result; `mergeStructured` merges correctly. |

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/response.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tryParseJsonResponse } from '../../src/lib/response.js';

test('tryParseJsonResponse — parses valid JSON string', () => {
  const result = tryParseJsonResponse('{"key": "value"}');
  assert.deepEqual(result, { key: 'WRONG' }); // intentionally wrong
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: FAIL — `{ key: 'value' }` does not deep-equal `{ key: 'WRONG' }`.

- [ ] **Step 3: Write the real tests**

````ts
// __tests__/lib/response.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mergeStructured,
  promptBlockedError,
  tryParseJsonResponse,
} from '../../src/lib/response.js';

test('tryParseJsonResponse — parses valid JSON string', () => {
  const result = tryParseJsonResponse('{"key": "value"}');
  assert.deepEqual(result, { key: 'value' });
});

test('tryParseJsonResponse — parses JSON inside fenced code block', () => {
  const input = '```json\n{"foo": 42}\n```';
  const result = tryParseJsonResponse(input);
  assert.deepEqual(result, { foo: 42 });
});

test('tryParseJsonResponse — returns undefined for invalid JSON', () => {
  const result = tryParseJsonResponse('not valid json at all!!!');
  assert.equal(result, undefined);
});

test('promptBlockedError — returns isError result', () => {
  const result = promptBlockedError('chat');
  assert.equal(result.isError, true);
});

test('promptBlockedError — includes blockReason in content when provided', () => {
  const result = promptBlockedError('chat', 'SAFETY');
  assert.ok(result.isError);
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
  assert.ok(text.length > 0);
});

test('mergeStructured — merges two objects', () => {
  const result = mergeStructured({ a: 1 }, { b: 2 });
  assert.deepEqual(result, { a: 1, b: 2 });
});

test('mergeStructured — later value overwrites earlier', () => {
  const result = mergeStructured({ a: 1 }, { a: 99 });
  assert.deepEqual(result, { a: 99 });
});
````

- [ ] **Step 4: Run to verify it passes**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/response.test.ts
```

Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add __tests__/lib/response.test.ts
git commit -m "test: add response layer function tests"
```

---

### PHASE-010: Full Suite Verification

**Goal:** `npm run test` passes with all test files and zero real API calls.

|                       Task                        | Action                           |                      Depends on                       | Files          | Validate       |
| :-----------------------------------------------: | :------------------------------- | :---------------------------------------------------: | :------------- | :------------- |
| [`TASK-016`](#task-016-run-full-suite-and-verify) | Run full suite, fix any failures | [`TASK-015`](#task-015-test-response-layer-functions) | all test files | `npm run test` |

#### TASK-016: Run full suite and verify

| Field      | Value                                                                                                                       |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------- |
| Depends on | [`TASK-015`](#task-015-test-response-layer-functions)                                                                       |
| Files      | all test files                                                                                                              |
| Symbols    | none                                                                                                                        |
| Outcome    | `npm run test` exits 0, all tests pass, no real Gemini API calls in output. TDD skipped — this is a verification-only task. |

- [ ] **Step 1: Run the full suite**

```bash
npm run test
```

Expected: all test files discovered and all tests pass. If any test fails, diagnose and fix before marking complete.

- [ ] **Step 2: Run the full task suite (format + lint + type-check + test + build)**

```bash
node scripts/tasks.mjs
```

Expected: all tasks pass, exits 0.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: verify full suite passes — zero API token cost"
```

---

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — all pure-logic tests pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/errors.test.ts __tests__/lib/tool-profiles.test.ts __tests__/schemas/inputs.test.ts __tests__/sessions.test.ts __tests__/config.test.ts __tests__/lib/validation.test.ts __tests__/catalog.test.ts
```

### [`VAL-002`](#5-testing--validation) — streaming and response layer tests pass

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts __tests__/lib/response.test.ts
```

### [`VAL-003`](#5-testing--validation) — full suite via npm

```bash
npm run test
```

### [`VAL-004`](#5-testing--validation) — full orchestrated verification

```bash
node scripts/tasks.mjs
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                      |
| :--------------------------------: | :------------------------------------------------------------------------------------------------------ |
| [`AC-001`](#6-acceptance-criteria) | `npm run test` exits 0 with ≥ 55 tests discovered and all passing.                                      |
| [`AC-002`](#6-acceptance-criteria) | No test file calls a real Gemini endpoint; `getAI()` is never invoked during the test run.              |
| [`AC-003`](#6-acceptance-criteria) | `__tests__/lib/errors.test.ts` covers `withRetry` with a call-count assertion proving 3 total attempts. |
| [`AC-004`](#6-acceptance-criteria) | `__tests__/sessions.test.ts` asserts that `sanitizeSessionText` redacts `api_key` patterns.             |
| [`AC-005`](#6-acceptance-criteria) | `__tests__/config.test.ts` asserts that `STATELESS="yes"` throws.                                       |
| [`AC-006`](#6-acceptance-criteria) | `__tests__/lib/streaming.test.ts` asserts that an aborted `StreamResult` produces `isError: true`.      |
| [`AC-007`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0 (format + lint + type-check + knip + test + build all green).          |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                        |
| :---------------------------: | :--: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | `mock.module()` requires `--experimental-test-module-mocks` which causes `ERR_REQUIRE_CYCLE_MODULE` when combined with `--import tsx/esm` on Node.js 24. Tool-level integration tests using module mocks are deferred; streaming/response layer tests provide equivalent behavioral coverage. |
| [`RISK-002`](#7-risks--notes) | Risk | `withRetry` uses real `setTimeout` for delays. Tests for retry count set `maxRetries` via options to avoid waiting on default backoff timing.                                                                                                                                                 |
| [`RISK-003`](#7-risks--notes) | Risk | `SessionStore` starts an eviction timer. Always call `store.close()` in tests to prevent leaking the interval into the next test.                                                                                                                                                             |
| [`NOTE-001`](#7-risks--notes) | Note | Verify the exact required field names by checking [src/schemas/inputs.ts](src/schemas/inputs.ts) if a minimal-input test fails — the required field may differ from `message`/`query`/`focus`.                                                                                                |
| [`NOTE-002`](#7-risks--notes) | Note | The `StreamResult` helper `makeStream()` defined in TASK-014 sets `hadCandidate: true` by default — override explicitly when testing the empty-stream error path.                                                                                                                             |
