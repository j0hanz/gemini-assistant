# Test Suite Design — gemini-assistant

**Date:** 2026-04-30
**Status:** Approved

## Context

All prior tests were wiped to start fresh. This document captures the agreed design for the new test suite — built from the ground up to be optimal for this codebase, zero API token cost, and maintainable long-term.

---

## Decisions

| #   | Decision      | Choice                                                               |
| :-- | :------------ | :------------------------------------------------------------------- |
| 1   | Scope         | Unit + integration with mock Gemini (no real API calls ever)         |
| 2   | Gemini mock   | `mock.module()` on `getAI()` via Node.js built-in `node:test`        |
| 3   | Mock infra    | Shared `__tests__/lib/mock-gemini.ts` factory                        |
| 4   | Layer order   | Pure logic first, tool integration layer second                      |
| 5   | Test style    | Behavior-focused `test()` nesting; table-driven for schemas/profiles |
| 6   | Env isolation | Set/restore `process.env` in `before`/`after` hooks per test         |

---

## Test Runner

- **Runner:** Node.js built-in `node:test` (no Jest/Vitest)
- **Execution:** `tsx/esm` loader via `--import tsx/esm`
- **Env:** `.env` file via `--env-file=.env`
- **Discovery:** Node walks `__tests__/` recursively for `*.test.ts`
- **Single file:** `node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts`

---

## File Structure

```
__tests__/
├── lib/
│   ├── mock-gemini.ts          ← shared factory (NOT a test file)
│   ├── errors.test.ts
│   ├── tool-profiles.test.ts
│   ├── validation.test.ts
│   ├── streaming.test.ts
│   └── response.test.ts
│
├── schemas/
│   ├── fields.test.ts
│   ├── inputs.test.ts
│   └── validators.test.ts
│
├── sessions.test.ts
├── config.test.ts
├── catalog.test.ts
│
└── tools/                      ← Phase 2 (after pure logic suite is solid)
    ├── chat.test.ts
    ├── research.test.ts
    ├── analyze.test.ts
    └── review.test.ts
```

---

## Shared Mock Factory (`__tests__/lib/mock-gemini.ts`)

Exports helpers that produce fake `AsyncIterable<GenerateContentResponse>` chunks without touching any network or API endpoint.

```typescript
// Core primitives
mockStream(chunks: Partial<GenerateContentResponse>[]): AsyncIterable<GenerateContentResponse>
mockTextResponse(text: string): AsyncIterable<GenerateContentResponse>
mockFunctionCallResponse(name: string, args: Record<string, unknown>): AsyncIterable<GenerateContentResponse>
mockUsageResponse(text: string, inputTokens: number, outputTokens: number): AsyncIterable<GenerateContentResponse>

// AI client stub
createMockAI(responses: AsyncIterable<GenerateContentResponse>[]): GoogleGenAI
```

Used in integration tests via:

```typescript
mock.module('../../src/client.js', () => ({
  getAI: () => createMockAI([mockTextResponse('hello')]),
}));
```

---

## Phase 1 — Pure Logic (no mocks needed)

### `__tests__/lib/errors.test.ts`

| Behavior                          | What to assert                                                                    |
| :-------------------------------- | :-------------------------------------------------------------------------------- |
| `AppError` construction           | `toolName`, `category`, `retryable`, `statusCode` set correctly                   |
| `withRetry` — retryable error     | Retries exactly 2 times before throwing                                           |
| `withRetry` — non-retryable error | Throws immediately, no retries                                                    |
| `withRetry` — abort signal        | Cancels before retry fires                                                        |
| `withRetry` — succeeds on 2nd try | Returns result without throwing                                                   |
| Finish-reason mapping             | `MALFORMED_FUNCTION_CALL`, `BLOCKLIST`, `PROHIBITED_CONTENT` → correct error type |
| `isAbortError()`                  | True for `AbortError`, false for generic `Error`                                  |

### `__tests__/lib/tool-profiles.test.ts`

Table-driven across all 13 profiles: `plain`, `grounded`, `web-research`, `deep-research`, `urls-only`, `code-math`, `code-math-grounded`, `visual-inspect`, `rag`, `agent`, `structured`, `fileSearch`.

| Behavior                                    | What to assert                                                                           |
| :------------------------------------------ | :--------------------------------------------------------------------------------------- |
| All named profiles resolve without throwing | Each profile → valid `ResolvedProfile`                                                   |
| Unknown profile name                        | `validateProfile()` throws                                                               |
| `fileSearch` is mutually exclusive          | Combining `fileSearch` with any other capability throws                                  |
| Capability sets per profile                 | `grounded` includes grounding tool; `web-research` includes search; `plain` has no tools |
| Override application                        | Profile overrides applied correctly to `ResolvedProfile`                                 |

### `__tests__/schemas/inputs.test.ts`

Table-driven for `ChatInput`, `ResearchInput`, `AnalyzeInput`, `ReviewInput`.

| Behavior                          | What to assert                                            |
| :-------------------------------- | :-------------------------------------------------------- |
| Valid minimal input passes        | No error thrown                                           |
| Extra properties rejected         | `z.strictObject()` throws on unknown keys                 |
| Required fields enforced          | Missing required field → parse error                      |
| Enum fields reject invalid values | `thinkingLevel` outside `MINIMAL/LOW/MEDIUM/HIGH` → error |
| `thinkingBudget` constraints      | Negative value rejected                                   |

