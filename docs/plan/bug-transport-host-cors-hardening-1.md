---
goal: Align transport host validation, harden CORS, tighten resource notification allow-list, and close related testing gaps
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['bug', 'security', 'transport', 'contract', 'test']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

A review of the MCP v2 wiring in `gemini-assistant` uncovered a small set of safety and contract risks on the transport layer plus related test gaps. The public MCP surface, task lifecycle, stdio diagnostic safety, and capability declaration order are already correct and must be preserved. This plan applies minimal, targeted diffs to (a) eliminate DNS-rebinding protection asymmetry between the Node/Express and Web-Standard transports, (b) tighten CORS response handling, (c) replace the prefix-based resource notification allow-list with an exact set, (d) make `registerResources`' session store parameter required, and (e) lock the above invariants behind tests.

## 1. Requirements & Constraints

- **REQ-001**: Node HTTP transport and Web-Standard transport MUST use identical default `allowedHosts` resolution rules given the same bind host.
- **REQ-002**: When `MCP_CORS_ORIGIN` is a non-wildcard value, responses MUST include `Vary: Origin`.
- **REQ-003**: `MCP_CORS_ORIGIN=*` combined with `MCP_STATELESS=false` MUST be rejected at config-parse time.
- **REQ-004**: Non-loopback, non-broad binds (e.g. LAN IPv4) without an explicit `MCP_ALLOWED_HOSTS` MUST emit a warn-level log.
- **REQ-005**: `sendResourceChangedForServer` MUST only emit notifications for URIs that appear in a registered allow-list derived from `PUBLIC_RESOURCE_URIS` plus active session/cache template expansions.
- **REQ-006**: `registerResources(server, sessionStore, rootsFetcher)` MUST require `sessionStore` explicitly.
- **SEC-001**: No change may weaken existing Host header validation on either transport.
- **SEC-002**: No change may introduce writes to `process.stdout` in stdio mode.
- **CON-001**: MCP SDK v2 packages only (`@modelcontextprotocol/server` / `/node` / `/express`). No `@modelcontextprotocol/sdk` imports.
- **CON-002**: Preserve the existing Zod v4 schema library and helper layering.
- **CON-003**: Preserve `McpServer` usage. The single documented drop to `server.setRequestHandler('tools/call', ...)` in [src/lib/task-utils.ts](src/lib/task-utils.ts) is intentional and MUST remain unchanged by this plan.
- **CON-004**: Public contracts in [src/public-contract.ts](src/public-contract.ts) MUST NOT change.
- **CON-005**: Task lifecycle wiring (`registerTaskTool`, `runToolAsTask`, `createToolTaskHandlers`, terminal-status semantics) MUST NOT change.
- **GUD-001**: Small, additive diffs over rewrites. Each task below touches one concern.
- **GUD-002**: Every new invariant must be pinned by at least one test in `__tests__/`.
- **PAT-001**: Follow existing transport helpers (`resolveAllowedHosts`, `warnIfUnprotected`, `withCors`, `applyCors`) and extend them; do not introduce parallel abstractions.
- **PAT-002**: Follow existing config parser patterns in [src/config.ts](src/config.ts) (`parseBooleanEnv`, `parseNonEmptyStringEnv`, throw-on-invalid).

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Align Node and Web-Standard transports on a single host-resolution rule and warn on risky binds.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-001 | In [src/transport.ts](src/transport.ts) `startHttpTransport`, replace `parseAllowedHosts()` with `resolveAllowedHosts(host)` so Node/Express matches Web-Standard behavior. Keep `warnIfUnprotected(host, !!allowedHosts)` immediately after.                                                                                                                                                                                                                      |           |      |
| TASK-002 | In [src/lib/validation.ts](src/lib/validation.ts) `resolveAllowedHosts`, extend the branch for non-loopback, non-broad binds to also return a single-host allow-list (already does) AND surface a caller-visible marker so `warnIfUnprotected` can distinguish “explicit env” from “auto-derived single host”. Simplest form: add an exported `isAutoDerivedAllowedHosts(bindHost)` predicate and use it in `warnIfUnprotected` to widen the warning to LAN binds. |           |      |
| TASK-003 | Update `warnIfUnprotected` in [src/transport.ts](src/transport.ts) to also log a warn-level message when `bindHost` is neither `localhost`/`127.0.0.1`/`::1` nor in `BROAD_BIND_ADDRESSES` and `MCP_ALLOWED_HOSTS` is unset. Message format MUST reference `MCP_ALLOWED_HOSTS` explicitly.                                                                                                                                                                         |           |      |
| TASK-004 | Verify Node/Express host enforcement: confirm `createMcpExpressApp({ host, allowedHosts })` rejects mismatched `Host` headers with 403 on the Node path. If `createMcpExpressApp` does not honor `allowedHosts` when `resolveAllowedHosts` returns the auto-derived list, add explicit middleware that calls `validateHostHeader` before `/mcp` — symmetric to the Web-Standard path.                                                                              |           |      |

