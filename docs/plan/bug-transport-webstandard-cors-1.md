---
goal: Achieve web-standard transport CORS and exposed-header parity with Node HTTP transport
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: transport
status: 'Completed'
tags: [bug, transport, security, cors, web-standard]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

The Node HTTP transport in `src/transport.ts` applies deliberate CORS behavior via `applyCors()` and exposes the MCP headers `mcp-session-id` and `mcp-protocol-version` so browser clients can read them. The `startWebStandardTransport` path does not read `MCP_CORS_ORIGIN` at all, does not emit `Access-Control-*` headers, and does not expose MCP headers. This plan closes the gap so browser-facing behavior is consistent across both remote transports, and adds targeted regression tests.

## 1. Requirements & Constraints

- **REQ-001**: `startWebStandardTransport` MUST read `corsOrigin` from `getTransportConfig()` and apply CORS headers when `corsOrigin` is non-empty.
- **REQ-002**: When CORS is enabled, normal (`GET`/`POST`/`DELETE`) responses on `/mcp` MUST carry `Access-Control-Allow-Origin: <corsOrigin>` and `Access-Control-Expose-Headers: mcp-session-id, mcp-protocol-version`.
- **REQ-003**: When CORS is enabled, `OPTIONS /mcp` MUST return `204` with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`, and `Access-Control-Allow-Headers: Content-Type, mcp-session-id, Last-Event-Id, mcp-protocol-version`.
- **REQ-004**: When `corsOrigin` is empty, the web-standard handler MUST behave exactly as it does today (no new headers, no new preflight branch side effects).
- **SEC-001**: Host-header validation (`validateHostHeader`) MUST continue to reject disallowed hosts with `403` before any MCP processing. The preflight branch MUST NOT allow a disallowed host to bypass validation for non-OPTIONS methods.
- **SEC-002**: CORS headers MUST NOT be attached to `403 Forbidden` responses triggered by host mismatch, to avoid signaling policy to disallowed origins.
- **CON-001**: No behavior change for the Node HTTP transport.
- **CON-002**: No new runtime dependencies.
- **CON-003**: Must preserve `exactOptionalPropertyTypes` compliance and existing lint rules.
- **GUD-001**: Keep helpers colocated in `src/transport.ts`; do not introduce a new module.
- **PAT-001**: Match the Node path header set in `applyCors()` exactly for value parity.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Add CORS parity to `startWebStandardTransport` without regressing existing behavior.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/transport.ts`, add private helper `applyCorsHeaders(headers: Headers, corsOrigin: string): void` that sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, mcp-session-id, Last-Event-Id, mcp-protocol-version`, and `Access-Control-Expose-Headers: mcp-session-id, mcp-protocol-version`. No-op when `corsOrigin` is empty.                                                | ✅        | 2026-04-22 |
| TASK-002 | Add private helper `withCors(response: Response, corsOrigin: string): Response` that returns `response` unchanged when `corsOrigin` is empty; otherwise clones into a new `Response` preserving `status`, `statusText`, and `body`, with a merged `Headers` object produced via `applyCorsHeaders`.                                                                                                                                                                          | ✅        | 2026-04-22 |
| TASK-003 | Add private helper `corsPreflightResponse(corsOrigin: string): Response` that returns `new Response(null, { status: 204, headers })` where `headers` contains `applyCorsHeaders` output.                                                                                                                                                                                                                                                                                     | ✅        | 2026-04-22 |
| TASK-004 | Update `startWebStandardTransport` destructure: `const { port, host, corsOrigin, isStateless, maxSessions, sessionTtlMs } = getTransportConfig();`.                                                                                                                                                                                                                                                                                                                          | ✅        | 2026-04-22 |
| TASK-005 | In the `handler` closure, reorder/augment branches to: (1) host validation → early `return new Response('Forbidden', { status: 403 })` without CORS headers; (2) pathname check → `return withCors(new Response('Not Found', { status: 404 }), corsOrigin)`; (3) if `corsOrigin && req.method === 'OPTIONS'` → `return corsPreflightResponse(corsOrigin)`; (4) normal flow → wrap `handleManagedRequest(...)` result with `withCors(response, corsOrigin)` before returning. | ✅        | 2026-04-22 |
| TASK-006 | Confirm no other code path in `startWebStandardTransport` returns a `Response` that bypasses `withCors` (except the `403` Forbidden and the preflight).                                                                                                                                                                                                                                                                                                                      | ✅        | 2026-04-22 |

### Implementation Phase 2

- GOAL-002: Pin the new contract with regression tests and verify build/lint/type/tests.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-007 | In `__tests__/transport.test.ts`, add `delete process.env.MCP_CORS_ORIGIN;` to the existing `afterEach` cleanup block.                                                                                                                                                                                                                                                                                                                                                                                                | ✅        | 2026-04-22 |
| TASK-008 | Add test: "returns CORS preflight headers when enabled" — sets `MCP_STATELESS=true`, `MCP_CORS_ORIGIN=https://app.example.com`, starts `startWebStandardTransport(() => createServerInstance())`, sends `OPTIONS http://127.0.0.1:3000/mcp` with `host: 127.0.0.1:3000` and `origin: https://app.example.com`, asserts `status === 204`, `Access-Control-Allow-Origin === 'https://app.example.com'`, and `Access-Control-Expose-Headers` matches `/mcp-session-id/`. Close transport in `finally`.                   | ✅        | 2026-04-22 |
| TASK-009 | Add test: "exposes MCP headers on normal responses when CORS is enabled" — sets `MCP_STATELESS=false`, `MCP_CORS_ORIGIN=https://app.example.com`, starts transport, sends a valid `initialize` request via the existing `createRequest` helper with `LATEST_PROTOCOL_VERSION`, asserts `status === 200`, `Access-Control-Allow-Origin === 'https://app.example.com'`, `Access-Control-Expose-Headers` matches `/mcp-session-id/`, and `mcp-session-id` header is present and non-empty. Close transport in `finally`. | ✅        | 2026-04-22 |
| TASK-010 | Add test: "omits CORS headers when MCP_CORS_ORIGIN is unset" — no env set, send normal `initialize`, assert `Access-Control-Allow-Origin` is `null`.                                                                                                                                                                                                                                                                                                                                                                  | ✅        | 2026-04-22 |
| TASK-011 | Add test: "403 Forbidden host mismatch does not include CORS headers" — set `MCP_HTTP_HOST=127.0.0.1`, `MCP_ALLOWED_HOSTS=127.0.0.1`, `MCP_CORS_ORIGIN=https://app.example.com`, send request with `host: evil.example.com`, assert `status === 403` and `Access-Control-Allow-Origin` is `null`.                                                                                                                                                                                                                     | ✅        | 2026-04-22 |
| TASK-012 | Run `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`; ensure all pass.                                                                                                                                                                                                                                                                                                                                                                                                                          | ✅        | 2026-04-22 |

