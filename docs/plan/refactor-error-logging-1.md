# Refactor error logging for shutdown, research tools, and transport

This plan addresses three defects identified in the code review of error handling and logging in `gemini-assistant`: (1) `createServerInstance().close()` silently swallows shutdown failures, preventing `closeStartedRuntime()` in [src/index.ts](src/index.ts) from reporting them; (2) [src/tools/research-job.ts](src/tools/research-job.ts) writes raw user queries, topics, and sampled model output to the MCP client log channel, bypassing the summarization guard in [src/lib/logger.ts](src/lib/logger.ts); and (3) [src/transport.ts](src/transport.ts) `logRequestFailure` emits only `err.message`, losing method, session, and stack metadata at a security boundary. Two optional observability improvements (lazy logger sink, broadcast-failure accounting) are included as follow-ups.

## 1. Requirements & Constraints

- **REQ-001**: `createServerInstance().close()` MUST reject when any cleanup step or `server.close()` throws, aggregating multiple failures via `AggregateError`.
- **REQ-002**: `logRequestFailure` in [src/transport.ts](src/transport.ts) MUST include `requestMethod`, `sessionId` (when available), `error` message, and `stack` as structured data.
- **REQ-003**: [src/tools/research-job.ts](src/tools/research-job.ts) MUST NOT emit raw user query, topic, or sampled model text to `ctx.mcpReq.log(...)` by default.
- **REQ-004**: Detailed diagnostics (including raw payloads) MUST continue to flow through the server `logger` and respect `LOG_VERBOSE_PAYLOADS` via `maybeSummarizePayload`.
- **SEC-001**: Transport-layer failure logs MUST NOT leak into JSON-RPC response bodies; only operator log sinks receive stack traces.
- **SEC-002**: Client-visible MCP log messages in research paths MUST be neutral phrasing (e.g., "Search requested") with no raw prompt or model output content.
- **CON-001**: Public tool signatures and `CallToolResult` shapes MUST remain unchanged.
- **CON-002**: Behavioral contract for `closeStartedRuntime()` (single error vs. `AggregateError`) MUST remain consistent with its current pattern in [src/index.ts](src/index.ts).
- **CON-003**: No changes to Zod input/output schemas or MCP protocol surface.
- **GUD-001**: Use `AppError.formatMessage(err)` for error stringification instead of `String(err)`.
- **GUD-002**: Use `logger.child('<context>')` scoped loggers; never instantiate new `Logger` instances in tool modules.
- **PAT-001**: Follow the existing `safeRun(label, fn)` pattern in [src/server.ts](src/server.ts), but accumulate errors into a local array and rethrow after all steps complete.
- **PAT-002**: For conditional object spreads with `exactOptionalPropertyTypes`, use `...(x ? { key: x } : {})` per existing codebase convention.

## 2. Implementation Steps

### Implementation Phase 1 — Shutdown truthfulness

- GOAL-001: Make `createServerInstance().close()` surface cleanup and `server.close()` failures to callers without losing best-effort cleanup ordering.

| Task     | Description                                                                                                                                                                                                                            | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In [src/server.ts](src/server.ts), import `AppError` from `./lib/errors.js`.                                                                                                                                                           |           |      |
| TASK-002 | In the `close` closure returned by `createServerInstance`, introduce `const closeErrors: Error[] = []`.                                                                                                                                |           |      |
| TASK-003 | Refactor `safeRun` to push a new `Error` (with message `close: ${label} failed: ${AppError.formatMessage(err)}`) into `closeErrors` and still call `log.warn(error.message, { stack: err instanceof Error ? err.stack : undefined })`. |           |      |
| TASK-004 | Replace the `try { await server.close(); } catch` block with the same pattern: push a structured `Error` into `closeErrors` and log a warning with stack metadata.                                                                     |           |      |
| TASK-005 | After all cleanup steps, if `closeErrors.length === 1` rethrow `closeErrors[0]`; if `closeErrors.length > 1` rethrow `new AggregateError(closeErrors, 'Server instance shutdown failed')`.                                             |           |      |
| TASK-006 | Verify `closeStartedRuntime()` in [src/index.ts](src/index.ts) correctly captures the thrown error into its `errors[]` array without code changes (read-only verification).                                                            |           |      |

### Implementation Phase 2 — Research tool log redaction

- GOAL-002: Remove raw user query/topic/sampled text from MCP client logs in [src/tools/research-job.ts](src/tools/research-job.ts) and route diagnostic payloads through the summarization-aware server logger.