### Implementation Phase 2

- GOAL-002: Harden CORS handling and reject unsafe combinations at config time.

| Task     | Description                                                                                                                                                                                                                                        | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-005 | In [src/transport.ts](src/transport.ts) `applyCorsHeaders` and `applyCors`, add `Vary: Origin` whenever `corsOrigin` is a non-empty, non-`*` value. Use header append semantics so an existing `Vary` is preserved.                                |           |      |
| TASK-006 | In [src/config.ts](src/config.ts) `getTransportConfig`, after computing `corsOrigin` and `isStateless`, throw when `corsOrigin === '*'` and `isStateless === false`. Error message MUST name both env vars: `MCP_CORS_ORIGIN` and `MCP_STATELESS`. |           |      |
| TASK-007 | Confirm `Access-Control-Allow-Credentials` is not emitted (it is not today). Add an explicit comment in `applyCorsHeaders` stating credentials mode is unsupported by this server and MUST NOT be enabled without stateful-session review.         |           |      |

### Implementation Phase 3

- GOAL-003: Replace the scheme-prefix resource notification allow-list with an exact registered-URI set, and make `registerResources`' `sessionStore` required.

| Task     | Description                                                                                                                                                                                                                                                                    | Completed | Date                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --- | --- |
| TASK-008 | In [src/server.ts](src/server.ts), replace `ALLOWED_URI_SCHEMES` + `isAllowedResourceUri` with `isKnownResourceUri(uri)` that matches against (a) every exact URI in `PUBLIC_RESOURCE_URIS` and the concrete ones (`memory://sessions`, `memory://caches`, `discover://catalog | workflows | context`, `memory://workspace/context | cache`), and (b) URIs produced by `sessionDetailUri`, `sessionTranscriptUri`, `sessionEventsUri`, `cacheDetailUri`. |     |     |
| TASK-009 | Preserve existing log-and-drop behavior when a URI is not recognized; update the warn message to `Blocked resource notification with unregistered URI: <uri>`.                                                                                                                 |           |                                       |
| TASK-010 | In [src/resources.ts](src/resources.ts) `registerResources`, change the signature so `sessionStore: SessionStore` is required (drop the `createSessionStore()` default). Keep `rootsFetcher` defaulted to `buildServerRootsFetcher(server)`.                                   |           |                                       |
| TASK-011 | Audit all call sites of `registerResources`. The only production call in [src/server.ts](src/server.ts) already passes `sessionStore`. Update any test that relies on the default to pass an explicit store.                                                                   |           |                                       |

### Implementation Phase 4

- GOAL-004: Pin the above invariants with tests and verify stdio diagnostic safety.

