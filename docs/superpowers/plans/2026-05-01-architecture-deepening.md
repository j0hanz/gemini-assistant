---
title: 'Architecture Deepening: Five Module Deepening Opportunities'
type: refactor
component: core-lib
status: draft
date: 2026-05-01
---

> **REQUIRED SUB-SKILL:** Execute with `superpowers:executing-plans`

## Goal

Deepen five shallow or tightly-coupled modules. Each change independently improves testability, locality, or leverage. Execute phases in order — PHASE-3 and PHASE-4 share `tool-executor.ts` and must not be parallelised.

| #   | Module                              | Problem                                                                                                        | What changes                                                                                                        |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `sessions.ts` cloning               | 4-strategy dispatch table with one caller                                                                      | Inline explicit field copies                                                                                        |
| 2   | `orchestration.ts` diagnostics      | Logging side-effects tangled with pure logic                                                                   | Extract pure `buildOrchestrationDiagnostics`                                                                        |
| 3   | `tool-executor.ts` duplicate method | `executeStreamWork` mirrors `runStream` body                                                                   | Delete, inline into `runGeminiStream`                                                                               |
| 4   | `tool-executor.ts` thin wrapper     | `executeGeminiPipeline` is 6 lines of plumbing                                                                 | Delete + update 4 callers to use `runGeminiStream` directly; extract `finalizeStreamExecution` as testable function |
| 5   | `tool-executor.ts` warning pipeline | `buildSharedStructuredMetadata` creates an object then `getStructuredWarnings` immediately re-extracts from it | Remove circular pattern; flatten to direct spread                                                                   |

## Architecture

TypeScript MCP server. Node `node:test` framework with `tsx/esm` loader. No mocking — tests use real implementations.

**Key paths:**

- Tool handler calls `executor.runGeminiStream` (or via `executeGeminiPipeline` today) → `resolveOrchestrationFromRequest` → `executeToolStream` → `finalizeStreamExecution`
- Session events: `SessionStore.appendSessionEvent` stores a clone; `listSessionEventEntries` returns another clone

**Run all checks:** `node scripts/tasks.mjs`
**Run one test file:** `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/<path>.test.ts`

## File Structure