| Task     | Description                                                                                                                                                                                                                                                  | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-007 | In [src/tools/research-job.ts](src/tools/research-job.ts), add imports: `AppError` from `../lib/errors.js` and `{ logger, maybeSummarizePayload }` from `../lib/logger.js`. Declare `const log = logger.child('research');`.                                 |           |      |
| TASK-008 | Change `runToolStream` signature to accept a neutral `logMessage: string` and a structured `logData: unknown`. Send `logMessage` to `ctx.mcpReq.log('info', ...)` and call `log.info(logMessage, maybeSummarizePayload(logData, log.getVerbosePayloads()))`. |           |      |
| TASK-009 | Update `searchWork` call site: replace `` `Search: ${query}` `` with message `'Search requested'` and data `{ query, urlCount: urls?.length ?? 0 }`.                                                                                                         |           |      |
| TASK-010 | Update `analyzeUrlWork` call site: replace `` `Analyzing ${String(urls.length)} URL(s)` `` with message `'Analyze URL requested'` and data `{ question, urlCount: urls.length }`.                                                                            |           |      |
| TASK-011 | Update `agenticSearchWork` call site: replace `` `Agentic search: ${topic}` `` with message `'Agentic search requested'` and data `{ topic, searchDepth }`.                                                                                                  |           |      |
| TASK-012 | In `enrichTopicWithSampling`, replace `` `Sampled context: ${sampledText}` `` with neutral MCP log `'Sampling provided research angles'`, then `log.debug('Sampling provided research angles', { sampledTextLength: sampledText.length })`.                  |           |      |
| TASK-013 | In `enrichTopicWithSampling` catch block, change MCP log to `'Sampling unavailable; continuing without extra angles'` and emit `log.info('requestSampling encountered an issue', { error: AppError.formatMessage(error) })`.                                 |           |      |
| TASK-014 | In `agenticSearchWork` elicitation catch, change MCP log to `'Elicitation skipped; continuing without extra constraints'` and emit `log.warn('Elicitation skipped or failed', { error: AppError.formatMessage(err) })`.                                      |           |      |

### Implementation Phase 3 — Transport diagnostics

- GOAL-003: Expand `logRequestFailure` in [src/transport.ts](src/transport.ts) to structured metadata and thread `requestMethod` + optional `sessionId` through every call site.

| Task     | Description                                                                                                                                                                             | Completed | Date |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-015 | In [src/transport.ts](src/transport.ts), change `logRequestFailure(label, err)` signature to `logRequestFailure(label, err, meta: { requestMethod: string; sessionId?: string })`.      |           |      |
| TASK-016 | Body of `logRequestFailure` must call `log.error(label, { ...meta, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })`.    |           |      |
| TASK-017 | Locate every `logRequestFailure(...)` call site inside the managed-request helper and pass `{ requestMethod, ...(sessionId ? { sessionId } : {}) }` from the surrounding closure scope. |           |      |
| TASK-018 | Verify no HTTP response body changes: `nodeErrorResponse` / `responseError` helpers MUST remain untouched.                                                                              |           |      |

### Implementation Phase 4 — Tests

- GOAL-004: Add regression tests for all three must-fix items.

| Task     | Description                                                                                                                                                                                                                      | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-019 | In `__tests__/index.test.ts` (or a new test), add a case where `server.close()` throws and assert `createServerInstance().close()` rejects; also assert `closeStartedRuntime({ stdioInstance })` rethrows the same error.        |           |      |
| TASK-020 | In `__tests__/index.test.ts`, add a case where both a cleanup subscriber and `server.close()` throw and assert `AggregateError` is thrown with `errors.length === 2`.                                                            |           |      |
| TASK-021 | In `__tests__/tools/research.test.ts`, assert that MCP log entries emitted during a search never contain the raw `query` text and during agentic search never contain the raw `topic` text when `LOG_VERBOSE_PAYLOADS` is unset. |           |      |
| TASK-022 | In `__tests__/transport.test.ts`, inject a handled request failure (mock transport to throw) and assert the logger receives an entry with `requestMethod`, `sessionId` (when provided), `error`, and `stack` fields.             |           |      |

### Implementation Phase 5 — Optional follow-ups

- GOAL-005: Address the two optional observations from the review without changing public behavior.

| Task     | Description                                                                                                                                                                                                                                                 | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-023 | Make the default file sink in [src/lib/logger.ts](src/lib/logger.ts) lazy: defer `mkdirSync` and `createWriteStream` until the first `log()` call, or gate behind a config flag (e.g., `LOG_FILE_SINK`).                                                    |           |      |
| TASK-024 | In `Logger.broadcastToServers`, capture `Promise.allSettled` results, count rejections, and emit at most one `log.warn('broadcast to N server(s) failed', { count })` per broadcast batch. Guard against recursion by writing directly to `this.logStream`. |           |      |

## 3. Alternatives