| Task     | Description                                                                                                                                                                                                                                                                      | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-012 | Add `__tests__/transport-host-validation.test.ts` covering the matrix `{ bind: 127.0.0.1, 0.0.0.0, 192.0.2.1 } × { env: set, unset } × { transport: node, web-standard }` against `resolveAllowedHosts` + `validateHostHeader`. Both transports MUST produce equivalent rulings. |           |      |
| TASK-013 | Extend [**tests**/transport.test.ts](__tests__/transport.test.ts) (or add a focused file) to assert: `OPTIONS /mcp` returns 204 with required `Access-Control-*` headers and `Vary: Origin` when `corsOrigin` is set and non-wildcard; no `Vary` when `corsOrigin` is empty.     |           |      |
| TASK-014 | Add a config test that asserts `getTransportConfig()` throws when `MCP_CORS_ORIGIN=*` and `MCP_STATELESS=false`, and succeeds when `MCP_STATELESS=true`.                                                                                                                         |           |      |
| TASK-015 | Add a server-level test that drives `sendResourceChangedForServer` (or the exported handler equivalents) with a URI that is not in the registered set and asserts no outbound `notifications/resources/updated` is emitted, and a warn log is produced.                          |           |      |
| TASK-016 | Add a stdio-diagnostic test that spawns the server in stdio mode (reuse `__tests__/transport-stdio.test.ts` scaffolding) and asserts `process.stdout` receives only JSON-RPC framing, no free-form log lines. Capture by wrapping stdout write in a spy.                         |           |      |
| TASK-017 | Add a unit test that calls `installTaskSafeToolCallHandler(server)` twice and asserts the `tools/call` handler is installed exactly once (idempotency guard in [src/lib/task-utils.ts](src/lib/task-utils.ts)).                                                                  |           |      |

## 3. Alternatives

- **ALT-001**: Move Host validation entirely into `createMcpExpressApp` config and drop the middleware path. Rejected: the Web-Standard transport does not use that factory; keeping a shared helper (`validateHostHeader`) avoids divergence.
- **ALT-002**: Introduce a `cors` npm package. Rejected: current needs are covered by a small, auditable helper; adding a dep for one header (`Vary: Origin`) is not justified.
- **ALT-003**: Rewrite the resource notification layer around a typed `ResourceUri` nominal type. Rejected: out of scope; exact-match allow-list achieves the same safety with a ~10 line change.
- **ALT-004**: Remove `installTaskSafeToolCallHandler` entirely by catching upstream. Rejected: blocked on SDK behavior (see §7 RISK-002).

## 4. Dependencies

- **DEP-001**: `@modelcontextprotocol/server@2.0.0-alpha.2` (no upgrade required).
- **DEP-002**: `@modelcontextprotocol/express@2.0.0-alpha.2` — behavior of `allowedHosts` option must be verified before TASK-004.
- **DEP-003**: `@modelcontextprotocol/node@2.0.0-alpha.2` (no change).
- **DEP-004**: Existing helpers: `resolveAllowedHosts`, `validateHostHeader`, `parseAllowedHosts`, `warnIfUnprotected`, `applyCors`, `applyCorsHeaders`, `withCors`, `sendResourceChangedForServer`, `isAllowedResourceUri`.

## 5. Files

- **FILE-001**: [src/transport.ts](src/transport.ts) — host resolution alignment (TASK-001), warn broadening (TASK-003), CORS `Vary: Origin` + comment (TASK-005, TASK-007), optional explicit Host middleware (TASK-004).
- **FILE-002**: [src/lib/validation.ts](src/lib/validation.ts) — new `isAutoDerivedAllowedHosts` (TASK-002).
- **FILE-003**: [src/config.ts](src/config.ts) — reject `MCP_CORS_ORIGIN=*` with stateful mode (TASK-006).
- **FILE-004**: [src/server.ts](src/server.ts) — exact-match resource URI allow-list (TASK-008, TASK-009).
- **FILE-005**: [src/resources.ts](src/resources.ts) — make `sessionStore` required (TASK-010).
- **FILE-006**: `__tests__/transport-host-validation.test.ts` (new) — TASK-012.
- **FILE-007**: [**tests**/transport.test.ts](__tests__/transport.test.ts) — CORS/Vary assertions (TASK-013).
- **FILE-008**: [**tests**/config.test.ts](__tests__/config.test.ts) — wildcard-origin rejection (TASK-014).
- **FILE-009**: `__tests__/resource-notifications.test.ts` (new) or extend existing resource tests — TASK-015.
- **FILE-010**: [**tests**/transport-stdio.test.ts](__tests__/transport-stdio.test.ts) — stdout purity assertion (TASK-016).
- **FILE-011**: `__tests__/lib/task-utils.test.ts` (new) or existing `__tests__/lib/orchestration.test.ts` — idempotency (TASK-017).