### `__tests__/schemas/fields.test.ts`

| Behavior                                 | What to assert                |
| :--------------------------------------- | :---------------------------- |
| `ToolsSpecSchema` — valid profile name   | Parses                        |
| `ToolsSpecSchema` — unknown profile name | Rejects                       |
| `textField()` — empty string             | Behavior per field definition |

### `__tests__/schemas/validators.test.ts`

| Behavior                      | What to assert            |
| :---------------------------- | :------------------------ |
| Valid Gemini JSON schema      | No error                  |
| Invalid schema (missing type) | Validation error returned |
| Nested object schema          | Passes through correctly  |

### `__tests__/sessions.test.ts`

| Behavior                                                                     | What to assert                  |
| :--------------------------------------------------------------------------- | :------------------------------ |
| `appendSessionTurn` — creates new session                                    | Session exists after append     |
| `appendSessionTurn` — appends to existing                                    | Turn count increments           |
| `buildReplayHistoryParts` — filters thought-only parts                       | No pure thought parts in output |
| `buildReplayHistoryParts` — preserves thoughtSignature on functionCall parts | Signature present               |
| `selectReplayWindow` — drops oldest turns to fit `maxBytes`                  | Result fits within limit        |
| `selectReplayWindow` — always keeps at least initial message                 | Initial user message preserved  |
| `sanitizeSessionText` — redacts API key patterns                             | `API_KEY=abc123` → redacted     |
| `sanitizeSessionText` — redacts password patterns                            | `password: secret` → redacted   |
| `sanitizeSessionText` — preserves unrelated text                             | Normal text unchanged           |
| LRU eviction — `maxSessions` exceeded                                        | Oldest session evicted          |
| TTL eviction — session past TTL                                              | Evicted on sweep                |
| Session not found                                                            | Returns `undefined`             |

### `__tests__/config.test.ts`

| Behavior                                | What to assert                              |
| :-------------------------------------- | :------------------------------------------ |
| Boolean `"true"` parses to `true`       | Correct                                     |
| Boolean `"false"` parses to `false`     | Correct                                     |
| Boolean `"yes"` / `"1"` / `"on"` throws | Strict parsing enforced                     |
| Missing `API_KEY` throws                | Error thrown at parse time                  |
| `MCP_HTTP_PORT` defaults to `3000`      | Default applied                             |
| `TRANSPORT` defaults to `"stdio"`       | Default applied                             |
| Invalid `TRANSPORT` value throws        | Only `stdio`/`http`/`web-standard` accepted |

### `__tests__/lib/validation.test.ts`

| Behavior                         | What to assert                              |
| :------------------------------- | :------------------------------------------ |
| Path within root                 | Returns resolved path                       |
| `../` traversal rejected         | Throws or returns error                     |
| Symlink escape rejected          | Path outside root after realpath → rejected |
| Host in allowlist                | Passes                                      |
| Host not in allowlist            | Rejected                                    |
| `parseAllowedHosts()` — wildcard | Matches any subdomain                       |

### `__tests__/catalog.test.ts`

| Behavior                      | What to assert                      |
| :---------------------------- | :---------------------------------- |
| `discover://catalog` render   | Contains all 4 tool names           |
| `discover://workflows` render | Contains all workflow names         |
| Markdown structure            | Headings present, no empty sections |

---

## Phase 2 — Integration Layer (tools + mock Gemini)

Deferred until Phase 1 suite is solid. Each tool test:

1. Sets up `mock.module()` on `../../src/client.js` returning `createMockAI([...])`
2. Creates fake `ToolServices` using `createDefaultToolServices()` with a real in-memory `SessionStore`
3. Calls the tool handler directly (not via MCP transport)
4. Asserts on the returned `CallToolResult` shape

### `__tests__/tools/chat.test.ts`

| Behavior                   | What to assert                                           |
| :------------------------- | :------------------------------------------------------- |
| Happy path — text response | `content[0].text` matches mock output                    |
| Session persistence        | Second call with same `sessionId` has history in content |
| Structured output          | `structuredContent` populated when schema provided       |
| Abort signal               | Tool exits early, no result                              |

### `__tests__/tools/research.test.ts`

| Behavior                    | What to assert                                   |
| :-------------------------- | :----------------------------------------------- |
| Quick mode — streaming text | Result text present                              |
| Grounding signals           | `groundingMetadata` extracted from mock response |

### `__tests__/tools/analyze.test.ts` / `review.test.ts`

| Behavior              | What to assert                        |
| :-------------------- | :------------------------------------ |
| File path input       | Resolved, passed to mock AI correctly |
| Error on missing file | `AppError` with `client` category     |

---

## Token Cost Guarantee

- `getAI()` is never called with a real `API_KEY` in any test
- `mock.module()` intercepts the module before any network call
- `.env` file is loaded but `getAI()` is replaced before it can use `API_KEY`
- No `fetch`, no HTTP, no Gemini endpoint contacted in any test

---

## Quality Rules

- One assertion per `test()` block where practical
- Test names read as behavior specs: `test('withRetry — retries on retryable error')`
- `before`/`after` hooks restore `process.env` mutations
- Table-driven tests use `for` loops with descriptive case labels
- No snapshot tests (no extra tooling, no intent-masking)