| File                                                                       | Action | Responsibility after change                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/sessions.ts](src/sessions.ts)                                         | Modify | Explicit field-by-field clone; remove dispatch infrastructure                                                                                                                  |
| [src/lib/orchestration.ts](src/lib/orchestration.ts)                       | Modify | Pure `buildOrchestrationDiagnostics` extracted; `resolveOrchestrationFromRequest` loops over it                                                                                |
| [src/lib/tool-executor.ts](src/lib/tool-executor.ts)                       | Modify | Delete `executeStreamWork`, `executeGeminiPipeline`, `GeminiPipelineRequest`; extract `finalizeStreamExecution` as module-level function; remove circular warning intermediary |
| [src/tools/analyze.ts](src/tools/analyze.ts)                               | Modify | Call `executor.runGeminiStream` directly                                                                                                                                       |
| [src/tools/research.ts](src/tools/research.ts)                             | Modify | Call `executor.runGeminiStream` directly                                                                                                                                       |
| [src/tools/review.ts](src/tools/review.ts)                                 | Modify | Call `executor.runGeminiStream` directly                                                                                                                                       |
| [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                   | Modify | Add clone isolation tests                                                                                                                                                      |
| [**tests**/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts) | Create | Tests for pure `buildOrchestrationDiagnostics`                                                                                                                                 |
| [**tests**/lib/tool-executor.test.ts](__tests__/lib/tool-executor.test.ts) | Create | Tests for extracted `finalizeStreamExecution`                                                                                                                                  |

## Relevant Symbols

- [buildOrchestrationConfig](src/lib/orchestration.ts#L193)
- [resolveOrchestrationFromRequest](src/lib/orchestration.ts#L261)
- [mergeStructured](src/lib/response.ts#L60)
- [buildSharedStructuredMetadata](src/lib/response.ts#L370)
- [getStructuredWarnings](src/lib/tool-executor.ts#L96)
- [mergeDiagnostics](src/lib/tool-executor.ts#L107)
- [appendWarningsToContent](src/lib/tool-executor.ts#L120)
- [GeminiStreamRequest](src/lib/tool-executor.ts#L82)
- [GeminiPipelineRequest](src/lib/tool-executor.ts#L137)
- [ToolExecutor](src/lib/tool-executor.ts#L151)
- [executeWithTracing](src/lib/tool-executor.ts#L219)
- [validateUrls](src/lib/validation.ts#L716)
- [validateGeminiRequest](src/lib/validation.ts#L799)
- [RESPONSE_FIELD_RULES](src/sessions.ts#L143)
- [applyResponseClone](src/sessions.ts#L161)
- [cloneSessionEventEntry](src/sessions.ts#L176)
- [ResponseCloneStrategy](src/sessions.ts#L136)
- [StreamResult](src/lib/streaming.ts#L59)

---

## PHASE-1: Session cloning

### TASK-01 — Inline `cloneSessionEventEntry` field dispatch

|                |                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Depends on** | —                                                                                                                                                                                                                              |
| **Files**      | [src/sessions.ts](src/sessions.ts), [**tests**/sessions.test.ts](__tests__/sessions.test.ts)                                                                                                                                   |
| **Symbols**    | [RESPONSE_FIELD_RULES](src/sessions.ts#L143), [applyResponseClone](src/sessions.ts#L161), [cloneSessionEventEntry](src/sessions.ts#L176), [ResponseCloneStrategy](src/sessions.ts#L136)                                        |
| **Outcome**    | `RESPONSE_FIELD_RULES`, `ResponseFieldRule`, `ResponseCloneStrategy`, `applyResponseClone`, and `cloneValue` are deleted; `cloneSessionEventEntry` uses explicit field copies with `!slim` guards; existing session tests pass |

**Step 1 — Write failing tests**

Add to `__tests__/sessions.test.ts`:

```typescript
import type { SessionEventEntry } from '../src/sessions.js';

// helper — minimal valid event
function makeEvent(overrides: Partial<SessionEventEntry['response']> = {}): SessionEventEntry {
  return {
    request: { message: 'hello', urls: ['https://example.com'] },
    response: {
      text: 'world',
      finishReason: 'STOP',
      data: { nested: { value: 42 } },
      functionCalls: [{ name: 'fn', args: { x: 1 } }],
      schemaWarnings: ['warn1'],
      usage: { inputTokenCount: 10, outputTokenCount: 5, totalTokenCount: 15 },
      ...overrides,
    },
    timestamp: Date.now(),
  };
}

test('appendSessionEvent + listSessionEventEntries — mutations to original do not affect stored copy', () => {
  const store = createSessionStore();
  store.initializeSession('s1', 'i1');

  const original = makeEvent();
  store.appendSessionEvent('s1', original);

  // mutate the original after append
  original.response.text = 'MUTATED';
  (original.response.data as Record<string, unknown>).nested = { value: 999 };
  original.request.urls!.push('https://injected.com');

  const [stored] = store.listSessionEventEntries('s1')!;
  assert.strictEqual(stored!.response.text, 'world', 'stored text must not see mutation');
  assert.deepStrictEqual(
    (stored!.response.data as Record<string, unknown>).nested,
    { value: 42 },
    'stored data must not see mutation',
  );
  assert.strictEqual(stored!.request.urls!.length, 1, 'stored urls must not see push');
});

test('listSessionEventEntries — mutations to returned copy do not affect stored data', () => {
  const store = createSessionStore();
  store.initializeSession('s2', 'i2');
  store.appendSessionEvent('s2', makeEvent());

  const [copy1] = store.listSessionEventEntries('s2')!;
  copy1!.response.text = 'MUTATED';

  const [copy2] = store.listSessionEventEntries('s2')!;
  assert.strictEqual(
    copy2!.response.text,
    'world',
    'second read must not see mutation to first copy',
  );
});

test('appendSessionEvent + listSessionEventEntries — functionCalls are shallow-copied', () => {
  const store = createSessionStore();
  store.initializeSession('s3', 'i3');
  const event = makeEvent();
  store.appendSessionEvent('s3', event);

  const [stored] = store.listSessionEventEntries('s3')!;
  assert.notStrictEqual(
    stored!.response.functionCalls,
    event.response.functionCalls,
    'array must be a copy',
  );
  assert.deepStrictEqual(stored!.response.functionCalls, event.response.functionCalls);
});
```

**Step 2 — Run to verify failure**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: these three tests pass immediately (they test public observable behaviour, not the internals). If they already pass, proceed — the tests serve as a regression guard for Step 3.

**Step 3 — Replace dispatch table with inline field copies**

In [src/sessions.ts](src/sessions.ts), delete the following (lines ~131–174):

- `function cloneValue<T>(value: T): T`
- `type ResponseCloneStrategy`
- `interface ResponseFieldRule`
- `const RESPONSE_FIELD_RULES`
- `function applyResponseClone`

Replace `cloneSessionEventEntry` with:

```typescript
function cloneSessionEventEntry(item: SessionEventEntry): SessionEventEntry {
  const slim = getSlimSessionEvents();
  return {
    ...item,
    request: {
      ...item.request,
      message: sanitizeSessionText(item.request.message) ?? item.request.message,
      ...(item.request.sentMessage !== undefined
        ? { sentMessage: sanitizeSessionText(item.request.sentMessage) ?? item.request.sentMessage }
        : {}),
      ...(item.request.toolProfile !== undefined
        ? { toolProfile: sanitizeSessionText(item.request.toolProfile) ?? item.request.toolProfile }
        : {}),
      ...(item.request.urls ? { urls: [...item.request.urls] } : {}),
    },
    response: {
      text: item.response.text,
      ...(item.response.finishReason !== undefined
        ? { finishReason: item.response.finishReason }
        : {}),
      ...(item.response.promptBlockReason !== undefined
        ? { promptBlockReason: item.response.promptBlockReason }
        : {}),
      ...(item.response.finishMessage !== undefined
        ? { finishMessage: item.response.finishMessage }
        : {}),
      ...(item.response.data !== undefined ? { data: structuredClone(item.response.data) } : {}),
      ...(item.response.functionCalls !== undefined
        ? { functionCalls: item.response.functionCalls.map((fc) => ({ ...fc })) }
        : {}),
      ...(item.response.schemaWarnings !== undefined
        ? { schemaWarnings: [...item.response.schemaWarnings] }
        : {}),
      ...(item.response.usage !== undefined ? { usage: { ...item.response.usage } } : {}),
      ...(item.response.anomalies !== undefined
        ? { anomalies: { ...item.response.anomalies } }
        : {}),
      ...(!slim && item.response.citationMetadata !== undefined
        ? { citationMetadata: structuredClone(item.response.citationMetadata) }
        : {}),
      ...(!slim && item.response.safetyRatings !== undefined
        ? { safetyRatings: structuredClone(item.response.safetyRatings) }
        : {}),
      ...(!slim && item.response.thoughts !== undefined
        ? { thoughts: item.response.thoughts }
        : {}),
      ...(!slim && item.response.toolEvents !== undefined
        ? { toolEvents: item.response.toolEvents.map((te) => ({ ...te })) }
        : {}),
      ...(!slim && item.response.groundingMetadata !== undefined
        ? { groundingMetadata: structuredClone(item.response.groundingMetadata) }
        : {}),
      ...(!slim && item.response.urlContextMetadata !== undefined
        ? { urlContextMetadata: structuredClone(item.response.urlContextMetadata) }
        : {}),
      ...(!slim && item.response.promptFeedback !== undefined
        ? { promptFeedback: structuredClone(item.response.promptFeedback) }
        : {}),
    },
  };
}
```

**Step 4 — Run tests**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

Expected: all tests pass, including the three new ones.

**Step 5 — Commit**

```bash
git add src/sessions.ts __tests__/sessions.test.ts
git commit -m "refactor(sessions): inline clone field rules; delete dispatch table"
```

---

## PHASE-2: Orchestration diagnostics

### TASK-02 — Extract pure `buildOrchestrationDiagnostics`

|                |                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Depends on** | —                                                                                                                                                                                          |
| **Files**      | [src/lib/orchestration.ts](src/lib/orchestration.ts), [**tests**/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts)                                                           |
| **Symbols**    | [resolveOrchestrationFromRequest](src/lib/orchestration.ts#L261), [buildOrchestrationConfig](src/lib/orchestration.ts#L193)                                                                |
| **Outcome**    | `buildOrchestrationDiagnostics` is exported and testable without a `ServerContext`; `resolveOrchestrationFromRequest` delegates to it for the diagnostic messages; all existing tests pass |

**Step 1 — Write failing test**

Create `__tests__/lib/orchestration.test.ts`:

```typescript
import assert from 'node:assert';
import { test } from 'node:test';

import { FunctionCallingConfigMode } from '@google/genai';

import {
  buildOrchestrationDiagnostics,
  buildOrchestrationRequestFromInputs,
} from '../../src/lib/orchestration.js';

test('buildOrchestrationDiagnostics — emits info for resolved profile', () => {
  const request = buildOrchestrationRequestFromInputs({ googleSearch: true });
  const diags = buildOrchestrationDiagnostics(request, 'chat');
  assert.ok(diags.length >= 1, 'at least one diagnostic');
  const info = diags.find((d) => d.level === 'info');
  assert.ok(info, 'must have an info diagnostic');
  assert.ok(info.message.includes('chat'), 'message must include toolKey');
});

test('buildOrchestrationDiagnostics — warns when URLs provided but urlContext not in profile', () => {
  const request = buildOrchestrationRequestFromInputs({
    urls: ['https://example.com'],
    // no urlContext requested → capability absent
  });
  const diags = buildOrchestrationDiagnostics(request, 'analyze');
  const warning = diags.find((d) => d.level === 'warning' && d.message.includes('URL'));
  assert.ok(warning, 'must warn about URL without urlContext capability');
});

test('buildOrchestrationDiagnostics — no URL warning when urlContext is active', () => {
  const request = buildOrchestrationRequestFromInputs({
    urls: ['https://example.com'],
    // urlContext enabled by providing urls when builtInToolSpecs includes urlContext
  });
  // override: explicitly add urlContext spec so the capability is active
  const requestWithUrlContext = {
    ...request,
    builtInToolSpecs: [{ kind: 'urlContext' as const }, ...(request.builtInToolSpecs ?? [])],
  };
  const diags = buildOrchestrationDiagnostics(requestWithUrlContext, 'analyze');
  const warning = diags.find((d) => d.level === 'warning' && d.message.includes('URL'));
  assert.strictEqual(warning, undefined, 'must not warn when urlContext is active');
});

test('buildOrchestrationDiagnostics — warns on empty fileSearch stores', () => {
  const request: Parameters<typeof buildOrchestrationDiagnostics>[0] = {
    builtInToolSpecs: [{ kind: 'fileSearch', fileSearchStoreNames: [] }],
  };
  const diags = buildOrchestrationDiagnostics(request, 'chat');
  const warning = diags.find((d) => d.level === 'warning' && d.message.includes('File Search'));
  assert.ok(warning, 'must warn when fileSearch has no store names');
});
```

**Step 2 — Run to verify failure**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/orchestration.test.ts
```

Expected: `SyntaxError` or `TypeError` — `buildOrchestrationDiagnostics` does not exist yet.

**Step 3 — Implement**

In [src/lib/orchestration.ts](src/lib/orchestration.ts), insert after `buildOrchestrationConfig` (before line 255) and export:

```typescript
export interface OrchestrationDiagnostic {
  level: 'info' | 'warning';
  message: string;
}

export function buildOrchestrationDiagnostics(
  request: OrchestrationRequest & { urls?: readonly string[] | undefined },
  toolKey: string,
): OrchestrationDiagnostic[] {
  const config = buildOrchestrationConfig(request);
  const urlCount = request.urls?.length ?? 0;
  const diagnostics: OrchestrationDiagnostic[] = [
    {
      level: 'info',
      message: `orchestration resolved: ${toolKey} -> ${config.toolProfile}`,
    },
  ];

  if (urlCount > 0 && !config.activeCapabilities.has('urlContext')) {
    diagnostics.push({
      level: 'warning',
      message: `orchestration: ${toolKey} received ${String(urlCount)} URL(s) but resolved profile '${config.toolProfile}' does not expose URL Context`,
    });
  }

  const fileSearchSpec = (request.builtInToolSpecs ?? []).find(
    (spec) => spec.kind === 'fileSearch',
  );
  if (
    config.activeCapabilities.has('fileSearch') &&
    fileSearchSpec?.kind === 'fileSearch' &&
    fileSearchSpec.fileSearchStoreNames.length === 0
  ) {
    diagnostics.push({
      level: 'warning',
      message: `orchestration: ${toolKey} resolved File Search without fileSearchStoreNames`,
    });
  }

  return diagnostics;
}
```

Now rewrite `resolveOrchestrationFromRequest` (lines 261–311) to delegate:

```typescript
export async function resolveOrchestrationFromRequest(
  request: OrchestrationRequest & { urls?: readonly string[] | undefined },
  ctx: ServerContext,
  toolKey: string,
): Promise<ResolveOrchestrationResult> {
  const urlError = validateUrls(request.urls);
  if (urlError) {
    return { error: urlError };
  }

  const config = buildOrchestrationConfig(request);
  const diagnostics = buildOrchestrationDiagnostics(request, toolKey);

  for (const { level, message } of diagnostics) {
    await mcpLog(ctx, level, message);
  }

  const urlCount = request.urls?.length ?? 0;
  const serverSideToolInvocations =
    config.toolConfig?.includeServerSideToolInvocations === true ? true : undefined;
  logger.child(toolKey).info('orchestration resolved', {
    toolKey,
    toolProfile: config.toolProfile,
    toolProfileDetails: config.toolProfileDetails,
    activeCapabilities: [...config.activeCapabilities],
    serverSideToolInvocations,
    urlCount,
  });

  return { config };
}
```

Note: `buildOrchestrationDiagnostics` calls `buildOrchestrationConfig` internally. The `resolveOrchestrationFromRequest` also needs the config for the structured logger payload. To avoid calling `buildOrchestrationConfig` twice, get the config from the function's scope rather than the diagnostics. Adjust `buildOrchestrationDiagnostics` to accept a pre-built config:

```typescript
export function buildOrchestrationDiagnostics(
  request: OrchestrationRequest & { urls?: readonly string[] | undefined },
  toolKey: string,
  config?: ReturnType<typeof buildOrchestrationConfig>,
): OrchestrationDiagnostic[] {
  const resolvedConfig = config ?? buildOrchestrationConfig(request);
  // ... rest of implementation using resolvedConfig
}
```

And in `resolveOrchestrationFromRequest`:

```typescript
const config = buildOrchestrationConfig(request);
const diagnostics = buildOrchestrationDiagnostics(request, toolKey, config);
```

Update the test for the `config`-accepting overload: the existing tests pass `request` only, which triggers internal config building. That remains valid.

**Step 4 — Run tests**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/orchestration.test.ts
```

Expected: all 4 tests pass.

Also run full suite to confirm no regressions:

```bash
node scripts/tasks.mjs --quick
```

Expected: zero errors.

**Step 5 — Commit**

```bash
git add src/lib/orchestration.ts __tests__/lib/orchestration.test.ts
git commit -m "refactor(orchestration): extract pure buildOrchestrationDiagnostics"
```

---

## PHASE-3: ToolExecutor — delete `executeStreamWork` duplicate

### TASK-03 — Inline `executeStreamWork` into `runGeminiStream`

|                |                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **Depends on** | —                                                                                                            |
| **Files**      | [src/lib/tool-executor.ts](src/lib/tool-executor.ts)                                                         |
| **Symbols**    | [ToolExecutor](src/lib/tool-executor.ts#L151)                                                                |
| **Outcome**    | `executeStreamWork` private method deleted; its body inlined directly into `runGeminiStream`; all tests pass |

**Step 1 — No new test needed**

`executeStreamWork` is tested indirectly through `runGeminiStream` and `runStream`. The behaviour is preserved by inlining. Verify existing tests cover this path:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/chat.test.ts
```

Expected: all pass (establishes baseline).

**Step 2 — Apply change**

In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), find `executeStreamWork` (lines 387–402) and delete the entire private method.

In `runGeminiStream` (currently ends with a call to `this.executeStreamWork`), replace:

```typescript
return this.executeStreamWork(
  ctx,
  request.toolName,
  request.label,
  () =>
    getAI().models.generateContentStream({
      model: getGeminiModel(),
      contents,
      config: buildGenerateContentConfig(
        {
          systemInstruction,
          ...request.config,
          functionCallingMode: resolved.config.functionCallingMode,
          tools: resolved.config.tools,
          toolConfig: resolved.config.toolConfig,
        },
        getWorkSignal(ctx),
      ),
    }),
  request.responseBuilder ?? (() => ({})),
);
```

With the body of `executeStreamWork` inlined:

```typescript
const { streamResult, result } = await executeToolStream(
  ctx,
  request.toolName,
  request.label,
  () =>
    getAI().models.generateContentStream({
      model: getGeminiModel(),
      contents,
      config: buildGenerateContentConfig(
        {
          systemInstruction,
          ...request.config,
          functionCallingMode: resolved.config.functionCallingMode,
          tools: resolved.config.tools,
          toolConfig: resolved.config.toolConfig,
        },
        getWorkSignal(ctx),
      ),
    }),
  getWorkSignal(ctx),
);
return this.finalizeStreamExecution(result, streamResult, request.responseBuilder ?? (() => ({})));
```

**Step 3 — Run tests**

```bash
node scripts/tasks.mjs --quick
```

Expected: zero errors, zero type errors.

**Step 4 — Commit**

```bash
git add src/lib/tool-executor.ts
git commit -m "refactor(executor): inline executeStreamWork into runGeminiStream"
```

---

## PHASE-4: Delete `executeGeminiPipeline` + extract testable `finalizeStreamExecution`

### TASK-04 — Extract `finalizeStreamExecution` as module-level function + add tests

|                |                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on** | TASK-03                                                                                                                                       |
| **Files**      | [src/lib/tool-executor.ts](src/lib/tool-executor.ts), [**tests**/lib/tool-executor.test.ts](__tests__/lib/tool-executor.test.ts)              |
| **Symbols**    | [ToolExecutor](src/lib/tool-executor.ts#L151), [executeWithTracing](src/lib/tool-executor.ts#L219)                                            |
| **Outcome**    | `finalizeStreamExecution` is a named export at module level, testable without constructing a `ToolExecutor`; 3+ tests cover its merging logic |

**Step 1 — Write failing tests**

Create `__tests__/lib/tool-executor.test.ts`:

```typescript
import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import type { StreamResult } from '../../src/lib/streaming.js';
import { finalizeStreamExecution } from '../../src/lib/tool-executor.js';

function makeStreamResult(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    text: 'hello',
    textByWave: ['hello'],
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

function makeToolResult(overrides: Partial<CallToolResult> = {}): CallToolResult {
  return {
    content: [{ type: 'text', text: 'response' }],
    ...overrides,
  };
}

test('finalizeStreamExecution — returns result unchanged when isError', () => {
  const result = makeToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  const streamResult = makeStreamResult();
  const { result: out } = finalizeStreamExecution(result, streamResult, () => ({}));
  assert.strictEqual(out, result, 'must return same object reference on error');
});

test('finalizeStreamExecution — appends stream warnings to content', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult({ warnings: ['w1', 'w2'] });
  const { result: out } = finalizeStreamExecution(result, streamResult, () => ({}));
  const texts = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  assert.ok(texts.includes('w1'), 'content must include w1');
  assert.ok(texts.includes('w2'), 'content must include w2');
});

test('finalizeStreamExecution — merges warnings from responseBuilder structuredContent', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult();
  const { result: out } = finalizeStreamExecution(result, streamResult, () => ({
    structuredContent: { warnings: ['builder-warn'] },
  }));
  const warnings = (out.structuredContent as Record<string, unknown> | undefined)?.warnings;
  assert.ok(Array.isArray(warnings) && warnings.includes('builder-warn'));
});

test('finalizeStreamExecution — reportMessage forwarded from responseBuilder', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult();
  const { reportMessage } = finalizeStreamExecution(result, streamResult, () => ({
    reportMessage: 'done!',
  }));
  assert.strictEqual(reportMessage, 'done!');
});
```

**Step 2 — Run to verify failure**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-executor.test.ts
```

Expected: import error — `finalizeStreamExecution` is not exported.

**Step 3 — Implement**

In [src/lib/tool-executor.ts](src/lib/tool-executor.ts):

1. Move `finalizeStreamExecution` out of the `ToolExecutor` class body and make it a named export at module level. Change the signature from `private finalizeStreamExecution<T>(...): ...` to:

```typescript
export function finalizeStreamExecution<T extends Record<string, unknown>>(
  result: CallToolResult,
  streamResult: StreamResult,
  responseBuilder: StreamResponseBuilder<T>,
): { result: CallToolResult; reportMessage?: string | undefined } {
  // identical body — no logic changes in this task
  if (result.isError) {
    return { result };
  }
  // ... (copy the existing body verbatim from the private method)
}
```

1. Inside `ToolExecutor`, update the two call sites that previously said `this.finalizeStreamExecution(...)`:
   - In `runStream` inner closure: change to `finalizeStreamExecution(...)`
   - In the inlined body inside `runGeminiStream` (from TASK-03): change to `finalizeStreamExecution(...)`

2. Export the `StreamResponseBuilder` type so the test file can import it if needed.

**Step 4 — Run tests**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-executor.test.ts
```

Expected: all 4 tests pass.

```bash
node scripts/tasks.mjs --quick
```

Expected: zero errors.

**Step 5 — Commit**

```bash
git add src/lib/tool-executor.ts __tests__/lib/tool-executor.test.ts
git commit -m "refactor(executor): extract finalizeStreamExecution as named export"
```

---

### TASK-05 — Delete `executeGeminiPipeline` + `GeminiPipelineRequest`, update 4 callers

|                |                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on** | TASK-04                                                                                                                                                                                                          |
| **Files**      | [src/lib/tool-executor.ts](src/lib/tool-executor.ts), [src/tools/analyze.ts](src/tools/analyze.ts), [src/tools/research.ts](src/tools/research.ts), [src/tools/review.ts](src/tools/review.ts)                   |
| **Symbols**    | [GeminiPipelineRequest](src/lib/tool-executor.ts#L137), [ToolExecutor](src/lib/tool-executor.ts#L151)                                                                                                            |
| **Outcome**    | `executeGeminiPipeline` method and `GeminiPipelineRequest` type deleted; 4 call sites rewritten to call `executor.runGeminiStream` with an explicit orchestration built by `buildOrchestrationRequestFromInputs` |

**Step 1 — No new test**

Existing tool tests serve as regression guard. Run baseline:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/chat.test.ts
```

Expected: all pass.

**Step 2 — Delete `executeGeminiPipeline` and `GeminiPipelineRequest` from tool-executor.ts**

Delete lines containing the `GeminiPipelineRequest` interface definition (currently lines 137–149) and the `executeGeminiPipeline` method (currently lines 470–496) from [src/lib/tool-executor.ts](src/lib/tool-executor.ts).

Remove `buildOrchestrationRequestFromInputs` and `BuiltInToolSpec` from the `tool-executor.ts` imports (they were only used inside `executeGeminiPipeline`). Keep `OrchestrationRequest` — it's used by `GeminiStreamRequest`.

**Step 3 — Update callers**

There are 4 call sites. The migration pattern for each is:

**Before (the `executeGeminiPipeline` pattern):**

```typescript
return await executor.executeGeminiPipeline(ctx, {
  toolName: '...',
  label: '...',
  commonInputs, // CommonToolInputs
  builtInToolSpecs, // extra BuiltInToolSpec[]
  buildContents,
  config,
  responseBuilder,
});
```

**After (the `runGeminiStream` pattern):**

```typescript
import { buildOrchestrationRequestFromInputs, type BuiltInToolSpec } from '../lib/orchestration.js';

// (add to existing orchestration import in each tool file)

const baseOrchestration = buildOrchestrationRequestFromInputs(commonInputs ?? {});
return await executor.runGeminiStream(ctx, {
  toolName: '...',
  label: '...',
  orchestration: {
    ...baseOrchestration,
    builtInToolSpecs: [...(baseOrchestration.builtInToolSpecs ?? []), ...(builtInToolSpecs ?? [])],
  },
  buildContents,
  config,
  responseBuilder,
});
```

Apply this pattern to each of the 4 call sites:

**[src/tools/analyze.ts](src/tools/analyze.ts) line ~148 (`analyze_file`):**

- `commonInputs` is whatever the tool passes — check the existing call to confirm the variable names
- `builtInToolSpecs` may be absent for `analyze_file` — skip the merge if so

**[src/tools/analyze.ts](src/tools/analyze.ts) line ~326 (`analyze_diagram`):**

- `diagramSpecs` is the extra `builtInToolSpecs` here

**[src/tools/research.ts](src/tools/research.ts) line ~857 (`analyze_url`):**

- Confirm variable names at the call site

**[src/tools/review.ts](src/tools/review.ts) line ~1265 (`analyze_pr`):**

- Confirm variable names at the call site

For call sites where `commonInputs` is undefined or not used, use `{}`: `buildOrchestrationRequestFromInputs({})`.

**Step 4 — Type-check**

```bash
npm run type-check
```

Expected: zero errors. If the tool files now import `buildOrchestrationRequestFromInputs` and they previously imported other symbols from `orchestration.ts`, merge the import statements.

**Step 5 — Run full suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass. Zero lint warnings (ESLint enforces 0 warnings).

**Step 6 — Commit**

```bash
git add src/lib/tool-executor.ts src/tools/analyze.ts src/tools/research.ts src/tools/review.ts
git commit -m "refactor(executor): delete executeGeminiPipeline; callers use runGeminiStream directly"
```

---

## PHASE-5: Warning pipeline simplification

### TASK-06 — Remove circular `sharedStructuredContent` intermediary

|                |                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on** | TASK-04                                                                                                                                                                                                                                         |
| **Files**      | [src/lib/tool-executor.ts](src/lib/tool-executor.ts)                                                                                                                                                                                            |
| **Symbols**    | [buildSharedStructuredMetadata](src/lib/response.ts#L370), [getStructuredWarnings](src/lib/tool-executor.ts#L96), [mergeDiagnostics](src/lib/tool-executor.ts#L107)                                                                             |
| **Outcome**    | `sharedStructuredContent` variable deleted from `finalizeStreamExecution`; `streamResult.warnings` used directly; `buildSharedStructuredMetadata` import removed from `tool-executor.ts`; behaviour identical; warning deduplication tests pass |

**Background**

Inside `finalizeStreamExecution`, this currently happens:

```typescript
// 1. Create object from streamResult.warnings
const sharedStructuredContent = buildSharedStructuredMetadata({
  ...(streamResult.warnings ? { warnings: streamResult.warnings } : {}),
});
// 2. Extract warnings back out from that same object
const mergedWarnings = [
  ...getStructuredWarnings(baseStructuredContent),
  ...getStructuredWarnings(overlayStructuredContent),
  ...getStructuredWarnings(built.structuredContent),
  ...getStructuredWarnings(sharedStructuredContent), // ← circular: extracts streamResult.warnings
];
// 3. Also pass sharedStructuredContent to mergeDiagnostics — which only looks for `.diagnostics`,
//    never present on sharedStructuredContent, so always produces nothing
const mergedDiagnostics = mergeDiagnostics([
  overlayStructuredContent,
  built.structuredContent,
  sharedStructuredContent as Record<string, unknown>, // ← always a no-op
]);
// 4. Spread sharedStructuredContent into the patch — mergeStructured strips .warnings from it anyway
const mergedResult = mergeStructured(
  { ...finalResult, ... },
  {
    ...(overlayStructuredContent ?? {}),
    ...(built.structuredContent ?? {}),
    ...sharedStructuredContent, // ← .warnings stripped by mergeStructured; net zero
    ...(mergedDiagnostics ? { diagnostics: mergedDiagnostics } : {}),
  },
  mergedWarnings.length > 0 ? { warnings: mergedWarnings } : undefined,
);
```

`sharedStructuredContent` participates in all three places but contributes nothing that `streamResult.warnings` doesn't already cover directly.

**Step 1 — Extend the `finalizeStreamExecution` tests from TASK-04**

Add to `__tests__/lib/tool-executor.test.ts`:

```typescript
test('finalizeStreamExecution — warnings from stream and responseBuilder are both present in structuredContent', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult({ warnings: ['stream-warn'] });
  const { result: out } = finalizeStreamExecution(result, streamResult, () => ({
    structuredContent: { warnings: ['builder-warn'] },
  }));
  const warnings = (out.structuredContent as Record<string, unknown> | undefined)?.warnings as
    | string[]
    | undefined;
  assert.ok(Array.isArray(warnings), 'structuredContent.warnings must exist');
  assert.ok(warnings.includes('stream-warn'), 'must include stream warning');
  assert.ok(warnings.includes('builder-warn'), 'must include builder warning');
});

test('finalizeStreamExecution — diagnostics from responseBuilder appear in structuredContent', () => {
  const result = makeToolResult();
  const streamResult = makeStreamResult();
  const { result: out } = finalizeStreamExecution(result, streamResult, () => ({
    structuredContent: { diagnostics: { tokenCount: 42 } },
  }));
  const sc = out.structuredContent as Record<string, unknown> | undefined;
  assert.deepStrictEqual((sc?.diagnostics as Record<string, unknown>).tokenCount, 42);
});
```

**Step 2 — Run to establish baseline**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-executor.test.ts
```

Expected: all tests pass (they should pass with the current code too — they define the contract).

**Step 3 — Simplify `finalizeStreamExecution`**

In [src/lib/tool-executor.ts](src/lib/tool-executor.ts), inside `finalizeStreamExecution`, make these changes:

1. **Delete** the `sharedStructuredContent` variable and the `buildSharedStructuredMetadata` call.

2. **Replace** the `mergedWarnings` array construction:

   Before:

   ```typescript
   const sharedStructuredContent = buildSharedStructuredMetadata({
     ...(streamResult.warnings ? { warnings: streamResult.warnings } : {}),
   });
   const mergedWarnings = [
     ...getStructuredWarnings(baseStructuredContent),
     ...getStructuredWarnings(overlayStructuredContent),
     ...getStructuredWarnings(built.structuredContent),
     ...getStructuredWarnings(sharedStructuredContent),
   ];
   ```

   After:

   ```typescript
   const mergedWarnings = [
     ...getStructuredWarnings(baseStructuredContent),
     ...getStructuredWarnings(overlayStructuredContent),
     ...getStructuredWarnings(built.structuredContent),
     ...(streamResult.warnings ?? []),
   ];
   ```

3. **Replace** the `mergeDiagnostics` call:

   Before:

   ```typescript
   const mergedDiagnostics = mergeDiagnostics([
     overlayStructuredContent,
     built.structuredContent,
     sharedStructuredContent as Record<string, unknown>,
   ]);
   ```

   After:

   ```typescript
   const mergedDiagnostics = mergeDiagnostics([overlayStructuredContent, built.structuredContent]);
   ```

4. **Replace** the `mergeStructured` patch argument:

   Before:

   ```typescript
   baseStructuredContent || overlayStructuredContent || built.structuredContent
     ? {
         ...(overlayStructuredContent ?? {}),
         ...(built.structuredContent ?? {}),
         ...sharedStructuredContent,
         ...(mergedDiagnostics ? { diagnostics: mergedDiagnostics } : {}),
       }
     : undefined,
   ```

   After:

   ```typescript
   baseStructuredContent || overlayStructuredContent || built.structuredContent
     ? {
         ...(overlayStructuredContent ?? {}),
         ...(built.structuredContent ?? {}),
         ...(mergedDiagnostics ? { diagnostics: mergedDiagnostics } : {}),
       }
     : undefined,
   ```

5. **Remove** `buildSharedStructuredMetadata` from the imports at the top of `tool-executor.ts` (it is still used in `research.ts` and `response.ts` — only remove from this file's import).

**Step 4 — Run tests**

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/tool-executor.test.ts
```

Expected: all 6 tests pass (4 from TASK-04 + 2 new ones).

```bash
node scripts/tasks.mjs
```

Expected: all checks pass.

**Step 5 — Commit**

```bash
git add src/lib/tool-executor.ts __tests__/lib/tool-executor.test.ts
git commit -m "refactor(executor): remove circular sharedStructuredContent in warning pipeline"
```

---

## Acceptance Criteria

- **AC-01** `node scripts/tasks.mjs` exits 0 after all five tasks are complete.
- **AC-02** `RESPONSE_FIELD_RULES`, `ResponseFieldRule`, `ResponseCloneStrategy`, `applyResponseClone`, `cloneValue` are absent from `src/sessions.ts`.
- **AC-03** `buildOrchestrationDiagnostics` is exported from `src/lib/orchestration.ts` and has ≥ 4 passing tests in `__tests__/lib/orchestration.test.ts`.
- **AC-04** `executeStreamWork` is absent from `src/lib/tool-executor.ts`.
- **AC-05** `executeGeminiPipeline` and `GeminiPipelineRequest` are absent from `src/lib/tool-executor.ts`.
- **AC-06** `finalizeStreamExecution` is a named export from `src/lib/tool-executor.ts` with ≥ 6 passing tests in `__tests__/lib/tool-executor.test.ts`.
- **AC-07** `buildSharedStructuredMetadata` is not imported in `src/lib/tool-executor.ts`.
- **AC-08** `sharedStructuredContent` variable name does not appear in `src/lib/tool-executor.ts`.