- **ALT-001**: Keep `server.close()` best-effort but add a separate boolean return channel from `close()` indicating success. Rejected: breaks the `ServerInstance.close: () => Promise<void>` contract already consumed by [src/index.ts](src/index.ts) and makes aggregation harder.
- **ALT-002**: Redact log payloads inside `ctx.mcpReq.log` itself by wrapping it in a helper. Rejected: `ctx.mcpReq.log` is provided by the MCP SDK and not reliably wrappable per call site; tool-level discipline is simpler and colocated with intent.
- **ALT-003**: Switch transport logging to structured JSON only without including stack. Rejected: stack is the single most valuable operator signal and is not exposed over the wire.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` — provides `ServerContext`, `McpServer`, `InMemoryTaskStore` (no version change).
- **DEP-002**: `@modelcontextprotocol/node` — transport runtime (no version change).
- **DEP-003**: Node.js `AggregateError` (built-in on Node 24+) — already required by `engines.node` in [package.json](package.json).

## 5. Files

- **FILE-001**: [src/server.ts](src/server.ts) — error-aggregating `close` closure in `createServerInstance`.
- **FILE-002**: [src/tools/research-job.ts](src/tools/research-job.ts) — `runToolStream` signature, three call sites, `enrichTopicWithSampling`, elicitation catch.
- **FILE-003**: [src/transport.ts](src/transport.ts) — `logRequestFailure` signature + call sites within the managed-request helper.
- **FILE-004**: [src/lib/logger.ts](src/lib/logger.ts) — optional lazy file sink + broadcast failure accounting.
- **FILE-005**: [\_\_tests\_\_/index.test.ts](__tests__/index.test.ts) — shutdown rejection and aggregate tests.
- **FILE-006**: [\_\_tests\_\_/tools/research.test.ts](__tests__/tools/research.test.ts) — redaction assertions.
- **FILE-007**: [\_\_tests\_\_/transport.test.ts](__tests__/transport.test.ts) — structured failure log assertions.

## 6. Testing

- **TEST-001**: Shutdown single-error: mock `server.close()` to throw; expect `createServerInstance().close()` to reject with that error.
- **TEST-002**: Shutdown aggregate: mock two cleanup steps to throw and `server.close()` to throw; expect `AggregateError` with `errors.length >= 2`.
- **TEST-003**: `closeStartedRuntime` propagation: provide a `stdioInstance.close` that throws; expect the outer shutdown to reject with a wrapped `Error`.
- **TEST-004**: Research redaction: invoke `search` with `query = 'SECRET-QUERY'`; assert no captured MCP log message contains `'SECRET-QUERY'` when `LOG_VERBOSE_PAYLOADS` is unset.
- **TEST-005**: Research redaction (agentic): invoke `agentic_search` with `topic = 'SECRET-TOPIC'`; assert no captured MCP log message contains `'SECRET-TOPIC'`.
- **TEST-006**: Transport diagnostics: simulate a handler-thrown error; assert the logger entry contains `requestMethod`, `sessionId` (when header present), `error`, and `stack`.
- **TEST-007**: Transport diagnostics (no session): same as TEST-006 but without `mcp-session-id`; assert `sessionId` is absent from log data rather than `undefined`.
- **TEST-008**: Existing contract and transport tests MUST continue to pass unchanged (`npm run test`).

## 7. Risks & Assumptions

- **RISK-001**: Existing callers may rely on `createServerInstance().close()` being infallible. Mitigation: `closeStartedRuntime()` already aggregates errors; no other caller outside tests invokes it directly.
- **RISK-002**: Tests capturing MCP logs may be brittle if future SDK updates change the log shape. Mitigation: assert on message content substrings only, not full structural equality.
- **RISK-003**: Lazy logger initialization (TASK-023) could change startup error semantics if the log directory is unwritable. Mitigation: surface the first write failure to `process.stderr` and continue without a file sink.
- **ASSUMPTION-001**: `ctx.mcpReq.log` is the only MCP log channel used by research tooling (verified via grep of `src/tools/research-job.ts`).
- **ASSUMPTION-002**: No downstream consumer parses the current textual form of `logRequestFailure` output (internal operator log only).
- **ASSUMPTION-003**: `AppError.formatMessage` is the canonical error stringification utility across the codebase.

## 8. Related Specifications / Further Reading

- [src/lib/errors.ts](src/lib/errors.ts) — `AppError` taxonomy and `formatMessage` helper.
- [src/lib/logger.ts](src/lib/logger.ts) — `Logger`, `ScopedLogger`, `maybeSummarizePayload`, and `LOG_VERBOSE_PAYLOADS` gating.
- [AGENTS.md](AGENTS.md) — required `npm run lint` / `npm run type-check` / `npm run test` gates before landing.