## 3. Alternatives

- **ALT-001**: Mutate the existing `Response.headers` in place instead of cloning. Rejected: `Response.headers` is immutable after construction for `fetch`-produced responses from underlying SDK transports; cloning via `new Response(body, { status, statusText, headers })` is the safe cross-runtime approach.
- **ALT-002**: Extract CORS logic into a new `src/lib/cors.ts` module shared by both transports. Rejected for this iteration: Node path uses Express middleware, web-standard path uses `Response` composition; a shared module would require adapter layering disproportionate to the surface area. Can be revisited if more transports land.
- **ALT-003**: Always attach CORS headers to `403` Forbidden responses (as in the draft diff in `.github/report.md`). Rejected per SEC-002: emitting `Access-Control-Allow-Origin` on a host-rejection response leaks policy to disallowed origins. Preflight for disallowed host still fails at the host validation stage, which is the correct behavior.
- **ALT-004**: Place the `OPTIONS` preflight branch before host validation so browsers get a `204` regardless of Host. Rejected per SEC-001: host allowlist is the primary DNS-rebinding defense and must run first.

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server` (existing) — `WebStandardStreamableHTTPServerTransport`, `LATEST_PROTOCOL_VERSION`.
- **DEP-002**: `src/config.ts` — `getTransportConfig()` already exposes `corsOrigin`; no change required.
- **DEP-003**: `src/lib/validation.ts` — `resolveAllowedHosts`, `validateHostHeader` unchanged.

## 5. Files

- **FILE-001**: `src/transport.ts` — add `applyCorsHeaders`, `withCors`, `corsPreflightResponse` helpers; update `startWebStandardTransport` destructure and `handler` branches.
- **FILE-002**: `__tests__/transport.test.ts` — extend `afterEach` cleanup and add four regression tests inside the existing `describe('startWebStandardTransport', ...)` block.

## 6. Testing

- **TEST-001**: `OPTIONS /mcp` with `MCP_CORS_ORIGIN` set returns `204` and full CORS header set including `Access-Control-Expose-Headers: mcp-session-id, mcp-protocol-version`.
- **TEST-002**: Normal `initialize` request with `MCP_CORS_ORIGIN` set returns `200` with `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers`, and emits `mcp-session-id`.
- **TEST-003**: Normal request with `MCP_CORS_ORIGIN` unset returns no `Access-Control-*` headers (baseline preservation).
- **TEST-004**: Host mismatch returns `403` with no CORS headers attached (SEC-002).
- **TEST-005**: Existing web-standard tests (404 unknown session, host validation success/failure, stateless/stateful flows) continue to pass unchanged.
- **TEST-006**: `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test` all pass.

## 7. Risks & Assumptions

- **RISK-001**: Wrapping every response via `withCors` clones headers on each request. Mitigation: the clone is O(n) over a small fixed header set and only occurs when `corsOrigin` is non-empty (helper is a no-op otherwise).
- **RISK-002**: Underlying SDK `Response` bodies may be streaming; re-wrapping with `new Response(response.body, ...)` transfers the stream. Assumption: `WebStandardStreamableHTTPServerTransport` returns a standard `Response` whose body is a `ReadableStream` or `null`, which is safe to re-wrap once.
- **RISK-003**: Adding an `OPTIONS` branch could collide with future SDK-level preflight handling. Mitigation: branch is gated on `corsOrigin` being set; existing SDK dispatch remains the default.
- **ASSUMPTION-001**: `MCP_CORS_ORIGIN` semantics match the Node HTTP path: a single origin string; no wildcard or multi-origin negotiation.
- **ASSUMPTION-002**: Test helpers `createRequest`, `LATEST_PROTOCOL_VERSION`, and `createServerInstance` already imported in `__tests__/transport.test.ts` are reusable for the new tests.

## 8. Related Specifications / Further Reading

- `.github/report.md` — MCP transport review identifying the CORS parity gap.
- `src/transport.ts` — current `applyCors` (Node HTTP) and `startWebStandardTransport` implementations.
- `src/config.ts` — `getTransportConfig()` and `corsOrigin` derivation from `MCP_CORS_ORIGIN`.
- MCP Streamable HTTP specification — `mcp-session-id` and `mcp-protocol-version` response headers.