## 6. Testing

- **TEST-001**: Host matrix across both transports (TASK-012). Given equal bind + env, both transports return identical `allowedHosts`.
- **TEST-002**: `OPTIONS /mcp` returns 204 with `Access-Control-Allow-Origin: <origin>` and `Vary: Origin` when origin is non-wildcard; `Vary` absent when `corsOrigin === ''` (TASK-013).
- **TEST-003**: `getTransportConfig` throws when `MCP_CORS_ORIGIN=*` and `MCP_STATELESS=false`; succeeds for `MCP_STATELESS=true` (TASK-014).
- **TEST-004**: Unregistered resource URI passed to `sendResourceChangedForServer` produces no outbound notification and one warn log (TASK-015).
- **TEST-005**: stdio mode writes only JSON-RPC framed messages to `process.stdout` across a full initialize → tools/list → shutdown sequence (TASK-016).
- **TEST-006**: `installTaskSafeToolCallHandler` is idempotent across repeated calls on the same `McpServer` (TASK-017).
- **TEST-007**: Existing `npm run test` suite remains green after all phases.

## 7. Risks & Assumptions

- **RISK-001**: `createMcpExpressApp`'s handling of `allowedHosts` may differ from the Web-Standard transport. TASK-004 mitigates by adding an explicit middleware fallback if upstream behavior is partial.
- **RISK-002**: The SDK-internal shim in [src/lib/task-utils.ts](src/lib/task-utils.ts) (`InternalMcpServer` cast) is fragile across alpha bumps. This plan does not modify the shim but pins its idempotency (TEST-006).
- **RISK-003**: Tightening resource URI allow-list could drop legitimate notifications if a future template URI is added and not registered. Mitigation: derive the set from `PUBLIC_RESOURCE_URIS` + URI helpers in [src/lib/resource-uris.ts](src/lib/resource-uris.ts) so additions stay centralized.
- **RISK-004**: Rejecting `MCP_CORS_ORIGIN=*` with stateful mode is a breaking config change for any deployment relying on the previous permissive combination. Mitigation: document in README and surface a clear error message.
- **ASSUMPTION-001**: Production deployments already set `MCP_ALLOWED_HOSTS` explicitly for non-loopback binds; the broadened warning is informational, not blocking.
- **ASSUMPTION-002**: No consumer imports `registerResources` with a single argument; the only production call in [src/server.ts](src/server.ts) passes `sessionStore`.
- **ASSUMPTION-003**: SDK v2 `McpServer.server.sendResourceUpdated` silently ignores unknown URIs today; we still drop them client-side to prevent misuse.

## 8. Related Specifications / Further Reading

- [.github/mcp-v2-api.md](.github/mcp-v2-api.md) — MCP TypeScript SDK v2 API reference used for this review.
- [.github/patterns.md](.github/patterns.md) — repo implementation patterns for tools, resources, prompts, tasks.
- [docs/plan/bug-transport-webstandard-cors-1.md](docs/plan/bug-transport-webstandard-cors-1.md) — prior Web-Standard CORS work; this plan continues the alignment.
- [docs/plan/bug-observability-contract-1.md](docs/plan/bug-observability-contract-1.md) — prior observability contract work; TEST-005 complements its stdio guarantees.
- [docs/plan/feature-task-contract-hardening-1.md](docs/plan/feature-task-contract-hardening-1.md) — context for the `installTaskSafeToolCallHandler` shim (RISK-002).
